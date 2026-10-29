/**
 * Recorded execution facts of one run's event log, shared by every
 * continuation reader: which harness starts were accepted (not refused by a
 * mismatched identity handshake), which continued try's receipt belongs to
 * which start, which attempt carries the latest work and how complete a
 * native session's history is. A start and its receipt are joined on the
 * attempt, the process session id and event order, never on the vendor's
 * native id alone or on a later start. Directory names and capsule mtimes
 * are not execution facts.
 */
import { RunContinuityReceipt, type RunEvent } from "@claudexor/schema";

export interface RecordedStart {
  index: number;
  attemptId: string;
  sessionId: string | null;
  nativeSessionId: string | null;
}

export interface RecordedReceipt {
  index: number;
  attemptId: string;
  sessionId: string | null;
  receipt: RunContinuityReceipt;
}

export interface RunExecutionFacts {
  /** Attempts with harness events, in first-event order. */
  attempts: string[];
  /** Attempts that recorded agent progress (a tool call or result, an edit, reasoning
   * text) or a typed final answer. */
  progressed: Set<string>;
  /** Starts not refused by their own identity handshake, in event order. */
  accepted: RecordedStart[];
  receipts: RecordedReceipt[];
  /** The receipt the continued try of this start settled with, when any. */
  receiptOf(start: RecordedStart): RecordedReceipt | null;
}

const TOOL_PROGRESS = new Set(["tool_call", "tool_result", "file_change", "patch_produced"]);

export function runExecutionFacts(events: readonly RunEvent[]): RunExecutionFacts {
  const attempts: string[] = [];
  const progressed = new Set<string>();
  const starts: RecordedStart[] = [];
  const receipts: RecordedReceipt[] = [];
  events.forEach((event, index) => {
    const payload = event.payload;
    const attemptId = typeof payload["attempt_id"] === "string" ? payload["attempt_id"] : null;
    const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : null;
    if (attemptId === null) return;
    if (event.type === "run.continuity") {
      const receipt = RunContinuityReceipt.safeParse(payload["receipt"]).data;
      if (receipt) receipts.push({ index, attemptId, sessionId, receipt });
      return;
    }
    if (event.type !== "harness.event") return;
    if (!attempts.includes(attemptId)) attempts.push(attemptId);
    // The controller's own "acted" facts: agent progress or a typed final answer
    // (a crashed try's narration is evidence, not progress).
    const type = String(payload["type"]);
    const text = typeof payload["text"] === "string" ? payload["text"].trim() : "";
    if (
      TOOL_PROGRESS.has(type) ||
      (type === "thinking" && text) ||
      (type === "message" && text && payload["final"] === true)
    )
      progressed.add(attemptId);
    if (type !== "started") return;
    const nested = payload["payload"] as Record<string, unknown> | null | undefined;
    const native = nested?.["native_session_id"];
    starts.push({
      index,
      attemptId,
      sessionId,
      nativeSessionId: typeof native === "string" && native ? native : null,
    });
  });
  const receiptOf = (start: RecordedStart): RecordedReceipt | null =>
    start.sessionId === null
      ? null
      : (receipts.find(
          (entry) =>
            entry.index > start.index &&
            entry.attemptId === start.attemptId &&
            entry.sessionId === start.sessionId,
        ) ?? null);
  const accepted = starts.filter(
    (start) => !receiptOf(start)?.receipt.identityCheck.startsWith("mismatch"),
  );
  return { attempts, progressed, accepted, receipts, receiptOf };
}

/**
 * Attempts of the run whose recorded work the held session never received:
 * every attempt but its own, except those a packet of this run briefed it
 * with. Only a successor's attempt is so briefed (its first try's receipt is
 * a packet), and a successor runs a single candidate whose attempts follow one
 * another (admission), so every attempt recorded before it was in that packet.
 * Event timing never decides lineage: another candidate of a concurrent run
 * stays uncovered, separate evidence.
 */
export function uncoveredAttempts(facts: RunExecutionFacts, heldAttemptId: string): string[] {
  const at = facts.attempts.indexOf(heldAttemptId);
  if (at < 0) return [];
  const briefed = facts.receipts.some(
    ({ attemptId, receipt }) =>
      attemptId === heldAttemptId && receipt.tryIndex === 0 && receipt.carrier === "packet",
  );
  return facts.attempts.filter((_, i) => i !== at && !(briefed && i < at));
}

/**
 * The attempt whose session carries the run's latest work: the newest accepted
 * start of an attempt that made progress, else the newest accepted start. A
 * later attempt that never started, or started and did nothing, cannot evict it.
 */
export function carryingAttempt(facts: RunExecutionFacts): string | null {
  const started = facts.accepted.map((start) => start.attemptId);
  return started.findLast((id) => facts.progressed.has(id)) ?? started.at(-1) ?? null;
}

/** A continued try that started was handed its notice and caller text. */
export function continuedTryStarted(facts: RunExecutionFacts, firstTryOnly = false): boolean {
  return facts.accepted.some((start) => {
    const settled = facts.receiptOf(start)?.receipt;
    return settled !== undefined && (!firstTryOnly || settled.tryIndex === 0);
  });
}

/**
 * History quality of the native session `held` names, from this run's
 * records: the receipt of the try that first started it (packet-born is
 * partial; a native resume keeps that receipt's memory), the receipt of a
 * seeded native first try that never started, or full for the first
 * attempt's own session of a run that continues nothing. Anything else is
 * unknown, never a guessed full or partial.
 */
export function recordedSessionMemory(
  facts: RunExecutionFacts,
  held: { attemptId: string; nativeSessionId: string },
  continuesEarlierRun: boolean,
): RunContinuityReceipt["memory"] {
  const born = facts.accepted.find((start) => start.nativeSessionId === held.nativeSessionId);
  const receipt = born
    ? facts.receiptOf(born)?.receipt
    : facts.receipts.find(
        (entry) =>
          entry.attemptId === held.attemptId &&
          entry.receipt.tryIndex === 0 &&
          (entry.receipt.carrier === "native" || entry.receipt.carrier === "native_moved"),
      )?.receipt;
  if (receipt) return receipt.carrier === "packet" ? "partial" : receipt.memory;
  return born && !continuesEarlierRun && born.attemptId === facts.attempts[0] ? "full" : "unknown";
}
