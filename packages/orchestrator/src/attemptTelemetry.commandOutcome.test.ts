import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import {
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
  unrecoveredToolErrors,
} from "./attemptTelemetry.js";

/**
 * #450 + INV-043: a command result that does not establish an observed end
 * (moved to a background shell, timed out, or an unrecognized state) never
 * proves that the command finished, so it can never recover an earlier
 * failure of the same command. Results without ids use the legacy
 * tool + kind + target key, which is where such a result used to launder the
 * failure.
 */
const ts = "2026-10-29T00:00:00.000Z";

function shellResult(status: "ok" | "error", commandOutcome?: unknown): HarnessEvent {
  return {
    type: "tool_result",
    session_id: "s",
    ts,
    tool: {
      name: "shell",
      kind: "command",
      target: "pnpm test",
      status,
      ...(status === "error" ? { error_summary: "1 failing" } : {}),
      ...(commandOutcome === undefined ? {} : { command_outcome: commandOutcome }),
    },
  } as HarnessEvent;
}

function outcomeAfterDeliverable(events: HarnessEvent[]) {
  const t = createAttemptTelemetry("auto", false);
  for (const event of events) observeAttemptTelemetry(t, event);
  setAttemptOutcome(t, {
    deliverablePresent: true,
    gatesPassed: null,
    harnessErrored: false,
    webRequiredUnsatisfied: false,
  });
  return t;
}

describe("command outcome and tool-error recovery (#450, INV-043)", () => {
  it.each([
    [
      "a background handoff",
      { state: "backgrounded", background_reason: "timeout", timeout_ms: 30000, shell_id: "3" },
    ],
    ["an elapsed timeout", { state: "timed_out", timeout_ms: 30000 }],
    ["an unrecognized outcome", { state: "unknown" }],
    ["a state from a newer engine", { state: "suspended" }],
  ])("%s of the same command leaves the earlier failure unrecovered", (_label, outcome) => {
    const t = outcomeAfterDeliverable([shellResult("error"), shellResult("ok", outcome)]);
    expect(unrecoveredToolErrors(t)).toHaveLength(1);
    // The delivered answer is kept: warnings, never a discarded deliverable.
    expect(t.outcome?.status).toBe("success_with_warnings");
  });

  it("an observed exit of the same command still recovers, as do legacy results", () => {
    const exited = outcomeAfterDeliverable([
      shellResult("error"),
      shellResult("ok", { state: "exited" }),
    ]);
    expect(unrecoveredToolErrors(exited)).toHaveLength(0);
    expect(exited.outcome?.status).toBe("success");

    const legacy = outcomeAfterDeliverable([shellResult("error"), shellResult("ok")]);
    expect(unrecoveredToolErrors(legacy)).toHaveLength(0);
  });

  it("an unconfirmed command by itself is not a tool error and keeps the deliverable", () => {
    const t = outcomeAfterDeliverable([
      shellResult("ok", { state: "backgrounded", background_reason: "requested", pid: 4343 }),
    ]);
    expect(t.toolErrors).toHaveLength(0);
    expect(t.outcome?.status).toBe("success");
  });
});
