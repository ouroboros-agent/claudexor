import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@claudexor/schema";
import { buildRevisePrompt } from "./revisePrompt.js";

const finding = {
  severity: "BLOCK",
  status: "open",
  category: "correctness",
  claim: "off-by-one in the retry window",
  evidence: { files: [{ path: "src/retry.ts", lines: "12-18" }] },
  proposed_fix: "clamp the window",
} as unknown as ReviewFinding;

describe("revise prompt contract (a blocked attempt must not just re-emit)", () => {
  const prompt = buildRevisePrompt("do the thing", [finding], "");

  it("names the three legitimate moves and says repeating the work changes nothing", () => {
    expect(prompt).toContain("three legitimate moves");
    expect(prompt).toContain("fix it");
    expect(prompt).toContain("rebut it with evidence showing the finding is wrong");
    expect(prompt).toContain("unreachable in this environment");
    expect(prompt).toContain("name the concrete gap");
    expect(prompt).toContain("Re-emitting the same work with none of those three changes nothing");
  });

  it("requires checking a finding's own justification before complying with it", () => {
    expect(prompt).toContain("hypothesis with an argument attached");
    expect(prompt).toContain("does not survive checking must be rebutted, not complied with");
  });

  it("requires re-reading the diff and grouping by root cause instead of one-at-a-time patching", () => {
    expect(prompt).toContain("Do not patch findings one at a time");
    expect(prompt).toContain("group the findings by root cause");
  });

  it("requires a per-finding accounting line with concrete evidence before the deliverable", () => {
    expect(prompt).toContain("Before the deliverable");
    expect(prompt).toContain("one short line per finding");
    expect(prompt).toContain("a file and line, a symbol, or a test name");
  });

  it("keeps the base prompt, the rendered findings, and appended runtime errors", () => {
    expect(prompt.startsWith("do the thing\n\n")).toBe(true);
    expect(prompt).toContain("off-by-one in the retry window");
    expect(prompt).toContain("src/retry.ts");
    const withErrors = buildRevisePrompt("do the thing", [finding], "\n\nRuntime errors:\n- boom");
    expect(withErrors.endsWith("\n\nRuntime errors:\n- boom")).toBe(true);
  });
});
