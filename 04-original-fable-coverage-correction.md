# 04-original-fable-coverage-correction

Author: Ouroboros supervising Fable (supervisor verification, not another reviewer).

Subject: 211a8f52acbde19803e9104960639c903c54f752..7cc1eea3b3611cb8f82b81b570f1a87a4684b72b.

This is the full technical response, with only disclosed local-path substitutions. It is historical evidence, not an automatic current approval.

## Summary

The configured Fable review completed. Its original judgments remain:

- **CODE: PASS with non-blocking findings.**
- **COUPLING: PASS with stated residuals.**
- **Release qualification: RED.**

These are **Fable’s attributed judgments**, not a consensus or release approval. My absorption is **DEGRADED for complete-subject coverage**: its claimed 137-file patch parity does not establish coverage of the actual **143-file** base-to-worktree contribution. I do not rewrite its PASS, but I cannot use it to overrule the later Astra findings communicated by the parent.

**Subject:** base `211a8f52acbde19803e9104960639c903c54f752` to tree `7cc1eea3b3611cb8f82b81b570f1a87a4684b72b`, workspace `workspace/lifecycle-43b5-cx-joined`. I independently confirmed an empty tree-to-worktree diff against `7cc1eea…` and 21 staged paths. The source remained frozen.

## Findings

1. **Reading-coverage correction — confirmed.**  
   Actual `vcs_diff(base=211a8f…, stat=true)` reports **143 files, 9,692 insertions and 412 deletions**, whereas Fable reports parity across 137 retained-patch files. The affected missing-file set was not resolved. Its full-patch claim is therefore not exact whole-subject coverage proof.

2. **Windows release-note omission — confirmed.**  
   `CHANGELOG.md:7` explains custody and the bounded drain but does not describe the completed-answer exception for Windows proof-only uncertainty or the public `output_drain: "truncated"` disclosure. This is a documentation delta, not evidence that the product behavior fails.

3. **Branch-pinned CI control — confirmed, not automatically dead code.**  
   `.github/workflows/ci.yml:353–382` is restricted to the original Windows454 branch and fixed baseline. Fable recommends removing or parameterizing it. The parent subsequently explained that this was an intentional historical control. Preserve that rationale; removal is a publication decision, not a necessary product repair. The subsequent credential-free cleanup suites remain separate.

4. **Windows model-auth sibling — source-supported, pre-existing residual.**  
   `refreshCodexModelAuth` sets `unconfirmed` on cleanup uncertainty and rejects at `model-auth.ts:189`, even after receiving the account response. The Windows reaper’s ordinary successful-root outcome carries the typed proof limitation (`process-tree.ts:381–397`). This supports Fable’s sibling-surface concern, but the file is unchanged by this contribution. **Do not expand the current repair into it.**

5. **Unresolved startup custody — persistence confirmed; suggested remedy rejected.**  
   `settleDeadOwners` reattempts retained unresolved entries; `retireOrKeep` removes only settled or unsupported entries (`run-scope-index.ts:366–424`). A growing set can increase startup work. Fable’s proposed retirement after a number of starts would abandon known unresolved custody without establishing settlement. I do **not** endorse that remedy; the parent independently rejected it.

6. **Short-path child-frame failure — plausible fixture race, not proved attribution.**  
   The holder polls root death before emitting frames and suppresses pipe-write errors (`drain-holder.mjs:9–39`). The fixture uses a **150 ms quiet / 500 ms absolute** drain (`run-codex-drain-detail.integration.test.ts:253–254`) but asserts every planned frame was received at line398. The product contract preserves already-read frames, not frames an unscheduled holder has yet to write. These anchors support a scheduling explanation, but do not prove the missing frames arrived only after closure. **The failed case stays RED; Fable’s categorical “product promise was kept” is stronger than the available observation.**

Fable additionally reports real-census overhead in unrelated orchestrator tests, a CONCEPT-CHANGE marker verification item, marker-shedding asymmetry and minor coverage-label accuracy. Performance causality and production latency were not independently established here.

**Astra challenge:** I have no exact-source rebuttal to its five findings. The parent communicated validation of PGID/birth conflation and seen suppression, unmarked gate environments, eager deadline reads and stopped-reader exception handling. I did not finish reading Astra’s complete envelope, so I neither reproduce its findings as my own verification nor use Fable’s earlier clean assertions to dismiss them.

## Evidence

- Read the complete standalone `CX-REVIEW-BRIEF.md`.
- Read the **entire 88-line terminal envelope**, including Fable’s untruncated **10,920-byte** answer.
- Independently inspected the finding anchors listed above and verified the current worktree against the designated tree.
- Fable reports reading the retained full patch, repository Bible/Development/Checklists, final core source and consumer/spawn searches. Its own limits include hunk-only inspection of generated schemas, `run-scope-index.ts` and most of `orchestrator.ts`; no visible commit messages; and no execution.

**Full unchanged handoff retained at:**

`retained-evidence/2345493e/source_handles/tool_results/delegated-run-run-2fb4a10d2c39-58198f99e0b43078184cfcd0e49a4e0a5052d4879fef6fa4f2d2453add334b54.json`

Envelope SHA-256: `58198f99e0b43078184cfcd0e49a4e0a5052d4879fef6fa4f2d2453add334b54`.

Run `run-2fb4a10d2c39` settled successfully with verified read-only access. Requested `ultra` resolved to vendor `max`. Engine-reported incremental cash charge was $0; nanny-round cash cost is unknown.

## Blockers

- Long-path full release gate and canary remain RED; the short-path gate also failed. Neither timing hypotheses nor this source review make them green.
- No native Windows/Linux qualification, live vendor/account acceptance, Panic execution, SQL worker E2E or replay of all 23 retained HTTP bodies was performed by this review.
- Exact commit-message/CONCEPT-CHANGE compliance and complete 143-file reading coverage remain outside this handoff.
- The failed stock review remains a zero-verdict transport failure, not a replaced or relabeled PASS.

## Recommended_parent_action

Preserve Fable’s original PASS judgments and their exact evidence, alongside the coverage correction and Astra’s contrary findings. Continue the already-started isolated repair without changing this reviewed source. Keep unresolved custody, the pre-existing auth-refresh residual and RED QA honest; address documentation/publication details separately. Obtain exact-subject coverage for the repaired bytes before release. No further leaf or independent full review was started here.
