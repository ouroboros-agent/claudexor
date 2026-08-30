import { describe, expect, it } from "vitest";
import { RunOutcomeFacts } from "@claudexor/schema";
import { cancelReasonFromSignalToken } from "./runTerminals.js";

describe("cancelReasonFromSignalToken (X-5)", () => {
  it("maps the typed tokens and coerces everything else to user_cancelled", () => {
    expect(cancelReasonFromSignalToken("wall_clock_exceeded")).toBe("wall_clock_exceeded");
    expect(cancelReasonFromSignalToken("host_cancelled")).toBe("host_cancelled");
    expect(cancelReasonFromSignalToken("owner_task_gone")).toBe("owner_task_gone");
    // Wire compatibility: a bare abort, free text, or a non-string reason all
    // keep the historical user_cancelled coercion.
    expect(cancelReasonFromSignalToken(undefined)).toBe("user_cancelled");
    expect(cancelReasonFromSignalToken("ctrl-c on the waiting CLI")).toBe("user_cancelled");
    expect(cancelReasonFromSignalToken(new Error("x"))).toBe("user_cancelled");
  });

  it("the new reasons are admitted on a cancelled lifecycle", () => {
    for (const reason of ["host_cancelled", "owner_task_gone"] as const) {
      const facts = RunOutcomeFacts.parse({
        lifecycle: "cancelled",
        noChanges: true,
        checks: "not_configured",
        review: "not_run",
        reason,
      });
      expect(facts.reason).toBe(reason);
    }
  });
});
