#!/usr/bin/env tsx
/**
 * Generates the macOS transcript fixture for Cursor command outcomes (#450)
 * from the engine path itself: the native frames of the shell fixture go
 * through the Cursor normalizer and the orchestrator's stored `harness.event`
 * projection. Swift replays these rows through its reducer and transcript
 * presentation. Only timestamps are pinned, so the bytes stay stable.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { createCursorParser } from "../packages/harness-cursor/src/parse.js";
import { harnessEventPayload } from "../packages/orchestrator/src/runSupport.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = "packages/harness-cursor/fixtures/shell/command-outcomes.jsonl";
const fixturePath = join(
  repoRoot,
  "apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/cursor-command-outcome-transcript.json",
);

const parse = createCursorParser();
const events = readFileSync(join(repoRoot, source), "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => parse(JSON.parse(line), "ses-fixture") ?? []);
const rows = events.map((event, index) => {
  const ts = new Date(Date.UTC(2026, 9, 29, 0, 0, index)).toISOString();
  return {
    seq: index + 1,
    ts,
    type: "harness.event",
    payload: harnessEventPayload("cursor", "a01", { ...event, ts }),
  };
});

const fixture = { generatedBy: ["createCursorParser", "harnessEventPayload"], source, rows };
const body = await format(JSON.stringify(fixture), { parser: "json", printWidth: 100 });
if (process.argv.includes("--check")) {
  if (!existsSync(fixturePath) || readFileSync(fixturePath, "utf8") !== body) {
    console.error("cursor transcript fixture drift (regenerate: pnpm fixtures:swift)");
    process.exit(1);
  }
  console.log("cursor transcript fixture fresh");
} else {
  writeFileSync(fixturePath, body);
  console.log(`wrote cursor transcript fixture to ${fixturePath}`);
}
