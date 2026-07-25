import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "./reviewPrompt.js";

const patch = {
  diffPath: "/evidence/DIFF.patch",
  summaryPath: "/evidence/DIFF_SUMMARY.md",
  diffSha256: "sha256:test",
  summary: "(plan review — no code diff)",
};

describe("typed review subject", () => {
  it("does not ask plan reviewers to find missing implementation/screenshots", () => {
    const prompt = buildReviewPrompt("Plan", "/candidate", "/evidence", patch, false, "plan");
    expect(prompt).toContain("READ-ONLY PLAN");
    expect(prompt).toContain("absence is NOT a finding");
    expect(prompt).toContain("PLAN_ACCEPTED.md");
    expect(prompt).toContain("do not demand a code diff");
  });
});

describe("finding-discipline rules (pinned clause by clause)", () => {
  // Every reviewer spawn gets these, regardless of subject or sealed mode.
  for (const [name, built] of [
    ["code", buildReviewPrompt("Cand", "/candidate", "/evidence", patch)],
    ["sealed code", buildReviewPrompt("Cand", "/candidate", "/evidence", patch, true)],
    ["plan", buildReviewPrompt("Plan", "/candidate", "/evidence", patch, false, "plan")],
  ] as const) {
    it(`tells the ${name} reviewer that severity is authoritative and prose hedges are ignored`, () => {
      expect(built).toContain("severity is the authoritative signal");
      expect(built).toContain(
        "A hedge, caveat, or withdrawal written inside claim or proposed_fix",
      );
      expect(built).toContain("never left at a blocking severity");
    });

    it(`tells the ${name} reviewer not to re-raise one root cause as two findings`, () => {
      expect(built).toContain("One root cause is one finding");
      expect(built).toContain("under different wording");
    });

    it(`tells the ${name} reviewer to ground findings in the patch and to flag contradictions`, () => {
      expect(built).toContain("grounded in the current patch or in artifacts under Candidate root");
      expect(built).toContain("Do not manufacture a finding from");
      expect(built).toContain("that contradiction is itself the finding");
    });

    it(`tells the ${name} reviewer to state checkable reasoning, not only a conclusion`, () => {
      expect(built).toContain(
        "State the reasoning that makes the claim true, not only the conclusion",
      );
      expect(built).toContain(
        "proposed_fix whose own justification does not survive checking is worse than no finding",
      );
    });
  }
});
