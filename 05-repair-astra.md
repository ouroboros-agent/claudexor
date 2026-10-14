# 05-repair-astra

Author: GPT-6-Astra (independent reviewer).

Subject: 7cc1eea3b3611cb8f82b81b570f1a87a4684b72b..fad717ad8a5c6890084a96640666366b5897bda6.

This is the full technical response, with only disclosed local-path substitutions. It is historical evidence, not an automatic current approval.

# Answer

**CODE: FAIL. COUPLING: FAIL.** Four earlier Astra findings are closed in the inspected source. Finding 4’s direct-call defect is repaired, but the deadline contract remains incomplete across census readers and pending seed refinements. This is one remaining P2 defect class, not two independent findings. No separate regression attributable to the 29-file repair was established.

Reviewed subject, verified unchanged and clean at completion:

- HEAD: `d35e6ed8a7cf937f33f3f2fcc052e3a18314fed8`
- Tree: `fad717ad8a5c6890084a96640666366b5897bda6`
- Repair: `7cc1eea3b3611cb8f82b81b570f1a87a4684b72b` → `fad717ad…`: **29 files, +966/−97**.
- Full contribution: `211a8f52acbde19803e9104960639c903c54f752` → `fad717ad…`: **156 files**.

**Remaining P2: settlement expiry does not stop later work inside an admitted census or seed job.** The repaired [lazy deadline wrapper](workspace/lifecycle-43b5-cx-repair-r1/packages/core/src/process-scope-census.ts:354) correctly prevents new outer reader calls after expiry. It does not communicate expiry to those readers or to seed refinements. Two supported paths remain:

1. **Default census reader.** Normal daemon settlement supplies the run’s opening time, so macOS census first awaits an age listing and then starts an environment listing. The second `ps` starts unconditionally after a nonempty or failed age listing in [createDarwinScopeCensusReader](workspace/lifecycle-43b5-cx-repair-r1/packages/core/src/process-scope-readers.ts:290). The reader’s timeout is 10 seconds; the default settlement budget is 5 seconds. Thus a delayed age listing, including its own timeout, can cause a fresh environment-reading process to start after settlement returns. Separately, [CoalescingCensus.drain](workspace/lifecycle-43b5-cx-repair-r1/packages/core/src/process-scope-readers.ts:143) retains expired callers and starts their queued scan when the preceding scan finishes. Linux’s bounded-concurrency loop likewise continues admitting later `/proc` reads without expiry information.
2. **Daemon seed refinement.** Production child registration calls `seedRoot`. [seedsSettled](workspace/lifecycle-43b5-cx-repair-r1/packages/cli/src/run-scope-index.ts:208) bounds the wait with `Promise.race`, but leaves each job active. If its pending table read later returns a valid row, [seedRoot](workspace/lifecycle-43b5-cx-repair-r1/packages/cli/src/run-scope-index.ts:158) starts another identity read and can subsequently persist refinement after settlement has returned. There is no continuation expiry check.

These are fresh operations after expiry, not merely previously started I/O finishing. The consequence is helper creation and discovery/refinement work beyond the documented boundary, including obsolete requests occupying the shared scanner. This contradicts the explicit [“no read starts after” deadline contract](workspace/lifecycle-43b5-cx-repair-r1/docs/ARCHITECTURE.md:3118). I do **not** infer late signals to scope members, a false settled receipt, lost substantive output, or checking-copy corruption: the inspected reaper guards still prevent those late member signals and disclose incompleteness.

Minimal correction: propagate the settlement’s absolute expiry into seed continuations and census request ownership. Check it before each subsequent read; discard expired queued requests. Shared scans must continue when a live caller still needs them.

Distinguishing tests, **specified but not executed**:

- Hold the real Darwin reader’s injected age-list runner beyond the outer deadline; after settlement returns, release a nonempty result or failure. Assert that no environment `ps` starts. Current source starts it.
- Queue a second, subsequently expired settlement behind a held shared scan. Releasing the first must not start a scan solely for expired callers.
- Extend the existing [hung-seed test](workspace/lifecycle-43b5-cx-repair-r1/packages/cli/src/run-scope-index.test.ts:395) by releasing a valid row after settlement returns; assert that no further identity read starts. Its current never-resolving promise cannot detect this continuation.

The reader and seed paths already existed before the repair. This is newly traced evidence that the prior deadline finding is not fully closed, rather than an allegation that the diagnostic-only index edit introduced them.

| Earlier Astra finding | Disposition on `fad717ad…` |
|---|---|
| 1. PGID change mistaken for process death | **Closed.** `compareProcessBirth` separates process identity from group authority. Census membership/probes use birth identity; whole-group signalling retains the stricter group comparison. Regroup-on-TERM, surviving regrouped members, admission bracketing, different births and stale-group refusal are covered by inspected controls. Retained native RED/GREEN traces support the repair. PID reuse within one settlement window remains unproven, not ruled out. |
| 2. Run-owned deterministic gates lack the run marker | **Closed for the identified paths.** Candidate gates, final verification, adoption and convergence receive marked gate specs; `runGate` merges their fixed environment into the clean spawn environment. The real descendant regression checks candidate and final-verification leftovers at the run barrier. No per-command cleanup was introduced. |
| 3. Drain diagnostics disappear in consumers | **Closed on the identified surfaces.** `runCapture` preserves drain state; shared runloop and ACP completed events expose `output_drain`; retained failed/timed-out gate output sets `output_truncated`. Passed gates deliberately store no output. Source/generated schema descriptions agree. Codex/event serialization retains the field. |
| 4. Reads begin after settlement deadline | **Partially closed; FAIL remains.** Lazy outer calls and post-sleep checks fix the reported direct-call cases. The nested, queued and seed-continuation paths above remain. |
| 5. Forced drain suppresses validation failures | **Closed in r2.** Suppression is limited to `ERR_STREAM_PREMATURE_CLOSE` after stopping. Invalid UTF-8, oversized frames, stdout/stderr EIO and consumer callback failures remain failures. Both expected-close and valid-frame controls were inspected. Retained r2 falsification evidence corrects r1’s broader suppression claim. |

**Windows disposition:** no new production finding established from the injected known-root fixture. [registerChildProcess](workspace/lifecycle-43b5-cx-repair-r1/packages/core/src/process-registry.ts:39) publishes only a successfully measured default group identity; the default Windows identity reader returns unsupported. The opt-in Windows reader’s inspected production callers are setup-login/setup-job paths, not the run-scope registry. I found no supported connection from those callers to persisted `root_groups`. The repair explicitly discloses retirement without proof and does not change retention policy. This does not establish native Windows correctness or authorize a reader/policy expansion.

**Changed fixture disposition:** the new hold orders arrival of benign frames before root exit, then waits for the descendant’s late-write acknowledgement before releasing the reader. Assertions preserve `held → direct exit → release → drained → settlement → terminal`. Root error/interrupted/failed/new-turn frames remain negative; child-owned equivalents remain positive. After-closure output is explicitly absent and truncation remains disclosed. Finite, continuous, split-buffered, stalled-descendant, receipt-write-failure, cancellation, survivor, mixed-uncertainty, empty-uncertainty and empty-answer controls were inspected.

The fixture strengthens ordering without establishing a broader transport guarantee. Most joined late-frame cases inject the bounded reader; the added production-readline case has no late frames. It uses real child pipes and HTTP detail projection with a daemon facade and cleanup seams. It is not native Windows, a full SQL-daemon run, or a real vendor session.

Other inspected coupling remains consistent with the accepted choices: settlement and the single receipt attempt precede terminal publication; write/schema failure preserves the substantive verdict and projects explicit null. The selected Ouroboros consumer distinguishes omitted `processScope` from explicit null, uses settlement independently of completeness, preserves captured evidence/verdicts, and refuses the next thread turn without a quiescent capture. Native command descendants are tied to task completion, not each command. Scoped HOME/cache precedence and marker forwarding were traced. The inspected Panic path starts its own requests and bounded exit independently of the Claudexor run barrier; its timing was not executed or measured.

**Coverage is delta-complete, not a fresh line-by-line audit of all 156 files.** I read the complete standalone brief, r1/r2 handoffs, the actual prior Astra response, all 29 repair diffs, enclosing production logic and relevant callers. Exact repaired paths, grouped by directory:

| Directory | Files inspected in the repair |
|---|---|
| Root/docs | `CHANGELOG.md`; `docs/ARCHITECTURE.md` |
| `packages/cli/src` | `run-codex-drain-detail.integration.test.ts`; `run-scope-index.test.ts`; `run-scope-index.ts` |
| `packages/core/src` | `proc.ts`; `process-identity.ts`; `process-identity.test.ts`; `process-lines.ts`; `process-lines.test.ts`; `process-registry.test.ts`; `process-scope-census.ts`; `process-scope-census.test.ts`; `runloop.ts`; `runloop.test.ts` |
| `packages/harness-acp` | `fixtures/agent.mjs`; `src/adapter.test.ts`; `src/run.ts`; `src/transport.ts` |
| `packages/harness-codex` | `fixtures/app-server/drain-holder.mjs` |
| `packages/orchestrator/src` | `contract-gates.ts`; `contract-gates.test.ts`; `orchestrator.ts`; `runScope.ts`; `runScope.test.ts` |
| `packages/review/src` | `gates.ts`; `review.test.ts` |
| `packages/schema` | `src/gate.ts`; `generated/GateResult.schema.json` |

All new negative-control source in those diffs was inspected. Additional current-source tracing covered census readers, identity/group registration, environment propagation, Codex teardown, delivery verification, terminal custody, event serialization, schemas/detail projection, daemon wiring and startup recovery. The bounded host counterpart was tree `a02b751917d3a5d31d90f2a65001709275c6f380`.

I enumerated the full 156-file contribution. For its 127 paths unchanged by this repair, coverage combines selective current-source tracing with **attributed** prior Astra inspection; I do not claim a fresh complete reread of every historical test or changelog. Relevant governance and own-body SYSTEM/BIBLE excerpts plus DESIGN navigation were read; no reference-book projection was supplied. No broad Desktop audit was repeated.

**QA remains RED, independently of the source finding.** I read the supplied status/log and independently counted the exact-candidate JUnit: **8,081 cases; 8,067 passing, 1 failing, 13 skipped**. `release:verify` exited 1 at `2026-10-13 08:17:21 UTC`. The sole failure is the catalog-refusal wait in `model-services.test.ts:213`, where the operation remained running; its cause is **UNKNOWN**. The subsequent `&&` gates did not execute. Earlier plugin/late-frame failures did not recur in this run; that establishes only this run’s result. [Gate status](retained-evidence/43b5d75c891f4f36-c10c33e8bf62bdcfb/short-cx-gate/status.json), [JUnit](retained-evidence/43b5d75c891f4f36-c10c33e8bf62bdcfb/short-cx-gate/tests.junit.xml).

Retained focused passes overlap and do not replace full qualification. Earlier failures remain historical evidence. Native Linux/Windows and account-backed installed qualification were not performed here; release/pin/signature work is not approved by this review. The first interrupted attempt remains **NOT ASSESSED / zero source coverage**, and the earlier Astra FAIL remains historical. This result is an independent source-review FAIL, not a configured-panel result.

No files or history were changed. No tests, product code, model checks, account/engine operations, publication or further delegation were performed.
