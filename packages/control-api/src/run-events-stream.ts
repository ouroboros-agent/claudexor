import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import type {
  EventReplayCursor,
  EventReplayRequest,
  EventReplayResult,
} from "./event-replay-batch.js";
import { thrownProblemCode } from "./problem-response.js";
import { requestGone } from "./request-liveness.js";

export interface StreamEventsCtx {
  findRun(id: string): Promise<DaemonRunRecord | null | undefined>;
  json(res: ServerResponse, status: number, value: unknown): void;
  readBatch(request: EventReplayRequest, signal: AbortSignal): Promise<EventReplayResult>;
  opts: {
    daemon: { status(id: string): Promise<DaemonRunRecord> };
    bus?: { subscribe(fn: (event: { run_id?: string }) => void): () => void } | undefined;
    pollMs?: number;
    heartbeatMs?: number;
    /** SQL composition supplies the existing terminal-files obligation fact. */
    terminalFilesPending?: (runIdOrCommandId: string) => boolean;
  };
  sseClients: Set<ServerResponse>;
}

/**
 * GET /runs/:id/events — replay + live tail of the run's events.jsonl as SSE
 * (snapshot-then-subscribe with durable seq cursors, drain-await
 * backpressure, and a single re-entrancy flag across the queued-phase
 * status await). Live stream ownership stays here; finite file/read/redact
 * batches run on the server's shared bulk executor.
 */
export async function streamRunEvents(
  ctx: StreamEventsCtx,
  id: string,
  lastEventId: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rec = await ctx.findRun(id);
  if (!rec) return ctx.json(res, 404, { error: "no such run" });
  // A QUEUED job has no runDir yet — that is a wait, not a 404:
  // the stream opens with heartbeats and binds the events file once the
  // run starts, so `follow <jobId>` works from enqueue time. 404 stays for
  // truly unknown ids only.
  let eventsPath = rec.runDir ? join(rec.runDir, "events.jsonl") : null;
  let cursor: EventReplayCursor | undefined;
  let closed = false;
  let terminalSeen = false;
  const lifetime = new AbortController();
  const pendingTerminalFiles = () => ctx.opts.terminalFilesPending?.(rec.runId ?? rec.id) === true;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    clearInterval(timer);
    clearInterval(heartbeat);
    unsubscribe?.();
    ctx.sseClients.delete(res);
  };
  req.on("close", () => {
    if (requestGone(req, res)) cleanup();
  });
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  const readBatch = () =>
    ctx.readBatch({ path: eventsPath!, lastEventId, cursor }, lifetime.signal);
  // A first-job failure can still return the executor's typed HTTP problem.
  let nextBatch = eventsPath ? await readBatch() : undefined;
  if (closed || res.writableEnded || res.destroyed) return cleanup();
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  ctx.sseClients.add(res);
  // Heartbeat: a quiet harness phase (long tool call, slow model) must not be
  // indistinguishable from a dead connection — clients and proxies need bytes.
  heartbeat = setInterval(() => {
    if (!closed) res.write(`: ping ${Date.now()}\n\n`);
  }, ctx.opts.heartbeatMs ?? 15_000);
  heartbeat.unref?.();
  let draining = false;
  // Lost-wakeup latch (QA-018 / backlog C2): a bus push or poll tick that
  // arrives while a drain pass already holds `draining` must not be dropped as
  // a no-op — it records a pending re-check the drain loop honors before it
  // concludes. The durable file stays the single ordered source; this bit only
  // guarantees the tailer looks again.
  let pending = false;
  const writeAvailable = async () => {
    if (closed) return;
    if (draining) {
      pending = true;
      return;
    }
    // The re-entrancy guard must cover the QUEUED-phase status await too:
    // with drain-await backpressure in the replay loop, two triggers (poll
    // timer + bus push) passing this point concurrently could interleave
    // out-of-order seq writes. One flag spans the whole invocation.
    draining = true;
    try {
      // Drain-until-stable: re-read the file after every productive pass and
      // after any pending wakeup, so a terminal tail appended between a read and
      // the status probe is never left undelivered.
      for (;;) {
        pending = false;
        if (!eventsPath) {
          // Still queued: poll the job until the run binds its dir (then tail
          // it) or the job goes terminal without one (validation failure — a
          // run that never materialized ends the stream honestly).
          const latest = await ctx.opts.daemon.status(rec.id).catch(() => rec);
          if (closed || res.writableEnded || res.destroyed) return cleanup();
          if (latest.runDir) {
            eventsPath = join(latest.runDir, "events.jsonl");
          } else if (TERMINAL_STATES.has(latest.state) && !pendingTerminalFiles()) {
            res.write("event: end\ndata: {}\n\n");
            res.end();
            cleanup();
            return;
          } else {
            if (pending) continue;
            return;
          }
        }
        const batch = nextBatch ?? (await readBatch());
        nextBatch = undefined;
        if (closed || res.writableEnded || res.destroyed) return cleanup();
        if (batch.missing) {
          if (pending) continue;
          return;
        }
        cursor = batch.cursor;
        terminalSeen ||= batch.terminalSeen;
        for (const { seq, type, data, terminal } of batch.frames) {
          // Backpressure: a large replay into a slow client must not balloon
          // the socket buffer — pause the tail until the kernel drains it
          // (or the client goes away, which resolves via `close`).
          if (!res.write(`id: ${seq}\nevent: ${type}\ndata: ${data}\n\n`)) {
            await new Promise<void>((resolve) => {
              const done = (): void => {
                res.off("drain", done);
                res.off("close", done);
                resolve();
              };
              res.once("drain", done);
              res.once("close", done);
            });
            if (closed || res.writableEnded || res.destroyed) return cleanup();
          }
          if (terminal && !pendingTerminalFiles()) {
            res.write("event: end\ndata: {}\n\n");
            res.end();
            cleanup();
            return;
          }
        }
        // A productive pass may have surfaced only a PREFIX of the tail: loop to
        // re-read from the advanced cursor before deciding anything.
        if (batch.progressed) continue;
        const latest = await ctx.opts.daemon.status(rec.id).catch(() => rec);
        if (closed || res.writableEnded || res.destroyed) return cleanup();
        if ((terminalSeen || TERMINAL_STATES.has(latest.state)) && !pendingTerminalFiles()) {
          // A materialized run commits SQL terminal state with a file-publication
          // obligation. Its cleared obligation proves the canonical terminal is
          // readable after publication. Re-check the file
          // cursor: only conclude `end` when the file yields nothing new AND a
          // wakeup is not already pending — otherwise loop and deliver the tail,
          // whose canonical terminal ends the stream through the branch above.
          nextBatch = await readBatch();
          if (closed || res.writableEnded || res.destroyed) return cleanup();
          if (nextBatch.progressed || nextBatch.frames.length > 0 || pending) continue;
          res.write("event: end\ndata: {}\n\n");
          res.end();
          cleanup();
          return;
        }
        if (pending) continue;
        return;
      }
    } catch (error) {
      if (!closed && !res.writableEnded && !res.destroyed) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            code: thrownProblemCode(error),
            message: "Run event stream could not be read.",
            retryable: true,
            fieldErrors: [],
            requiredActions: ["reconnect"],
            evidenceRefs: [],
            context: {},
          })}\n\n`,
        );
        res.end();
      }
      cleanup();
    } finally {
      draining = false;
    }
  };
  // Push: a bus event for this run pokes the tailer immediately; the file
  // remains the single ordered source so push and poll can never disagree.
  unsubscribe = ctx.opts.bus?.subscribe((event) => {
    if (!closed && event.run_id === (rec.runId ?? rec.id)) void writeAvailable();
  });
  timer = setInterval(() => void writeAvailable(), ctx.opts.pollMs ?? 250);
  timer.unref?.();
  await writeAvailable();
}
