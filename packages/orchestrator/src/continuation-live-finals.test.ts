/**
 * A represented try's carried answer is the LAST typed final AnswerAssembly
 * accepts: a live message after a result runs the next native turn of the same
 * process (packages/harness-claude/src/live-input-fixtures.test.ts, "final
 * text"), so one physical try can record several finals. Only the carried one
 * and its repeats are left out of the evidence; an earlier native turn's
 * distinct final reaches the packet once, attributed like other retained output.
 *
 * Astra r4 coupling finding (`.review-evidence/astra-r4/parser-output-probe.mjs`):
 * the recorded fixture through the actual Claude parser, readContinuationEvidence
 * and buildEvidenceIndex. The single-final stream and structured-envelope fixtures
 * of the same probe keep their carried final exactly once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnswerAssembly } from "@claudexor/core";
import { RunTelemetry, SCHEMA_VERSION, type HarnessEvent } from "@claudexor/schema";
import {
  readContinuationEvidence,
  runExecutionFacts,
  unrepresentedOutput,
} from "@claudexor/workspace";
import { buildEvidenceIndex } from "./continuation-evidence.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import { parseCodexEvent } from "../../harness-codex/src/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** A recorded fixture through its real parser, as the run log stores it. */
function recorded(
  harness: "claude" | "codex",
  name: string,
  parse: (frame: unknown) => HarnessEvent[] | null,
) {
  const frames = readFileSync(join(here, `../../harness-${harness}/fixtures/${name}`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction?: string; frame?: unknown })
    .flatMap((row) => (row.frame ? (row.direction === "cli->client" ? [row.frame] : []) : [row]));
  const events = frames.flatMap((frame) => parse(frame) ?? []);
  const answer = new AnswerAssembly();
  for (const event of events) answer.observe(event);
  const rows = events.map((event, seq) => ({
    seq: seq + 1,
    ts: event.ts,
    run_id: "run-p",
    task_id: "task-p",
    type: "harness.event" as const,
    payload: { ...event, attempt_id: "a01", harness_id: harness },
  }));
  const finals = events.filter((event) => event.type === "message" && event.final === true);
  return { rows, finals, carried: answer.text() };
}

/** A completed run whose final answer is `answer`, recorded by `rows`. */
function completedRun(rows: unknown[], answer: string) {
  const runDir = mkdtempSync(join(tmpdir(), "cx-live-finals-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "final"));
  writeFileSync(
    join(runDir, "events.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(join(runDir, "final/answer.md"), answer);
  const web = {
    required: false,
    policy: "off",
    effective_mode: "off",
    attempted: false,
    satisfied: false,
    status: "none",
    tool: null,
    target: null,
    error_summary: null,
  };
  writeFileSync(
    join(runDir, "final/telemetry.yaml"),
    JSON.stringify(
      RunTelemetry.parse({
        schema_version: SCHEMA_VERSION,
        run_id: "run-p",
        task_id: "task-p",
        mode: "ask",
        requested_access: "readonly",
        effective_access: "readonly",
        external_context_policy: "auto",
        effective_web_mode: "off",
        web,
        final_attempt_id: "a01",
        attempts: [],
        generated_at: "2026-10-29T00:00:00.000Z",
      }),
    ),
  );
  return runDir;
}

describe("a represented try with several native-turn finals (Claude live message)", () => {
  it("keeps the earlier distinct final once beside the carried last final, which is not repeated", () => {
    const parse = createClaudeParser();
    const live = recorded("claude", "stream-json/recorded-live-final-text-2.1.283.jsonl", (frame) =>
      parse(frame, "process-1"),
    );
    expect(live.finals).toHaveLength(2);
    expect(live.carried).toBe("MANGO");
    const firstFinal = live.finals[0]!.text!;
    expect(Buffer.byteLength(firstFinal)).toBe(7115);
    expect(firstFinal).not.toContain("MANGO");

    const runDir = completedRun(live.rows, live.carried);
    const evidence = readContinuationEvidence(runDir);
    expect(count(evidence.output, firstFinal)).toBe(1);
    expect(evidence.output).toContain("## Attempt a01 · claude");
    const index = buildEvidenceIndex({
      cause: "other",
      completed: true,
      workOrder: "Continue the investigation",
      steering: [],
      retainedOutput: evidence.output,
      toolCalls: [],
      diffStat: null,
      artifacts: { eventsLog: join(runDir, "events.jsonl"), attemptDir: null, patch: null },
    });
    expect(count(index.markdown, firstFinal)).toBe(1);
    expect(count(index.markdown, "MANGO")).toBe(1);
    expect(index.markdown.indexOf("Final answer (final/answer.md, attempt a01):")).toBeLessThan(
      index.markdown.indexOf(firstFinal),
    );
    // Both finals fit the existing section budget: nothing was cut, and the flag says so.
    expect(index.summarized).toBe(false);
  });

  it("single-final stream and structured-envelope fixtures keep their carried final exactly once", () => {
    for (const name of [
      "recorded-partial-messages.jsonl",
      "recorded-partial-multiblock.jsonl",
      "recorded-partial-joined.jsonl",
      "recorded-partial-replay.jsonl",
    ]) {
      const parse = createClaudeParser();
      const { rows, finals, carried } = recorded("claude", name, (frame) =>
        parse(frame, "process-1"),
      );
      expect(finals, name).toHaveLength(1);
      const additional =
        unrepresentedOutput(rows as never, runExecutionFacts(rows as never), "a01", carried) ?? "";
      expect(count(`${carried}\n${additional}`, carried.trim()), name).toBe(1);
    }
    const state = { envelopeActive: true };
    const codex = recorded("codex", "structured-envelope-intermediate.jsonl", (frame) =>
      parseCodexEvent(frame, "process-1", state),
    );
    const additional =
      unrepresentedOutput(
        codex.rows as never,
        runExecutionFacts(codex.rows as never),
        "a01",
        codex.carried,
      ) ?? "";
    expect(count(`${codex.carried}\n${additional}`, codex.carried.trim())).toBe(1);
    expect(additional).toContain("Использую навык OpenAI Docs");
    expect(additional).not.toContain("work_report");
  });
});
