import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeExternalFile } from "./external-files.js";
import type { FlusherPassReport } from "./flusher-protocol.js";
import { Obligations } from "./obligations.js";
import { EngineStore } from "./store.js";

function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-obligations-"));
});
afterEach(async () => {
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
async function pass(store: EngineStore): Promise<FlusherPassReport> {
  return new Promise((resolve) => {
    const off = store.onSynced((_g, report) => {
      off();
      resolve(report);
    });
    store.flusherControl.tick();
  });
}
const openCount = (store: EngineStore) => store.facts().obligations_open;

describe("effect obligations (SYNTHESIS_R5 §4.6)", () => {
  it("is created inside the decision's transaction and refuses to be created outside", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    expect(() => obligations.create("terminal_files", "run-1", 1, {})).toThrow(
      /inside the transaction/,
    );
    store.transaction(() => {
      store.prepare("INSERT INTO run_terminal(run_id, pid, event) VALUES('run-1', 1, x'00')").run();
      obligations.create("terminal_files", "run-1", 1, { facts: { a: 1 } });
    });
    expect(openCount(store)).toBe(1);
    expect(obligations.open()).toEqual([
      expect.objectContaining({
        kind: "terminal_files",
        key: "run-1",
        pid: 1,
        payload: { facts: { a: 1 } },
      }),
    ]);
    // A second terminal for the same run is a constraint violation, not a replay.
    expect(() =>
      store.transaction(() => obligations.create("terminal_files", "run-1", 1, {})),
    ).toThrow(/UNIQUE|constraint/i);
    expect(openCount(store)).toBe(1);
  });

  it("clears only after synced(g) covers every registration (T-BAR-3 obligation side)", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    store.transaction(() => obligations.create("terminal_files", "run-2", 1, {}));
    const finalDir = join(root, "run", "final");
    writeExternalFile(store, { dir: finalDir, name: "run_facts.yaml", bytes: Buffer.from("x") });
    obligations.registerEffect("terminal_files", "run-2", finalDir);
    store.flusherControl.tick();
    // Effect done; the clear needs a pass that covers the registration AND the completion mark.
    obligations.complete("terminal_files", "run-2");
    expect(openCount(store)).toBe(1);
    const first = await pass(store);
    // The tick above ran before `complete()` posted its mark, so only part was covered.
    if (first.g < store.facts().flusher.generation) {
      expect(openCount(store)).toBe(1);
      await pass(store);
    }
    expect(openCount(store)).toBe(0);
    expect(store.facts().flusher.pending_registrations).toBe(0);
  });

  it("stays open while the effect is incomplete, and across a flusher pass", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    store.transaction(() =>
      obligations.create("publish_blob", "upl-1", 0, { sha: "a".repeat(64) }),
    );
    obligations.registerEffect("publish_blob", "upl-1", root);
    await pass(store);
    await pass(store);
    expect(openCount(store)).toBe(1);
    obligations.complete("publish_blob", "upl-1");
    await pass(store);
    expect(openCount(store)).toBe(0);
  });

  it("startup replays open rows through per-kind idempotent handlers", async () => {
    const store = await openStore();
    const first = new Obligations(store);
    store.transaction(() => {
      first.create("terminal_files", "run-3", 1, { facts: "f" });
      first.create("archive_fs", "proj-1", 1, { from: "a", to: "b" });
      first.create("quarantine_fs", "part-1", 1, {});
    });
    first.close();
    // A new process: nothing tracked in memory, three rows on disk.
    const second = new Obligations(store);
    const seen: string[] = [];
    second.registerHandler("terminal_files", (obligation, effects) => {
      seen.push(`${obligation.kind}:${obligation.key}:${JSON.stringify(obligation.payload)}`);
      const dir = join(root, "redo", obligation.key);
      writeExternalFile(store, { dir, name: "run_facts.yaml", bytes: Buffer.from("redone") });
      effects.register(dir);
    });
    second.registerHandler("archive_fs", () => {
      throw new Error("disk says no");
    });
    expect(() => second.registerHandler("archive_fs", () => undefined)).toThrow(
      /already registered/,
    );
    const receipt = second.completeOpen();
    expect(receipt).toEqual({
      completed: [{ kind: "terminal_files", key: "run-3" }],
      failed: [{ kind: "archive_fs", key: "proj-1", error: "disk says no" }],
      unhandled: [{ kind: "quarantine_fs", key: "part-1" }],
    });
    expect(seen).toEqual(['terminal_files:run-3:{"facts":"f"}']);
    expect(openCount(store)).toBe(3);
    await pass(store);
    await pass(store);
    // Only the completed one cleared; the failed and unhandled rows stay as unfinished work.
    expect(
      second
        .open()
        .map((row) => row.key)
        .sort(),
    ).toEqual(["part-1", "proj-1"]);
    expect(openCount(store)).toBe(2);
  });
});
