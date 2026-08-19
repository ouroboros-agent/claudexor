import { describe, expect, it } from "vitest";
import {
  resolveRunAccess,
  runAccessStrategyViolation,
  runControlApplicability,
  runExecutionWorkspaceViolation,
  runStartRequiresGit,
  runStartStrategyViolations,
} from "./run-strategy.js";

describe("run access and strategy", () => {
  it("resolves explicit and configured Agent access while clamping Ask and Plan", () => {
    expect(resolveRunAccess({ mode: "agent", access: "readonly" }, "full")).toEqual({
      requested: "readonly",
      effective: "readonly",
    });
    expect(resolveRunAccess({ mode: "agent" }, "full")).toEqual({
      requested: "full",
      effective: "full",
    });
    expect(resolveRunAccess({ mode: "ask", access: "full" }, "workspace_write")).toEqual({
      requested: "full",
      effective: "readonly",
    });
    expect(resolveRunAccess({ mode: "plan" }, "workspace_write")).toEqual({
      requested: "readonly",
      effective: "readonly",
    });
  });

  it("refuses patch convergence only when effective access is readonly", () => {
    expect(runAccessStrategyViolation({ attempts: 3 }, "readonly")).toMatchObject({
      code: "strategy_access_incompatible",
      message: expect.stringMatching(/readonly/),
      retryable: false,
    });
    expect(runAccessStrategyViolation({ untilClean: true }, "readonly")).toMatchObject({
      code: "strategy_access_incompatible",
      message: expect.stringMatching(/readonly/),
      retryable: false,
    });
    expect(runAccessStrategyViolation({}, "readonly")).toBeNull();
    expect(runAccessStrategyViolation({ attempts: 3 }, "workspace_write")).toBeNull();
    expect(runAccessStrategyViolation({ untilClean: true }, "full")).toBeNull();
  });

  it("never requires Git for explicit or configured readonly access", () => {
    expect(
      runStartRequiresGit(
        { mode: "agent", access: "readonly", execution: { isolation: "envelope" } },
        { effectiveWorkspaceRequiresGit: true },
      ),
    ).toBe(false);
    expect(
      runStartRequiresGit(
        { mode: "agent", execution: { isolation: "envelope" } },
        { accessDefault: "readonly", effectiveWorkspaceRequiresGit: true },
      ),
    ).toBe(false);
    expect(
      runStartRequiresGit(
        { mode: "agent", execution: { isolation: "envelope" } },
        { accessDefault: "workspace_write" },
      ),
    ).toBe(true);
  });

  it("requires an execution tree only for fresh delegated live writes", () => {
    const delegatedLive = {
      mode: "agent" as const,
      execution: { isolation: "live" as const, delegated: true },
    };
    expect(runExecutionWorkspaceViolation(delegatedLive, "workspace_write")).toMatchObject({
      code: "execution_workspace_required",
      retryable: false,
    });
    expect(runExecutionWorkspaceViolation(delegatedLive, "full")).toMatchObject({
      code: "execution_workspace_required",
    });
    expect(runExecutionWorkspaceViolation(delegatedLive, "readonly")).toBeNull();
    expect(
      runExecutionWorkspaceViolation(
        { ...delegatedLive, execution: { ...delegatedLive.execution, workspaceRoot: "/snapshot" } },
        "workspace_write",
      ),
    ).toBeNull();
    expect(
      runExecutionWorkspaceViolation({ ...delegatedLive, retryOf: "run-old" }, "workspace_write"),
    ).toBeNull();
  });
});

describe("run-control applicability", () => {
  it.each(["ask", "plan"] as const)(
    "makes reviewers and protected-path approvals unavailable on %s",
    (mode) => {
      const applicability = runControlApplicability({ mode });
      expect(applicability.reviewerPanel).toMatchObject({ applicable: false });
      expect(applicability.protectedPathApprovals).toMatchObject({ applicable: false });
      expect(applicability.reviewerPanel.reason).toMatch(/Agent/);
      expect(applicability.protectedPathApprovals.reason).toMatch(/read-only/);
    },
  );

  it("keeps every review control applicable on Agent", () => {
    expect(runControlApplicability({ mode: "agent" })).toEqual({
      reviewerPanel: { applicable: true },
      protectedPathApprovals: { applicable: true },
    });
  });

  it.each(["ask", "plan"] as const)(
    "refuses every meaningful reviewer/approval representation on %s",
    (mode) => {
      const violations = runStartStrategyViolations({
        mode,
        reviewerPanel: [{ harness: "codex" }],
        reviewerModels: { openai: "gpt" },
        reviewerEfforts: { openai: "high" },
        protectedPathApprovals: [{ path: "test/**" }],
      });
      expect(violations).toEqual([
        expect.stringContaining("reviewerPanel"),
        expect.stringContaining("reviewerModels"),
        expect.stringContaining("reviewerEfforts"),
        expect.stringContaining("protectedPathApprovals"),
      ]);
    },
  );
});
