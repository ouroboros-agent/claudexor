import type { FoldRecord, FoldVerdict } from "@claudexor/journal";
import { journalFoldPolicy } from "../journal-fold-policy.js";
import type { EngineStore } from "./store.js";

export interface EventInput {
  type: string;
  payload: unknown;
  time?: string;
  /** Bare hex digest when the payload body lives in `blob` (collection reads never select it). */
  payloadSha?: string | null;
}

export interface AppendedEvent {
  seq: number;
  verdict: FoldVerdict;
  /** False when the verdict dropped the record (the sequence number is still consumed). */
  stored: boolean;
}

/**
 * Append one `event` row under the journal fold's verdict (SYNTHESIS_R5 §6.6),
 * inside the caller's transaction. `retire` deletes every retained row under
 * the named slot/group keys; `slot` deletes the previous holder; `drop` skips
 * the insert. Sequence numbers come from `partition.next_seq` and are consumed
 * even for dropped records, exactly like a frame the fold forgets on disk.
 */
export function appendEvent(
  store: EngineStore,
  pid: number,
  input: EventInput,
  verdictOf: (record: FoldRecord) => FoldVerdict = journalFoldPolicy.verdict,
): AppendedEvent {
  if (!store.inTransaction) throw new Error("events are appended inside the owner's transaction");
  const current = store.prepare("SELECT next_seq FROM partition WHERE id = ?").get(pid) as
    { next_seq: number | bigint } | undefined;
  if (!current) throw new Error(`no partition generation ${pid}`);
  const seq = Number(current.next_seq);
  const time = input.time ?? store.now().toISOString();
  const bytes = Buffer.from(JSON.stringify(input.payload ?? null));
  const verdict =
    verdictOf({
      seq,
      type: input.type,
      time,
      payload: input.payload,
      byteLength: bytes.byteLength,
    }) ?? {};
  const retire = store.prepare(
    "DELETE FROM event WHERE pid = ? AND (slot_key = ? OR group_key = ?)",
  );
  for (const name of verdict.retire ?? []) retire.run(pid, name, name);
  if (verdict.slot !== undefined) {
    store.prepare("DELETE FROM event WHERE pid = ? AND slot_key = ?").run(pid, verdict.slot);
  }
  if (!verdict.drop) {
    store
      .prepare(
        "INSERT INTO event(pid, seq, time, type, payload, payload_sha, slot_key, group_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        pid,
        seq,
        time,
        input.type,
        bytes,
        input.payloadSha ?? null,
        verdict.slot ?? null,
        verdict.group ?? null,
      );
  }
  store.prepare("UPDATE partition SET next_seq = ? WHERE id = ?").run(seq + 1, pid);
  return { seq, verdict, stored: !verdict.drop };
}

/** Terminal product commands of the current generation (the `terminal` predicate of
 * `prunableCommandIds`, as the partial index `command_retention` states it). */
export const COMMAND_RETENTION_COUNT_SQL = `SELECT count(*) AS n FROM command INDEXED BY command_retention
  WHERE pid = ?1 AND retention_exempt = 0 AND finished_at IS NOT NULL`;

/**
 * Bounded prune candidates (SYNTHESIS_R5 §6.6): current generation only, oldest
 * first, finished at least the retention window ago, never a needs-decision
 * run, never a continuation whose predecessor is still retained (today's
 * `continuationExemptions`: `continueFrom` names a run id or a job id).
 */
export const COMMAND_RETENTION_CANDIDATES_SQL = `SELECT c.id AS id, c.run_id AS run_id
  FROM command AS c INDEXED BY command_retention
  WHERE c.pid = ?1 AND c.retention_exempt = 0 AND c.finished_at IS NOT NULL
    AND c.finished_at <= ?2 AND c.needs_decision = 0
    AND NOT (c.continue_from IS NOT NULL AND EXISTS (
      SELECT 1 FROM command AS p WHERE p.id = c.continue_from OR p.run_id = c.continue_from))
  ORDER BY c.created_at, c.id
  LIMIT ?3`;

export const COMMAND_RETENTION_CAP = 500;
export const COMMAND_RETENTION_BATCH = 100;

export interface CommandRetentionInput {
  pid: number;
  now: Date;
  retentionMs: number;
  cap?: number;
  batch?: number;
}

export interface CommandRetentionCandidate {
  id: string;
  runId: string | null;
}

export function terminalCommandCount(store: EngineStore, pid: number): number {
  const row = store.prepare(COMMAND_RETENTION_COUNT_SQL).get(pid) as { n: number | bigint };
  return Number(row.n);
}

/** `excess = max(0, terminalCount − cap)` candidates, at most one batch per call. */
export function commandRetentionCandidates(
  store: EngineStore,
  input: CommandRetentionInput,
): CommandRetentionCandidate[] {
  const excess = terminalCommandCount(store, input.pid) - (input.cap ?? COMMAND_RETENTION_CAP);
  if (excess <= 0) return [];
  const limit = Math.min(excess, input.batch ?? COMMAND_RETENTION_BATCH);
  const cutoff = new Date(input.now.getTime() - input.retentionMs).toISOString();
  return (
    store.prepare(COMMAND_RETENTION_CANDIDATES_SQL).all(input.pid, cutoff, limit) as Array<{
      id: string;
      run_id: string | null;
    }>
  ).map((row) => ({ id: row.id, runId: row.run_id }));
}

/** `EXPLAIN QUERY PLAN` rows for a statement (plan gates, SYNTHESIS_R5 §5). */
export function queryPlan(store: EngineStore, sql: string): string[] {
  return (store.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
    (row) => row.detail,
  );
}
