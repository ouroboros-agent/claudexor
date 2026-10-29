import { describe, expect, it } from "vitest";
import { timelineEvents } from "./run-timeline.js";

/**
 * #450: a command that was moved to a background shell, timed out, or ended
 * in an unrecognized state is not a finished success. Its timeline row is a
 * warning; the typed fact decides, never the row text. Errors stay errors and
 * legacy rows without command facts keep their existing severity.
 */
function toolResult(tool: Record<string, unknown>, text = "tool_result") {
  return {
    type: "harness.event",
    payload: {
      harness_id: "cursor",
      attempt_id: "a01",
      type: "tool_result",
      title: text,
      text,
      tool: { name: "shell", kind: "command", target: "find /repo -name '*.log'", ...tool },
    },
  };
}

describe("timelineEvents projects command outcomes (#450)", () => {
  it("marks a background handoff, an elapsed timeout and an unknown outcome as warnings", () => {
    const rows = timelineEvents({}, [
      toolResult({
        status: "ok",
        command_outcome: { state: "backgrounded", background_reason: "timeout", shell_id: "3" },
      }),
      toolResult({ status: "ok", command_outcome: { state: "timed_out", timeout_ms: 30000 } }),
      toolResult({ status: "ok", command_outcome: { state: "unknown" } }),
      toolResult({ status: "ok", command_outcome: { state: "suspended" } }),
    ]);
    expect(rows.map((row) => row.severity)).toEqual(["warning", "warning", "warning", "warning"]);
    expect(rows.every((row) => row.toolName === "shell")).toBe(true);
  });

  it("keeps observed exits, errors and legacy rows on their existing severity", () => {
    const rows = timelineEvents({}, [
      toolResult({ status: "ok", exit_code: 0, command_outcome: { state: "exited" } }),
      toolResult({ status: "ok" }),
      toolResult(
        { status: "error", error_summary: "1 failing", command_outcome: { state: "timed_out" } },
        "tool_result: error: 1 failing",
      ),
    ]);
    expect(rows.map((row) => row.severity)).toEqual(["info", "info", "error"]);
  });
});
