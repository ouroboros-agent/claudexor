import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlGcReceipt, GcHoldClass } from "@claudexor/schema";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { afterRetention, serializeRetention } from "./retention-lifetime.js";
import { readLastRetention, recordLastRetention } from "./retention-last-pass.js";
import { createSqlDaemonRuntime } from "./sql-daemon-runtime.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function receipt() {
  return ControlGcReceipt.parse({
    dry_run: false,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    policy: { runs_max_age_days: 30, reviews_max_age_days: 14, keep_last_runs_per_project: 0 },
    examined_runs: 0,
    kept: {},
    freed_bytes: 17,
  });
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gc-last-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const sql = await sqlFixture(root);
  cleanup.push(() => sql.close());
  return { root, sql };
}
it("defaults an old receipt without the new hold/truncation fields", () => {
  expect(receipt()).toMatchObject({
    held: { roots: 0, native_homes: 0 },
    holds: [],
    truncated: false,
  });
});
it("persists held class/count/since through reopen and log truncation; preview preserves it and a clean pass clears it", async () => {
  const { root, sql } = await fixture();
  const held = receipt();
  held.held.roots = 2;
  held.holds = [{ class: "missing_partition", count: 2, example: "/fixture/root" }];
  await recordLastRetention(async () => held, sql.store)({ dry_run: false });
  const first = readLastRetention(sql.store)!;
  expect(first.outcome).toBe("held");
  expect(first.holds[0]?.count).toBe(2);
  const since = first.holds[0]!.since;
  expect(since).toBe(first.started_at);
  await sql.close();
  writeFileSync(join(root, "daemon.log"), "");
  const reopened = await sqlFixture(root);
  cleanup.push(() => reopened.close());
  expect(readLastRetention(reopened.store)).toEqual(first);
  await recordLastRetention(async () => held, reopened.store)({ dry_run: false });
  expect(readLastRetention(reopened.store)?.holds[0]?.since).toBe(since);
  const prior = readLastRetention(reopened.store);
  await recordLastRetention(async () => receipt(), reopened.store)({ dry_run: true });
  expect(readLastRetention(reopened.store)).toEqual(prior);
  await recordLastRetention(async () => receipt(), reopened.store)({ dry_run: false });
  expect(readLastRetention(reopened.store)).toMatchObject({
    outcome: "completed",
    holds: [],
    held: { roots: 0, native_homes: 0 },
    errors: { count: 0, first: null },
  });
});
it.each(["model", "upload"])(
  "records a throwing outer %s cleanup as failed with the earlier freed bytes",
  async (step) => {
    const { root, sql } = await fixture();
    const runtime = createSqlDaemonRuntime(sql.graph, {
      server: { socketPath: join(root, "unused.sock"), token: "fixture" },
      authReadiness: () => ({ invalidate() {} }),
      agent: () => async () => ({ lifecycle: "succeeded" }),
    });
    cleanup.push(() => runtime.stop());
    if (step === "upload")
      vi.spyOn(sql.graph.resources, "pruneUploadBindings").mockImplementation(() => {
        throw new Error("upload cleanup unavailable");
      });
    else
      vi.spyOn(runtime.models.operations, "reconcileResources").mockImplementation(() => {
        throw new Error("model cleanup unavailable");
      });
    const run = runtime.retention(async () => receipt());
    await expect(run({ dry_run: false })).rejects.toThrow(`${step} cleanup unavailable`);
    expect(readLastRetention(sql.store)).toMatchObject({
      outcome: "failed",
      freed_bytes: 17,
      errors: { count: 1, first: expect.stringContaining(`${step} cleanup unavailable`) },
    });
  },
);
it("drains the actual persistence barrier before shutdown and propagates a barrier failure", async () => {
  const { sql } = await fixture();
  const flush = sql.store.flushed.bind(sql.store);
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const spy = vi.spyOn(sql.store, "flushed").mockImplementation(async () => {
    entered();
    await barrier;
    await flush();
  });
  const run = recordLastRetention(
    serializeRetention(async () => receipt()),
    sql.store,
  );
  const pending = run({ dry_run: false });
  await ready;
  let stopped = false;
  const stop = run.cancel!().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stopped).toBe(false);
  release();
  await pending;
  await stop;
  expect(stopped).toBe(true);
  spy.mockRejectedValue(new Error("durability unavailable"));
  await expect(run({ dry_run: false })).rejects.toThrow("durability unavailable");
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "failed",
    errors: { count: 1, first: expect.stringContaining("durability unavailable") },
  });
});
it("bounds accumulated diagnostics to 16 KiB and never reports truncation or errors as completed", async () => {
  const { sql } = await fixture();
  const data = receipt();
  data.holds = GcHoldClass.options.flatMap((kind) =>
    Array.from({ length: 10 }, () => ({ class: kind, count: 1, example: "\u0000".repeat(5000) })),
  );
  data.errors = Array.from({ length: 200 }, () => "\u0000".repeat(10000));
  data.truncated = true;
  await recordLastRetention(async () => data, sql.store)({ dry_run: false });
  const last = readLastRetention(sql.store)!;
  expect(last.outcome).toBe("truncated");
  expect(last.holds.every((hold) => hold.count === 10)).toBe(true);
  expect(last.errors.count).toBe(200);
  expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThanOrEqual(16 * 1024);
  await recordLastRetention(
    afterRetention(
      async () => receipt(),
      () => {
        throw new Error("outer failure");
      },
    ),
    sql.store,
  )({ dry_run: true }).catch(() => {});
  expect(readLastRetention(sql.store)).toEqual(last);
  const errors = receipt();
  errors.errors = ["cannot clean"];
  await recordLastRetention(async () => errors, sql.store)({ dry_run: false });
  expect(readLastRetention(sql.store)?.outcome).toBe("failed");
});

it("cancels queued outer passes without starting them and records resumable truncation", async () => {
  const { sql } = await fixture();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  const core = serializeRetention(async (_request, signal) => {
    calls += 1;
    enter();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    const value = receipt();
    value.truncated = true;
    return value;
  });
  const run = recordLastRetention(core, sql.store);
  const first = run({ dry_run: false });
  const queued = run({ dry_run: false }).catch((error: unknown) => error);
  await entered;
  await run.cancel!();
  await first;
  await queued;
  expect(calls).toBe(1);
  expect(readLastRetention(sql.store)?.outcome).toBe("truncated");
});
it("propagates a write failure without replacing the preceding durable record", async () => {
  const { sql } = await fixture();
  const run = recordLastRetention(async () => receipt(), sql.store);
  await run({ dry_run: false });
  const previous = readLastRetention(sql.store);
  vi.spyOn(sql.store, "transaction").mockImplementation(() => {
    throw new Error("meta write failed");
  });
  await expect(run({ dry_run: false })).rejects.toThrow("meta write failed");
  expect(readLastRetention(sql.store)).toEqual(previous);
});
