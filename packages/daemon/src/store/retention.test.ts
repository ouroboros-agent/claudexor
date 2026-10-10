import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journalFoldPolicy } from "../journal-fold-policy.js";
import { createPartition } from "./partitions.js";
import {
  COMMAND_RETENTION_CANDIDATES_SQL,
  COMMAND_RETENTION_COUNT_SQL,
  appendEvent,
  commandRetentionCandidates,
  queryPlan,
  terminalCommandCount,
} from "./retention.js";
import { EngineStore } from "./store.js";

function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
const journals: DurableJournal[] = [];
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-retention-")));
});
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  stores.push(store);
  return store;
}

/** A realistic record sequence spanning every verdict kind of the daemon fold policy. */
function recordSequence(): Array<{ type: string; payload: unknown }> {
  const run = (runId: string, type: string, extra: Record<string, unknown> = {}) => ({
    type: "run.event",
    payload: {
      run_id: runId,
      task_id: `task-${runId}`,
      type,
      ts: "2026-10-10T00:00:00.000Z",
      ...extra,
    },
  });
  const command = (id: string, type: "command.accepted" | "command.updated", state: string) => ({
    type,
    payload: {
      record: { id, state, createdAt: "t" },
      keyDigest: `k-${id}`,
      requestDigest: `r-${id}`,
    },
  });
  return [
    command("c1", "command.accepted", "queued"),
    command("c1", "command.updated", "running"),
    run("run-1", "run.created"),
    run("run-1", "output.ready"),
    { type: "interaction.requested", payload: { runId: "run-1", interactionId: "q1" } },
    { type: "interaction.resolved", payload: { runId: "run-1", interactionIds: ["q1"] } },
    run("run-1", "run.completed", { run_facts: { outcome: { lifecycle: "succeeded" } } }),
    command("c1", "command.updated", "succeeded"),
    { type: "thread.head.updated", payload: { thread_id: "thr-1", revision: 1 } },
    { type: "thread.head.updated", payload: { thread_id: "thr-1", revision: 2 } },
    { type: "quota.projection.updated", payload: { projection_signature: "a" } },
    { type: "quota.projection.updated", payload: { projection_signature: "b" } },
    { type: "setup.job.log", payload: { jobId: "job-1", line: "one" } },
    { type: "setup.job.log", payload: { jobId: "job-1", line: "two" } },
    { type: "setup.job.saved", payload: { job: { jobId: "job-1", state: "running" } } },
    { type: "setup.job.saved", payload: { job: { jobId: "job-1", state: "completed" } } },
    command("c2", "command.accepted", "queued"),
    run("run-2", "run.created"),
    run("run-2", "run.failed", { run_facts: { outcome: { lifecycle: "failed" } } }),
    command("c2", "command.updated", "failed"),
    { type: "command.pruned", payload: { ids: ["c1"], roots: ["/r"], run_ids: ["run-1"] } },
    { type: "unknown.type", payload: { kept: true } },
    { type: "command.pruned", payload: { ids: ["c2"], roots: ["/r"], run_ids: ["run-2"] } },
  ];
}

describe("event retention through the journal fold verdicts (SYNTHESIS_R5 §6.6)", () => {
  it("retains exactly the sequence numbers the folded journal retains", async () => {
    // Oracle: today's journal, replayed through the daemon fold.
    const options = {
      rootDir: join(root, "journal"),
      partition: "global",
      fold: journalFoldPolicy,
    };
    const writer = new DurableJournal(options);
    for (const record of recordSequence()) writer.append(record.type, record.payload);
    writer.close();
    const reader = new DurableJournal(options);
    journals.push(reader);
    const expected = reader.records().map((record) => [record.seq, record.type] as const);
    expect(reader.currentSequence()).toBe(recordSequence().length);
    // Candidate: the same records as SQL rows under the same verdicts.
    const store = await openStore();
    const generation = store.transaction(() => createPartition(store, "global"));
    const appended = recordSequence().map((record) =>
      store.transaction(() => appendEvent(store, generation.pid, record)),
    );
    expect(appended.map((a) => a.seq)).toEqual(recordSequence().map((_, index) => index + 1));
    const retained = (
      store
        .prepare("SELECT seq, type FROM event WHERE pid = ? ORDER BY seq")
        .all(generation.pid) as Array<{
        seq: number;
        type: string;
      }>
    ).map((row) => [Number(row.seq), row.type] as const);
    expect(retained).toEqual(expected);
    expect(retained.map(([, type]) => type)).toContain("unknown.type");
    expect(retained.some(([, type]) => type === "interaction.resolved")).toBe(false);
    expect(
      Number(
        (
          store.prepare("SELECT next_seq FROM partition WHERE id = ?").get(generation.pid) as {
            next_seq: number;
          }
        ).next_seq,
      ),
    ).toBe(recordSequence().length + 1);
  });

  it("writes slot and group keys the way the policy names them", async () => {
    const store = await openStore();
    const generation = store.transaction(() => createPartition(store, "global"));
    store.transaction(() => {
      appendEvent(store, generation.pid, {
        type: "thread.head.updated",
        payload: { thread_id: "t", revision: 1 },
      });
      appendEvent(store, generation.pid, {
        type: "run.event",
        payload: { run_id: "r", task_id: "k", type: "run.created", ts: "t" },
      });
      appendEvent(store, generation.pid, {
        type: "run.event",
        payload: { run_id: "r", task_id: "k", type: "harness.started", ts: "t" },
      });
    });
    const rows = store
      .prepare("SELECT seq, slot_key, group_key FROM event WHERE pid = ? ORDER BY seq")
      .all(generation.pid) as Array<{
      seq: number;
      slot_key: string | null;
      group_key: string | null;
    }>;
    expect(rows).toEqual([
      { seq: 1, slot_key: "t:t", group_key: null },
      { seq: 2, slot_key: "r:r:c", group_key: null },
      { seq: 3, slot_key: null, group_key: "r:r:live" },
    ]);
  });
});

/** Synthetic command rows: one current generation plus history in older generations. */
function seedCommands(
  store: EngineStore,
  pid: number,
  options: {
    count: number;
    needsDecision?: number;
    exempt?: number;
    continuations?: number;
    prefix: string;
  },
): void {
  const insert = store.prepare(
    `INSERT INTO command(id, pid, operation, state, run_id, continue_from, created_at, finished_at, summary, params_sha, retention_exempt, needs_decision)
     VALUES(?, ?, 'run.create', 'succeeded', ?, ?, ?, ?, x'00', 'sha', ?, ?)`,
  );
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  store.transaction(() => {
    for (let i = 0; i < options.count; i += 1) {
      const id = `${options.prefix}-${String(i).padStart(6, "0")}`;
      const created = new Date(base + i * 60_000).toISOString();
      const needsDecision = i < (options.needsDecision ?? 0) ? 1 : 0;
      const exempt =
        i >= (options.needsDecision ?? 0) &&
        i < (options.needsDecision ?? 0) + (options.exempt ?? 0)
          ? 1
          : 0;
      const continuation =
        i >= options.count - (options.continuations ?? 0)
          ? `run-${options.prefix}-${String(i - 1).padStart(6, "0")}`
          : null;
      insert.run(id, pid, `run-${id}`, continuation, created, created, exempt, needsDecision);
    }
  });
}

describe("bounded command retention statement (SYNTHESIS_R5 §6.6, T-RET-1)", () => {
  it("selects oldest eligible terminals of the current generation only, bounded per call", async () => {
    const store = await openStore();
    const [old, current] = store.transaction(() => [
      createPartition(store, "project:p"),
      createPartition(store, "project:p"),
    ]);
    store.prepare("UPDATE partition SET status = 'quarantined' WHERE id = ?").run(old.pid);
    seedCommands(store, old.pid, { count: 1500, prefix: "old" });
    seedCommands(store, current.pid, {
      count: 640,
      needsDecision: 30,
      exempt: 10,
      continuations: 20,
      prefix: "cur",
    });
    const now = new Date("2026-10-10T00:00:00.000Z");
    expect(terminalCommandCount(store, current.pid)).toBe(630);
    const candidates = commandRetentionCandidates(store, {
      pid: current.pid,
      now,
      retentionMs: 30 * 86_400_000,
    });
    // excess = 630 − 500 = 130 → one batch of 100, oldest first; rows 0–29 are
    // needs-decision and 30–39 retention-exempt, so the first candidate is row 40.
    expect(candidates).toHaveLength(100);
    expect(candidates[0]).toEqual({ id: "cur-000040", runId: "run-cur-000040" });
    expect(candidates.at(-1)!.id).toBe("cur-000139");
    expect(candidates.every((c) => c.id.startsWith("cur-"))).toBe(true);
    // With the whole excess in one batch: everything eligible, minus the 20
    // continuations (rows 620–639) whose predecessor is still retained.
    const whole = commandRetentionCandidates(store, {
      pid: current.pid,
      now,
      retentionMs: 30 * 86_400_000,
      cap: 20,
      batch: 1000,
    });
    expect(whole).toHaveLength(640 - 30 - 10 - 20);
    expect(whole.some((c) => Number(c.id.slice(4)) >= 620)).toBe(false);
    expect(whole.some((c) => Number(c.id.slice(4)) < 40)).toBe(false);
    // Nothing is eligible before the retention window.
    expect(
      commandRetentionCandidates(store, {
        pid: current.pid,
        now: new Date("2026-01-02T00:00:00.000Z"),
        retentionMs: 30 * 86_400_000,
      }),
    ).toEqual([]);
    // No excess, no candidates.
    expect(
      commandRetentionCandidates(store, { pid: current.pid, now, retentionMs: 0, cap: 630 }),
    ).toEqual([]);
  });

  it("plans stay index-bound and identical at 1x and 10x history (T-PLAN)", async () => {
    const store = await openStore();
    const [old, current] = store.transaction(() => [
      createPartition(store, "project:q"),
      createPartition(store, "project:q"),
    ]);
    store.prepare("UPDATE partition SET status = 'quarantined' WHERE id = ?").run(old.pid);
    seedCommands(store, current.pid, { count: 200, prefix: "cur" });
    seedCommands(store, old.pid, { count: 200, prefix: "h1" });
    const plans = () => ({
      count: queryPlan(store, COMMAND_RETENTION_COUNT_SQL),
      candidates: queryPlan(store, COMMAND_RETENTION_CANDIDATES_SQL),
      cursor: queryPlan(
        store,
        "SELECT seq, time, type, payload FROM event WHERE pid = ? AND seq > ? ORDER BY seq",
      ),
    });
    const oneX = plans();
    // Index-bound on the current generation (SQLite 3.53 still fetches the row
    // to re-check the partial predicate, so the entry is USING INDEX, not COVERING).
    expect(oneX.count).toEqual(["SEARCH command USING INDEX command_retention (pid=?)"]);
    expect(oneX.candidates.join("\n")).toMatch(/SEARCH c USING INDEX command_retention \(pid=\?\)/);
    expect(oneX.candidates.join("\n")).toMatch(
      /MULTI-INDEX OR|USING INDEX command_run|PRIMARY KEY/,
    );
    expect(oneX.candidates.join("\n")).not.toMatch(/SCAN c\b/);
    expect(oneX.cursor.join("\n")).toMatch(/SEARCH event USING PRIMARY KEY \(pid=\? AND seq>\?\)/);
    expect(oneX.cursor.join("\n")).not.toMatch(/TEMP B-TREE/);
    seedCommands(store, old.pid, { count: 1800, prefix: "h2" });
    const tenX = plans();
    expect(tenX).toEqual(oneX);
    const now = new Date("2026-10-10T00:00:00.000Z");
    expect(
      commandRetentionCandidates(store, { pid: current.pid, now, retentionMs: 0, cap: 100 }),
    ).toHaveLength(100);
  });
});
