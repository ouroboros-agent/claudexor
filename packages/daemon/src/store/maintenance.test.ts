import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobFiles, sha256Hex } from "./blob-files.js";
import { MaintenanceController } from "./maintenance.js";
import { EngineStore } from "./store.js";

function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
const controllers: MaintenanceController[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-maintenance-"));
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(): Promise<{ store: EngineStore; maintenance: MaintenanceController }> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
  });
  stores.push(store);
  const maintenance = new MaintenanceController(store, {
    workerEntry: builtWorkerEntry("maintenance-worker.js"),
    processStartedAt: Date.now(),
  });
  controllers.push(maintenance);
  return { store, maintenance };
}
let nextSeq = 1;
function seedRows(store: EngineStore, n: number): void {
  const insert = store.prepare(
    "INSERT INTO event(pid, seq, time, type, payload) VALUES(1, ?, 't', 'x', ?)",
  );
  store.transaction(() => {
    for (let i = 0; i < n; i += 1) insert.run(nextSeq++, Buffer.alloc(900, nextSeq & 0xff));
  });
}
/** Push every WAL frame into the database file (retrying a pass that raced the flusher's checkpoint lock). */
function checkpointAll(store: EngineStore): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = store.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
    };
    if (Number(row.busy) === 0 && Number(row.log) === 0) return;
  }
  throw new Error("could not truncate the WAL");
}
function age(path: string, by = 60_000): void {
  const then = (Date.now() - by) / 1000;
  utimesSync(path, then, then);
}

describe("maintenance worker (SYNTHESIS_R5 §6.5, §7 p.6)", () => {
  it("runs integrity_check on its own connection and records the fact", async () => {
    const { store, maintenance } = await openStore();
    seedRows(store, 200);
    expect(store.facts().integrity).toBe("pending");
    const report = await maintenance.integrityCheck();
    expect(report).toMatchObject({ ok: true, problems: [] });
    expect(store.facts().integrity).toBe("ok");
    // Corrupt b-tree page headers of the database file (after pushing the WAL into it) and ask again.
    checkpointAll(store);
    const fd = openSync(store.paths.database, "r+");
    try {
      for (const page of [3, 4, 5, 6])
        writeSync(fd, Buffer.alloc(32, 0xff), 0, 32, 4096 * (page - 1));
    } finally {
      closeSync(fd);
    }
    const failed = await maintenance.integrityCheck();
    expect(failed.ok).toBe(false);
    expect(failed.problems.length).toBeGreaterThan(0);
    expect(store.facts().integrity).toBe("failed");
  });

  it("exports a consistent snapshot with VACUUM INTO while the main thread keeps writing", async () => {
    const { store, maintenance } = await openStore();
    seedRows(store, 300);
    const target = join(root, "export.sqlite");
    const exporting = maintenance.exportTo(target);
    seedRows(store, 1); // may or may not land in the snapshot; the export stays consistent either way
    const report = await exporting;
    expect(report.target).toBe(target);
    expect(report.bytes).toBeGreaterThan(0);
    const exported = new DatabaseSync(target, { readOnly: true });
    try {
      expect(
        (exported.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
          .integrity_check,
      ).toBe("ok");
      const n = Number(
        (exported.prepare("SELECT count(*) AS n FROM event").get() as { n: number }).n,
      );
      expect([300, 301]).toContain(n);
    } finally {
      exported.close();
    }
  });

  it("T-GC-2: sweeps only unreferenced files older than the process start, writing no rows", async () => {
    const { store, maintenance } = await openStore();
    const blobs = new BlobFiles(store);
    mkdirSync(store.paths.uploads, { recursive: true });
    const owned = blobs.prepareBody(Buffer.alloc(70_000, 1));
    const orphanOld = blobs.prepareBody(Buffer.alloc(70_000, 2));
    const orphanYoung = blobs.prepareBody(Buffer.alloc(70_000, 3));
    const referencedOnly = blobs.prepareBody(Buffer.alloc(70_000, 4));
    store.transaction(() => {
      blobs.insertRow(owned);
      store
        .prepare(
          "INSERT INTO resource(id, kind, sha256, size_bytes, state, created_at, body) VALUES('r1','file',?,70000,'ready','t',x'00')",
        )
        .run(referencedOnly.sha256);
      store
        .prepare(
          "INSERT INTO upload(id, state, received_bytes, body) VALUES('live-upl', 'uploaded', 5, x'00')",
        )
        .run();
      store
        .prepare(
          "INSERT INTO upload(id, state, received_bytes, body) VALUES('done-upl', 'published', 5, x'00')",
        )
        .run();
    });
    const staleTemp = join(store.paths.blobs, `.${"a".repeat(64)}.deadbeef.tmp`);
    writeFileSync(staleTemp, "partial");
    const livePart = join(store.paths.uploads, "live-upl.part");
    const donePart = join(store.paths.uploads, "done-upl.part");
    const rowlessPart = join(store.paths.uploads, "ghost.part");
    const youngPart = join(store.paths.uploads, "young.part");
    for (const path of [livePart, donePart, rowlessPart, youngPart]) writeFileSync(path, "bytes");
    for (const path of [
      owned.file!,
      orphanOld.file!,
      referencedOnly.file!,
      staleTemp,
      livePart,
      donePart,
      rowlessPart,
    ])
      age(path);
    const rowsBefore = (
      store
        .prepare(
          "SELECT (SELECT count(*) FROM blob) + (SELECT count(*) FROM upload) + (SELECT count(*) FROM resource) AS n",
        )
        .get() as { n: number }
    ).n;
    const report = await maintenance.sweepOrphans();
    expect(report.removedBlobs).toEqual([orphanOld.sha256]);
    expect(report.removedTemps).toEqual([`.${"a".repeat(64)}.deadbeef.tmp`]);
    expect(report.removedParts.sort()).toEqual(["done-upl.part", "ghost.part"]);
    expect(report.keptOwned).toBe(3); // owned blob, referenced-only blob, live part
    expect(report.keptYoung).toBe(2); // young blob, young part
    expect(readdirSync(store.paths.blobs).sort()).toEqual(
      [owned.sha256, orphanYoung.sha256, referencedOnly.sha256].sort(),
    );
    expect(readdirSync(store.paths.uploads).sort()).toEqual(["live-upl.part", "young.part"]);
    const rowsAfter = (
      store
        .prepare(
          "SELECT (SELECT count(*) FROM blob) + (SELECT count(*) FROM upload) + (SELECT count(*) FROM resource) AS n",
        )
        .get() as { n: number }
    ).n;
    expect(rowsAfter).toBe(rowsBefore);
    expect(store.facts().flusher.pending_registrations).toBeGreaterThanOrEqual(1);
    // Nothing left to remove on a second pass.
    const again = await maintenance.sweepOrphans();
    expect(again.removedBlobs).toEqual([]);
    expect(again.removedParts).toEqual([]);
    expect(sha256Hex(Buffer.alloc(70_000, 1))).toBe(owned.sha256);
  });

  it("serializes requests on one worker and refuses after stop", async () => {
    const { store, maintenance } = await openStore();
    seedRows(store, 50);
    const [a, b] = await Promise.all([maintenance.integrityCheck(), maintenance.integrityCheck()]);
    expect(a.ok && b.ok).toBe(true);
    await maintenance.stop();
    await expect(maintenance.integrityCheck()).rejects.toMatchObject({ code: "store_closed" });
  });
});
