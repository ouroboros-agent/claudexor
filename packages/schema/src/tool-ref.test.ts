import { describe, expect, it } from "vitest";
import { HarnessEvent } from "./harness.js";
import { commandOutcomeLabel, commandOutcomeUnconfirmed, ToolRef } from "./tool-ref.js";
// The frozen pre-#450 ToolRef (store legacy oracle): a genuine OLD reader.
import { ToolRef as LegacyToolRef } from "../../daemon/src/store/test-support/fixtures/legacy/schema/tool-ref.js";

const handoff = {
  name: "shell",
  kind: "command" as const,
  use_id: "c1",
  target: "find /repo -name '*.log'",
  status: "ok" as const,
  command_outcome: {
    state: "backgrounded" as const,
    background_reason: "timeout" as const,
    timeout_ms: 30000,
    shell_id: "3",
    pid: 4242,
  },
};

describe("ToolRef command outcome (#450)", () => {
  it("round-trips through ToolRef and HarnessEvent", () => {
    expect(ToolRef.parse(JSON.parse(JSON.stringify(handoff)))).toEqual(handoff);
    const event = { type: "tool_result", session_id: "s", ts: "t", tool: handoff };
    expect(HarnessEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("keeps legacy results unchanged and lets the old reader skip the new facts", () => {
    const legacy = { name: "shell", kind: "command", status: "ok", exit_code: 0 };
    expect(ToolRef.parse(legacy)).toEqual(legacy);
    expect(ToolRef.parse(legacy)).not.toHaveProperty("command_outcome");
    const old = LegacyToolRef.parse(handoff);
    expect(old).not.toHaveProperty("command_outcome");
    expect(old.status).toBe("ok");
  });

  it("refuses malformed facts at the schema boundary", () => {
    for (const command_outcome of [
      { state: "suspended" },
      { state: "backgrounded", pid: 0 },
      { state: "backgrounded", shell_id: "" },
      { state: "timed_out", timeout_ms: -1 },
      { state: "exited", signal: "" },
    ])
      expect(ToolRef.safeParse({ ...handoff, command_outcome }).success).toBe(false);
  });

  it("treats only an observed exit or absent facts as confirmed", () => {
    expect(commandOutcomeUnconfirmed(undefined)).toBe(false);
    expect(commandOutcomeUnconfirmed(null)).toBe(false);
    expect(commandOutcomeUnconfirmed({ state: "exited", signal: "SIGTERM" })).toBe(false);
    for (const value of [
      { state: "backgrounded" },
      { state: "timed_out" },
      { state: "unknown" },
      { state: "suspended" },
      {},
      "exited",
      [],
    ])
      expect(commandOutcomeUnconfirmed(value)).toBe(true);
  });

  it("describes each unconfirmed outcome with one English label", () => {
    expect(commandOutcomeLabel(undefined)).toBeNull();
    expect(commandOutcomeLabel({ state: "exited" })).toBeNull();
    expect(commandOutcomeLabel(handoff.command_outcome)).toBe(
      "Moved to background after 30s · still running · shell 3 · pid 4242",
    );
    expect(commandOutcomeLabel({ state: "backgrounded", background_reason: "timeout" })).toBe(
      "Moved to background after its timeout · still running",
    );
    expect(
      commandOutcomeLabel({ state: "backgrounded", background_reason: "timeout", timeout_ms: 0 }),
    ).toBe("Running in background");
    expect(
      commandOutcomeLabel({ state: "backgrounded", background_reason: "requested", pid: 7 }),
    ).toBe("Running in background · pid 7");
    expect(commandOutcomeLabel({ state: "timed_out", timeout_ms: 90000 })).toBe(
      "Timed out after 1m 30s · exit status unknown",
    );
    expect(commandOutcomeLabel({ state: "timed_out" })).toBe("Timed out · exit status unknown");
    expect(commandOutcomeLabel({ state: "unknown" })).toBe("Command outcome not reported");
    expect(commandOutcomeLabel({ state: "suspended" })).toBe("Command outcome not reported");
  });
});
