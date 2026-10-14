# 03-original-grok

Author: Grok4.7 (independent reviewer).

Subject: 211a8f52acbde19803e9104960639c903c54f752..7cc1eea3b3611cb8f82b81b570f1a87a4684b72b.

This is the full technical response, with only disclosed local-path substitutions. It is historical evidence, not an automatic current approval.

## Summary

Independent read-only review of the frozen tree, not a configured-panel PASS. Stock record `rl-20261013T020818-e5aa30021cfd` still has zero verdicts.

**Subject identity (verified):**
- repo `workspace/lifecycle-43b5-cx-joined`
- HEAD `e18ce620832d38f36d691b8ff78e552789f60b54` (`refs/heads/lifecycle/43b5-joined`)
- index tree = worktree tree = `7cc1eea3b3611cb8f82b81b570f1a87a4684b72b` (empty tree-to-index and tree-to-worktree diffs; unstaged empty)
- reviewed subject is base `211a8f52acbde19803e9104960639c903c54f752` → `7cc1eea`: 143 files, +9692/−412, not only HEAD→tree (21 files)

**CODE: FAIL**
**COUPLING: FAIL**

One reachable contract break on Windows crash recovery. The other named seams hold, including the late-root finality correction and the drain label. The new full-gate failure of `child control frames never invalidate root finality` is a 150ms fixture race, not a product defect, and the red gate is not green.

## Findings

### 1. Windows daemon restart erases recorded leftovers without ending them — CODE and COUPLING

- **Where:** `packages/core/src/process-scope-census.ts` `reapOnce` (census-null return before captured/root groups are used); `packages/cli/src/run-scope-index.ts` `DaemonRunScopeIndex.settle` / `settleDeadOwners` / `retireOrKeep`; contract text in that file’s header, `CLAUDEXOR_BIBLE.md` INV-144, `docs/INTEGRATIONS.md` `daemon/run-scopes.json`.
- **Reachable path:** Windows daemon dies with an open run whose index row already has `captured` / `root_groups`. Next start calls `settleDeadOwners`. `createScopeCensusReader("win32")` is null, so `reapOnce` returns `unsupportedOutcome` immediately and signals nobody. `retireOrKeep` then deletes the row because `census === "unsupported"`, even though `settled` is false.
- **Consequence:** Recorded pids are not `taskkill`’d. After restart, `daemon/run-scopes.json` no longer has them. A host Panic or emergency stop that reads that file, as INTEGRATIONS tells it to, finds no obligation. Startup log line `UNRESOLVED` is not that contract. This is the crash half of owner 1A / INV-144 (“what could not be ended is recorded, not declared clean”), not the accepted “no env census / tree_only / death unprovable” limit.
- **Not this finding:** live-path `taskkill /T` while the parent chain still exists; refusing a bare-pid kill; `completeness: not_provable` on Windows.
- **Minimal remedy:** Do not treat `census === "unsupported"` as retirement. Keep one unresolved row with the recorded pids (skip repeat no-op reaps if already disclosed). Optionally `taskkill /T` those recorded roots and still keep the row, because Windows cannot prove death.

### 2. Full-gate child-frame failure is fixture timing, not a runtime finality bug

- **Where:** `packages/cli/src/run-codex-drain-detail.integration.test.ts` lines 251–254 and 396–406; fixture `packages/harness-codex/fixtures/app-server/drain-holder.mjs`.
- **What the test requires:** quiet mode (pipe stays open), `exitDrainMs: 150`, `exitDrainMaxMs: 500`, and every post-exit frame present in `proc` before a `drain: "truncated"` exit. The holder writes `afterExit`, then the frames, only after it notices the parent died (10ms poll).
- **Why it fails under load:** drain interval is `min(150, 500) = 150ms`. The first tick can destroy the pipe before the holder is scheduled. `afterExit` already exists; frames never arrive; line 398 fails. Production default quiet window is 2000ms (`packages/core/src/proc.ts`), so this does not reproduce the production bound.
- **Product behavior checked:** child `threadId` frames do not own root finality (`ownsNotification` / `codexTeardownFailed`). Already-read complete frames are kept (`process-lines.ts` `stop`). Pipe close is not process death (`aliveAfterDrain`). Unread data after the quiet bound is labeled `output_drain: "truncated"`, not treated as a clean unread success. Do not change production drain to satisfy 150ms.

No second product defect found on the named seams below. I am not calling the uninspected remainder clean.

## Evidence

**Holds, with the code I read:**

- Marker grammar and value `1`; daemon launch sheds `CLAUDEXOR_RUN_SCOPE_*` and keeps an installation marker (`daemonLaunchEnvironment`). `claudexor review --diff` has no run marker; that exception is stated in INV-144. Orchestrator plants the marker through `scopedSpecEnv` / `scopedRouteContext`; `proc.ts` registers it from the composed env. `clean` inheritance forwards scope markers (`env-scope.ts`).
- Root group is recorded from the registry handle at registration, before the lstart refinement. Settlement waits only for that marker’s seeds, then gives the reap the remaining absolute budget (`DaemonRunScopeIndex.settle`). Another run’s seeds are not awaited. Expiry is `incomplete`, not a late signal and not a verdict change.
- Terminal is deferred until `custody.barrier` (`guardAnnouncedRun` `beforeTerminal`). A cancel that arrives during an ordinary run’s barrier does not rewrite a completed verdict (`abortedAtStrategyEnd`). Scope write failure returns null and is not retried (`writeRunScopeFacts`). Verdict is unchanged.
- Detail `summary.processScope` is the compact record only for a terminal run with a valid artifact; otherwise explicit null (`projectProcessScope`). List rows go through `ControlRunSummary.parse`, whose default is null, so list is unknown, not clean. `settled` is known-member settlement; `completeness` is separate. macOS is always `not_provable`. Same-uid Linux environ read failures increment completeness only and are not signalled. That matches quiz 2, not a universal completeness gate.
- Windows completed-answer exception is only `completedAnswer && !cancellation.requested && codexCleanupIsProofLimitation` (empty survivors, every unresolved reason exactly `windows_no_process_group_death_proof`). Survivors, mixed reasons, empty unresolved, and cancellation throw. After `stopProcess`, late root `turn/started` / non-completed `turn/completed`, and `nativeSystemError` set while frames are parsed, still invalidate a candidate answer even if POSIX cleanup reported confirmed death. Child frames do not.
- `output_drain: "truncated"` is set on the Codex completed payload from the proc exit event. It is not a Control schema field; the joined suite, not this review, is the evidence it survives `events.jsonl`. I did not re-run that suite.
- Scoped HOME facts: `CLAUDEXOR_HOME_SCOPED` / `CLAUDEXOR_OPERATOR_HOME`, Playwright cache only when the operator cache exists, explicit `PLAYWRIGHT_BROWSERS_PATH` including `0` wins (owner 3B). In-place HOME gets no facts.

**Owner choices applied:** 1A, 2A is the Ouroboros command rule and is not this tree’s native-command killer, 3B, 4A’s host Panic is outside this tree except for the index the host is told to read, 5C, macOS SIP residual accepted as disclosure not as a false clean, quiz 2 release-after-known-stop with incompleteness disclosed, quiz 3 does not make this review a release PASS.

## Blockers

- I did not execute tests, shell, or the full gate. Parent evidence of 267 focused passes and a red `release:verify` (175 fail + uncaught, canary still red) is not my proof and is not a green baseline.
- Windows and a real daemon crash were not run. Finding 1 is from the control flow, not from a Windows process.
- I did not read every version-bump/changelog line, Swift UI, or every harness spawn site line by line. Marker injection is centralized; I did not prove an unlisted spawn cannot bypass `spec.env`.
- This review is not `review_confirmed` and must not be cited as the stock panel.

## Recommended parent action

Do not publish, pin, or call the joined tree release-qualified. Keep both original PRs. Fix finding 1 in the frozen composition (retain the Windows unresolved pid list; do not delete it on a no-op census), then review that delta. Do not “fix” the 150ms child-frame test by weakening production drain or by claiming the red gate green; if that test stays, give the holder a quiet window it can actually meet, or stop requiring post-exit frames that the 150ms bound is allowed to cut. Host `review_checking.py` was not judged.
