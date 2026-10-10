import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobFiles, INLINE_BODY_MAX_BYTES, sha256Hex } from "./blob-files.js";
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
  root = mkdtempSync(join(tmpdir(), "cx-blobs-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(manualTick = false): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
    flusherHooks: { manualTick },
  });
  stores.push(store);
  return store;
}
function body(size: number, fill = 7): Buffer {
  return Buffer.alloc(size, fill);
}
function commandWithParams(store: EngineStore, id: string, sha: string): void {
  store
    .prepare(
      "INSERT INTO command(id, pid, operation, state, created_at, summary, params_sha) VALUES(?, 1, 'run.create', 'succeeded', 't', x'00', ?)",
    )
    .run(id, sha);
}

describe("blob files (SYNTHESIS_R5 §6.5)", () => {
  it("stores bodies up to 64 KiB inline and larger bodies as content-addressed files", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const small = blobs.prepareBody(body(INLINE_BODY_MAX_BYTES));
    expect(small.inline).not.toBeNull();
    expect(small.file).toBeNull();
    const large = blobs.prepareBody(body(INLINE_BODY_MAX_BYTES + 1));
    expect(large.inline).toBeNull();
    expect(large.file).toBe(join(store.paths.blobs, large.sha256));
    expect(large.generation).not.toBeNull();
    expect(readdirSync(store.paths.blobs)).toEqual([large.sha256]);
    store.transaction(() => {
      blobs.insertRow(small);
      blobs.insertRow(large);
      commandWithParams(store, "c1", small.sha256);
      commandWithParams(store, "c2", large.sha256);
    });
    expect(blobs.read(small.sha256).equals(body(INLINE_BODY_MAX_BYTES))).toBe(true);
    expect(blobs.read(large.sha256).equals(body(INLINE_BODY_MAX_BYTES + 1))).toBe(true);
    expect(() => blobs.read("f".repeat(64))).toThrow(/no blob/);
    expect(() => blobs.insertRow(small)).toThrow(/inside the owner's transaction/);
  });

  it("never rewrites an existing blob file and tolerates a repeated row", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const bytes = body(100_000, 3);
    const first = blobs.prepareBody(bytes);
    const before = statSync(first.file!);
    const second = blobs.prepareBody(bytes);
    expect(second.sha256).toBe(first.sha256);
    expect(statSync(second.file!).ino).toBe(before.ino);
    expect(statSync(second.file!).mtimeMs).toBe(before.mtimeMs);
    store.transaction(() => {
      blobs.insertRow(first);
      blobs.insertRow(second);
    });
    expect(Number((store.prepare("SELECT count(*) AS n FROM blob").get() as { n: number }).n)).toBe(
      1,
    );
  });

  it("detects a tampered file through the digest", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const ref = blobs.prepareBody(body(70_000));
    store.transaction(() => blobs.insertRow(ref));
    writeFileSync(ref.file!, body(70_000, 9));
    expect(() => blobs.read(ref.sha256)).toThrow(/does not match its digest/);
  });

  it("publishes an upload part by hard link, once", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const bytes = body(200_000, 5);
    const part = join(store.paths.uploads, "upl-1.part");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(store.paths.uploads, { recursive: true });
    writeFileSync(part, bytes);
    const sha = sha256Hex(bytes);
    const published = blobs.publishLink(part, sha);
    expect(published.linked).toBe(true);
    expect(statSync(published.path).nlink).toBe(2);
    expect(blobs.publishLink(part, sha).linked).toBe(false);
    store.transaction(() =>
      blobs.insertRow({
        sha256: sha,
        size: bytes.length,
        inline: null,
        file: published.path,
        generation: null,
      }),
    );
    expect(blobs.read(sha).equals(bytes)).toBe(true);
  });

  it("T-GC-1: the GC rechecks owners after flushed() and keeps a digest published meanwhile", async () => {
    const store = await openStore(true);
    const blobs = new BlobFiles(store);
    const obligations = new Obligations(store);
    const orphan = blobs.prepareBody(body(80_000, 1));
    const republished = blobs.prepareBody(body(80_000, 2));
    const obligated = blobs.prepareBody(body(80_000, 3));
    store.transaction(() => {
      blobs.insertRow(orphan);
      blobs.insertRow(republished);
      blobs.insertRow(obligated);
      obligations.create("publish_blob", "upl-9", 0, {
        sha: obligated.sha256,
        resource_id: "res-9",
      });
    });
    const collecting = blobs.collect([orphan.sha256, republished.sha256, obligated.sha256]);
    // Races the GC's flushed() wait: a publication that references the digest
    // commits synchronously before the GC's recheck runs.
    store.transaction(() => commandWithParams(store, "c9", republished.sha256));
    store.flusherControl.tick();
    const result = await collecting;
    expect(result).toEqual({
      removed: [orphan.sha256],
      kept: [republished.sha256, obligated.sha256],
    });
    expect(existsSync(orphan.file!)).toBe(false);
    expect(existsSync(republished.file!)).toBe(true);
    expect(existsSync(obligated.file!)).toBe(true);
    expect(
      (
        store.prepare("SELECT sha256 FROM blob ORDER BY sha256").all() as Array<{ sha256: string }>
      ).map((r) => r.sha256),
    ).toEqual([republished.sha256, obligated.sha256].sort());
  });
});
