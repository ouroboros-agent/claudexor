import { afterEach, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetentionPass } from "./retention.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true });
});
function age(root: string) {
  for (const entry of readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) age(join(root, entry.name));
  utimesSync(root, new Date("2020-01-01"), new Date("2020-01-01"));
}
async function pass(runtime: string, dry_run = false, refresh?: () => Promise<void>) {
  return runRetentionPass(
    { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 },
    { dry_run },
    {
      projects: () => [{ root: runtime, runsDir: join(runtime, "runs"), reviewsDir: null }],
      records: () => [],
      referencedRunIds: () => new Set(),
      refreshReferences: refresh,
    },
  );
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "empty-runtime-"));
  cleanup.push(root);
  const runtime = join(root, "runtime");
  for (const name of [
    "runs",
    "anchors/objects",
    "workspaces",
    "patches",
    "lanes/deep/empty",
    "arbitrary/empty",
    ".retiring/empty",
  ])
    mkdirSync(join(runtime, name), { recursive: true });
  age(runtime);
  return { root, runtime };
}
it("reaps every old empty container, including patches, lanes and unknown nesting; preview keeps them", async () => {
  const { runtime } = fixture();
  await pass(runtime, true);
  expect(existsSync(join(runtime, "lanes/deep/empty"))).toBe(true);
  await pass(runtime);
  expect(existsSync(runtime)).toBe(false);
});
it("one file preserves its tree, then the old empty tree goes", async () => {
  const { runtime } = fixture();
  const path = join(runtime, "arbitrary/empty/owner");
  writeFileSync(path, "owned");
  age(runtime);
  await pass(runtime);
  expect(existsSync(path)).toBe(true);
  rmSync(path);
  age(runtime);
  await pass(runtime);
  expect(existsSync(runtime)).toBe(false);
});
it("keeps a directory admitted during this pass and reaps it after it ages", async () => {
  const { runtime } = fixture();
  let created = false;
  const path = join(runtime, "new/child");
  await pass(runtime, false, async () => {
    if (created) return;
    created = true;
    mkdirSync(path, { recursive: true });
    // Explicitly beyond pass start even on a coarse timestamp filesystem.
    utimesSync(path, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  });
  expect(existsSync(path)).toBe(true);
  age(runtime);
  await pass(runtime);
  expect(existsSync(runtime)).toBe(false);
});
it("never follows links or visits tombstones and frozen stores", async () => {
  const { root, runtime } = fixture();
  const outside = join(root, "outside/empty");
  mkdirSync(outside, { recursive: true });
  symlinkSync(join(root, "outside"), join(runtime, "linked"), "dir");
  for (const name of [
    "journal-legacy",
    "journal-archived",
    "resource-store/idempotency",
    "runs/expired/keep-empty",
  ])
    mkdirSync(join(runtime, name), { recursive: true });
  writeFileSync(
    join(runtime, "runs/expired/tombstone.yaml"),
    "run_id: expired\ndeleted_at: 2020-01-01\n",
  );
  age(runtime);
  await pass(runtime);
  for (const name of [
    "journal-legacy",
    "journal-archived",
    "resource-store/idempotency",
    "runs/expired/keep-empty",
    "linked",
  ])
    expect(existsSync(join(runtime, name))).toBe(true);
  expect(existsSync(outside)).toBe(true);
});
