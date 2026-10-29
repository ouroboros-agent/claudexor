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
  facts: () => RunExecutionFacts,
): { held: HeldSession | null; source: string | null } {
  const ofAttempt = (id: string | null | undefined) =>
    sessions.find((entry) => entry.attemptId === id) ?? null;
  if (resumable) {
    const id = resumable.session?.nativeSessionId;
    const named = sessions.filter((entry) => entry.capsule.nativeSessionId === id);
    const started = (entry: HeldSession) =>
      facts().accepted.some(
        (start) => start.attemptId === entry.attemptId && start.nativeSessionId === id,
      );
    const held = (named.length > 1 ? named.find(started) : undefined) ?? named[0] ?? null;
    return { held, source: held?.attemptId ?? null };
  }
  const final = telemetry?.final_attempt_id;
  if (final) return { held: ofAttempt(final), source: final };
  const carrier = carryingAttempt(facts());
  if (carrier) return { held: ofAttempt(carrier), source: carrier };
  const seeded = facts().receipts.find(
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

/** The carrying session alone (status projections): the run's event log is read
 * only when its terminal records leave the choice to the recorded facts and the
 * caller holds no snapshot of it. */
export function continuationCarrier(
  runDir: string,
  events?: readonly RunEvent[],
): HeldSession | null {
  const sessions = sessionCapsules(runDir);
  if (sessions.length === 0) return null;
  const { resumable, telemetry } = terminalRecords(runDir);
  let facts: RunExecutionFacts | undefined;
  return selectCarrier(resumable, telemetry, sessions, () => {
    facts ??= runExecutionFacts(events ?? readRunEvents(join(runDir, "events.jsonl")).events);
    return facts;
  }).held;
}

export function readContinuationEvidence(runDir: string) {
  const finalDir = join(runDir, "final");
  const attemptsDir = join(runDir, "attempts");
  const { resumable, telemetry } = terminalRecords(runDir);
  const sessions = sessionCapsules(runDir);
  const events = readRunEvents(join(runDir, "events.jsonl"));
  const facts = runExecutionFacts(events.events);
  const selected = selectCarrier(resumable, telemetry, sessions, () => facts);
  const { held } = selected;
  const sessionMemory = held
    ? recordedSessionMemory(
        facts,
        { attemptId: held.attemptId, nativeSessionId: held.capsule.nativeSessionId },
        readContinuationSources(runDir).length > 0,
      )
    : null;
  const attemptId = selected.source ?? carryingAttempt(facts) ?? "a01";
  const attempt = telemetry?.attempts.find((entry) => entry.attempt_id === attemptId);
  const patch =
    readTextSafe(join(attemptsDir, attemptId, "patch.diff")) ??
    readTextSafe(join(finalDir, "patch.diff")) ??
    "";
  // The final answer speaks for the run; the distinct output of every other
  // attempt stays beside it as evidence, each once under its own attempt.
  const answer = readTextSafe(join(finalDir, "answer.md"))?.trim();
  const winner = telemetry?.final_attempt_id ?? null;
  const others = winner ? facts.attempts.filter((id) => id !== winner) : [];
  const othersOutput = others.length
    ? retainedOutput(
        events.events.filter(
          (event) =>
            event.type === "harness.event" && others.includes(String(event.payload["attempt_id"])),
        ),
      )
    : null;
  const output = answer
    ? othersOutput
      ? `Final answer (final/answer.md, attempt ${winner}):\n\n${answer}\n\n${othersOutput.trim()}`
      : answer
    : readTextSafe(join(finalDir, "retained-output.md"))?.trim() ||
      retainedOutput(events.events, events.malformed) ||
      "";
  const hasEvidence =
    !!patch.trim() ||
    !!output ||
    events.events.some(
      (event) =>
        event.type === "harness.event" &&
        ["tool_call", "file_change"].includes(String(event.payload["type"])),
    );
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
