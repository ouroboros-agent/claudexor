import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readEvents, readRunYaml } from "./support.js";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = makeSandbox();
});
afterEach(() => {
  sandbox.dispose();
});

describe("ordinary Agent review intent", () => {
  it.each([{ controls: [] }, { controls: ["--no-review", "--attempts", "3"] }])(
    "[INV-112:ordinary-unreviewed-apply] preserves opt-out through CLI, daemon and delivery: %j",
    ({ controls }) => {
      const run = cli(sandbox, [
        "agent",
        "Create the deterministic fixture change",
        "--harness",
        "fake-implement",
        ...controls,
        "--json",
      ]);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      const result = run.json() as { runId: string; runDir: string; runFacts: unknown };
      const stored = readRunYaml(result.runDir, "final/run_facts.yaml");
      expect(stored).toMatchObject({
        outcome: { lifecycle: "succeeded", review: "not_run", review_requested: false },
        apply: { eligibility: { eligible: true, state: "not_verified" } },
        required_actions: [],
      });
      expect(result.runFacts).toEqual(stored);
      expect(readRunYaml(result.runDir, "context/task.yaml")).toMatchObject({
        review_requested: false,
      });
      const events = readEvents(result.runDir);
      expect(
        events.some((e) => e.type === "review.preflight" || e.type === "reviewer.started"),
      ).toBe(false);
      const stopped = cli(sandbox, ["daemon", "stop"]);
      expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
      const inspected = cli(sandbox, ["inspect", result.runId, "--json"]);
      expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0);
      expect((inspected.json() as { runFacts: unknown }).runFacts).toEqual(stored);
      const applied = cli(sandbox, ["apply", result.runId]);
      expect(applied.code, applied.stdout + applied.stderr).toBe(0);
      expect(readFileSync(join(sandbox.repo, "FAKE_CHANGE.txt"), "utf8")).toBe(
        "fake-implement deterministic change\n",
      );
    },
  );

  it.each([
    { command: "agent", controls: ["--review"] },
    { command: "best-of", controls: ["--n", "1"] },
  ])(
    "[INV-112:explicit-review-retained] retains requested review through the daemon: %j",
    ({ command, controls }) => {
      const run = cli(sandbox, [
        command,
        "Create the deterministic fixture change",
        "--harness",
        "fake-implement",
        ...controls,
        "--json",
      ]);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      const result = run.json() as { runId: string; runDir: string };
      expect(readRunYaml(result.runDir, "context/task.yaml")).toMatchObject({
        review_requested: true,
      });
      expect(readRunYaml(result.runDir, "final/run_facts.yaml")).toMatchObject({
        outcome: { review: "not_run", review_requested: true },
        apply: { eligibility: { eligible: false } },
      });
      const apply = cli(sandbox, ["apply", result.runId, "--dry-run"]);
      expect(apply.code).toBe(1);
    },
  );
});
