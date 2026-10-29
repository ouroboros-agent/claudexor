/** Shared evidence facts for admission and the successor's carrier planner. */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { RunResumable, RunTelemetry, SessionCapsule, type RunEvent } from "@claudexor/schema";
import { readRunEvents, retainedOutput } from "@claudexor/event-log";
import { readTextSafe } from "@claudexor/util";
import {
  carryingAttempt,
  recordedSessionMemory,
  runExecutionFacts,
  uncoveredAttempts,
  type RunExecutionFacts,
} from "./continuation-facts.js";
import { readContinuationSources } from "./continuation-sources.js";

export function runFilesExpired(runDir: string): boolean {
  try {
    lstatSync(join(runDir, "tombstone.yaml"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function readSessionCapsule(attemptDir: string): SessionCapsule | null {
  try {
    const text = readTextSafe(join(attemptDir, "session-capsule.json"));
    return text === null ? null : SessionCapsule.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function yaml(path: string): unknown {
  const text = readTextSafe(path);
  if (text === null) return null;
  try {
    return yamlParse(text);
  } catch {
    return null;
  }
}

interface HeldSession {
  attemptId: string;
  capsule: SessionCapsule;
}

function sessionCapsules(runDir: string): HeldSession[] {
  const attemptsDir = join(runDir, "attempts");
  return existsSync(attemptsDir)
    ? readdirSync(attemptsDir).flatMap((attemptId) => {
        const capsule = readSessionCapsule(join(attemptsDir, attemptId));
        return capsule ? [{ attemptId, capsule }] : [];
      })
    : [];
}

/**
 * The session that carries a run's work and the attempt that speaks for it,
 * by one rule for every reader. The run's declared terminal source decides,
 * serial or concurrent: its `resumable` block's session (none when the block
 * names none), else the completed run's final attempt. Only a run without
 * either (a host restart, an old run) falls back to its recorded execution
 * facts: the carrying attempt; without any start, the seeded native first try
 * or the run's only capsule. Never mtime or directory order.
 */
function selectCarrier(
  resumable: RunResumable | undefined,
  telemetry: RunTelemetry | undefined,
  sessions: readonly HeldSession[],
  facts: RunExecutionFacts,
): { held: HeldSession | null; source: string | null } {
  const ofAttempt = (id: string | null | undefined) =>
    sessions.find((entry) => entry.attemptId === id) ?? null;
  if (resumable) {
    const id = resumable.session?.nativeSessionId;
    const named = sessions.filter((entry) => entry.capsule.nativeSessionId === id);
    const started = (entry: HeldSession) =>
      facts.accepted.some(
        (start) => start.attemptId === entry.attemptId && start.nativeSessionId === id,
      );
    const held = (named.length > 1 ? named.find(started) : undefined) ?? named[0] ?? null;
    return { held, source: held?.attemptId ?? null };
  }
  const final = telemetry?.final_attempt_id;
  if (final) return { held: ofAttempt(final), source: final };
  const carrier = carryingAttempt(facts);
  if (carrier) return { held: ofAttempt(carrier), source: carrier };
  const seeded = facts.receipts.find(
    ({ receipt }) => receipt.tryIndex === 0 && receipt.carrier.startsWith("native"),
  );
  const held = ofAttempt(seeded?.attemptId) ?? (sessions.length === 1 ? sessions[0]! : null);
  return { held, source: held?.attemptId ?? null };
}

function terminalRecords(runDir: string) {
  const finalDir = join(runDir, "final");
  return {
    resumable: RunResumable.safeParse(yaml(join(finalDir, "resumable.yaml"))).data,
    telemetry: RunTelemetry.safeParse(yaml(join(finalDir, "telemetry.yaml"))).data,
  };
}

/**
 * Recorded assistant output that what a run carries forward does not
 * represent, each block once under its attempt and native try (its process
 * session): everything but the represented try, the last accepted try of
 * `representedAttempt` whose answer or report is carried, and any block the
 * carried text already contains. Read from events the caller already holds.
 */
export function unrepresentedOutput(
  events: readonly RunEvent[],
  facts: RunExecutionFacts,
  representedAttempt: string | null,
  carried: string,
): string | null {
  const represented = facts.accepted
    .filter((start) => start.attemptId === representedAttempt)
    .at(-1)?.sessionId;
  const kept = events.filter(
    (event) =>
      event.type === "harness.event" &&
      !(
        represented !== undefined &&
        event.payload["attempt_id"] === representedAttempt &&
        event.payload["session_id"] === represented
      ),
  );
  return retainedOutput(kept, 0, false, carried)?.trim() || null;
}

/**
 * Whether a run is its own continuation source: it declared a terminal block,
 * holds a carrying session or recorded its own work. The successor's planner
 * and the status projection stop their walk up a chain at the first such run;
 * only a run with none of these defers to its ancestors.
 */
export function ownsContinuationSource(evidence: {
  resumable: RunResumable | undefined;
  held: HeldSession | null;
  hasEvidence: boolean;
}): boolean {
  return evidence.resumable !== undefined || evidence.held !== null || evidence.hasEvidence;
}

/**
 * What decides a run's continuation source, from its terminal records,
 * capsules and final files plus its recorded execution facts: the carrying
 * session, the attempt that speaks for the run, and whether the run recorded
 * work of its own (a patch, a final or retained output, or work in its events).
 */
function sourceFactsOf(runDir: string, facts: RunExecutionFacts) {
  const finalDir = join(runDir, "final");
  const { resumable, telemetry } = terminalRecords(runDir);
  const { held, source } = selectCarrier(resumable, telemetry, sessionCapsules(runDir), facts);
  const attemptId = source ?? carryingAttempt(facts) ?? "a01";
  const patch =
    readTextSafe(join(runDir, "attempts", attemptId, "patch.diff")) ??
    readTextSafe(join(finalDir, "patch.diff")) ??
    "";
  const answer = readTextSafe(join(finalDir, "answer.md"))?.trim() ?? "";
  const retained = readTextSafe(join(finalDir, "retained-output.md"))?.trim() ?? "";
  const hasEvidence = !!patch.trim() || !!answer || !!retained || facts.recordedWork;
  return { resumable, telemetry, held, attemptId, patch, answer, retained, hasEvidence };
}

/**
 * The source a status projection names, by the planner's own rule: the
 * carrying session and whether the run is its own source. `facts` are the
 * run's execution facts when the caller already folded them (run detail);
 * otherwise its log is read once.
 */
export function continuationSource(
  runDir: string,
  facts?: RunExecutionFacts,
): { held: HeldSession | null; owns: boolean } {
  const recorded = facts ?? runExecutionFacts(readRunEvents(join(runDir, "events.jsonl")).events);
  const source = sourceFactsOf(runDir, recorded);
  return { held: source.held, owns: ownsContinuationSource(source) };
}

export function readContinuationEvidence(runDir: string) {
  const events = readRunEvents(join(runDir, "events.jsonl"));
  const facts = runExecutionFacts(events.events);
  const { resumable, telemetry, held, attemptId, patch, answer, retained, hasEvidence } =
    sourceFactsOf(runDir, facts);
  const sessionMemory = held
    ? recordedSessionMemory(
        facts,
        { attemptId: held.attemptId, nativeSessionId: held.capsule.nativeSessionId },
        readContinuationSources(runDir).length > 0,
      )
    : null;
  const attempt = telemetry?.attempts.find((entry) => entry.attempt_id === attemptId);
  // The final answer speaks for the run; the recorded output it does not
  // represent (other attempts, the winner's earlier native tries) stays beside
  // it as evidence, once under its attempt and try.
  const winner = telemetry?.final_attempt_id ?? null;
  const unrepresented = answer ? unrepresentedOutput(events.events, facts, winner, answer) : null;
  const output = answer
    ? unrepresented
      ? `Final answer (final/answer.md${winner ? `, attempt ${winner}` : ""}):\n\n${answer}\n\n${unrepresented}`
      : answer
    : retained || retainedOutput(events.events, events.malformed) || "";
  return {
    resumable,
    held,
    sessionMemory,
    attemptId,
    // Every attempt with recorded events, each its own attributed evidence.
    attempts: facts.attempts.length > 0 ? facts.attempts : [attemptId],
    // The attempts whose work the held session never received.
    uncovered: held ? uncoveredAttempts(facts, held.attemptId) : [],
    attempt,
    patch,
    output,
    hasEvidence,
  };
}
