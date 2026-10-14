# 14-small-opus

Author: Claude Opus5.5 (independent reviewer).

Subject: CX9f4bf208..d47e8921 plus OBdd5ae5db..16c205dc; separate subjects and limits stated in each response.

This is the full technical response, with only disclosed local-path substitutions. It is historical evidence, not an automatic current approval.

# Answer

# Final small-delta review: CX two-file delta and OB one-docstring delta

**Bottom line:** no blocking findings. Both deltas pass CODE and COUPLING. I've added four non-blocking wording or doc-alignment advisories, each with a one-clause fix, and one QA residual about the new 30 s hook bound. This was a source-only review: no tests run, not a whole 156/79-file review, no release verdict. The earlier overflowed panel counts only as unavailability.

## Identity and reading gaps

This harness has no shell, so I couldn't run any Git or hash commands.

- **Confirmed from plain-text `.git` files:**
  - CX `HEAD` → `lifecycle/c6-current-composition` = `cb4a9386…`
  - CX `MERGE_HEAD` = `e658c9a4…`, fetched from razzant/claudexor (`FETCH_HEAD`, `MERGE_MSG`)
  - CX forensic ref `refs/ouroboros/recovery/c6-cx-reviewed-9f4` = `7d64a6c9…`
  - OB `HEAD` → `lifecycle/c6-final558` = `558b812f…`
- **Confirmed by direct reads:** the current files contain exactly the patch's new text at all three hunks: `CHANGELOG.md:7`, `pre-progress-refusal.integration.test.ts:32-35`, `process_scope.py:299-304`.
- **Not verified:**
  - the tree IDs `d47e8921`, `9f4bf208` (as the tree of `7d64a6c9`), `16c205dc` and `dd5ae5db`
  - the "exactly two paths" and "only this hunk" claims
  - whether index and worktree match
  - the two patch SHA256s and the blob IDs in the patch headers
- **Not attested locally:** #455 appears in no local plain text (only #453/#454 at `run-codex-drain-detail.integration.test.ts:2`). #454's Windows CI evidence is external. I made no network fetch.
- **Not assessed:** contributor credit for #454/#455.

## CX: `CHANGELOG.md` and `pre-progress-refusal.integration.test.ts`

**CODE: PASS. COUPLING: PASS, with advisories.**

**What supports the pass:**

- **Test hook syntax and value.** vitest is 4.1.10 (`package.json:61`; the run logs show `RUN v4.1.10`), so `afterAll(fn, 30_000)` is a valid hook timeout. 30 s equals the configured per-test allowance (`vitest.config.ts:17`), so the new comment is accurate.
- **Sibling idiom.** The same bound already sits on the same reaper hook in `orchestrator.test.ts:61-63`, `control-api.test.ts:61-63` and `runScope.test.ts:35-38`.
- **Nothing else changed in the test.** Assertions, per-test bounds and the cleanup operation are untouched. The complexity ratchet skips `.test.ts` files (`complexity-ratchet.mjs:44`).
- **Right hook targeted.** Both retained runs failed at this file's own reaper, `:32:1` (`candidate-tests.log:41-50`, `base-tests.log:47-53`), not the global one in `vitest.setup.ts`.
- **#454 sentence matches the code:**
  - The answer is kept only with zero survivors and every unresolved reason being `WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE` (`app-server-threads.ts:22-31`).
  - Cancellation, a missing completed answer, or any other reason throws (`app-server-run.ts:207-213`).
  - Late root lifecycle frames invalidate the answer (`app-server-run.ts:534-538`).
  - It also agrees with `ARCHITECTURE.md:780-787` and `WHITEPAPER.md:437-439`.
- **#455 sentence matches the code.** Only the native COMMIT call is timed (`store.ts:210-217`, `:370-375`; `store-status.ts:51-71`).
- **Version and release tooling.** The root `package.json` version (4.1.1) matches the entry. `release.yml:1164-1169` publishes the whole entry. The 400-character manifest note (`build-runtime-closure.mjs:148`) is unchanged.

**Findings:**

- **CX-1 (advisory, doc coupling).** The two new sentences sit before the lifecycle-only "Disclosed limits: …" and "Verified … real vendor sessions, Windows … were not run before release." So those closing sentences now read as covering #454 (Windows-only) and #455.
  - Fix: move the two sentences after the "Verified …" sentence, each with its own evidence clause, or scope the closing sentences to the process-lifetime work.
- **CX-2 (advisory, wording).** "lifetime native-COMMIT counts" drops a qualifier that every other place keeps. The counters live in memory and reset whenever a store opens (`store.ts:76-82`). The schema says "since this engine store opened" (`store-status.ts:70`), as do `ARCHITECTURE.md:3311-3313` and the CLI's "COMMIT since store open" (`daemon-status-report.ts:57`).
  - Fix: "…native-COMMIT counts and durations since the engine store opened…".
- **CX-3 (nit).**
  - "a late root error" is narrower than the code, which also invalidates on failed or interrupted completions and new root turns (`ARCHITECTURE.md:785-787`).
  - The success path still carries `termination_unconfirmed` (`app-server-run.ts:337`), which the sentence could mention.
- **CX-4 (QA residual, not a code defect): 30 s is unproven.**
  - This hook is synchronous, so vitest flags the timeout only after the deletion loop returns, and the JUnit hook entry records only the whole-suite time (`candidate.junit.xml:40`).
  - Suite time minus summed test time leaves about 25.6 s (base: 235.12 − 209.53) and 27.9 s (candidate: 147.30 − 119.35). That remainder includes this reaper, so the reaper took between 10 s and roughly 26–28 s under the concurrent load. The margin against 30 s may be only a few seconds.
  - The running `d47` `release:verify` decides this. If it trips again, delete each test's own fixtures inside that test rather than raising the bound again.
  - 33 sibling suites still use the default 10 s hook bound. If more of them trip, the single place to fix it is a global `hookTimeout` next to `testTimeout`. Not needed now.

## OB: `end_scope` docstring in `process_scope.py`

**CODE: PASS. COUPLING: PASS, with one advisory.**

**The new text is accurate for all three production callers:**

- `:713`, task cleanup: markers, groups and saved members, so a census runs.
- `:914`, installation pass: marker and groups, so a census runs.
- `:1021`, the ordinary-start known-only retry: saved identities only.
  - `:320` sets `rows = {}`, so `census_failed` is never set.
  - Unreadable addressed reads become `identity_unreadable` (`:248-253`, `:339`), so the outcome is not settled (`:362-363`).

The old text ("settled is true only with a readable census") was false for `:1021`, and for an empty request, which is settled without any census. "Readable" still means the table could be read, not that discovery was complete (`process_census.py:226-233`), which is consistent with owner choice 05ed.

On Ouroboros governance:
- The text is English and replaces the old description in place (`02-naming-and-boundaries.md:9,136-137`).
- It is consistent with the owning docs: `09-shutdown-and-process-cleanup.md:29,45`, `PERSISTENCE.md:85` and `09-process-custody-rule.md:3`.
- The line count is unchanged in a file already listed in the size band (`size_ratchet_manifest.py:142`).

**Findings:**

- **OB-1 (advisory, same-file sibling, pre-existing).** The module docstring at `:21-23` still says `panic_sweep_pending` retires only on "census readable, the engine index absent or read". The ordinary-start retry contradicts that:
  - It reads no census.
  - It records `engine_index: {"status": "not_read"}` (`:1023`).
  - It still retires through `_settle_pending_record` (`:942-953`).

  This is the same class of claim this delta fixes.
  - Fix, one clause: "…SETTLED — the requested discovery readable (an installation pass also needs the engine index absent or read; a later start retries only saved identities), no survivor, no unverified member — …". The `settle_task_scope` wording at `:681-682` is correct for its caller and can stay.
- **OB-nit.** "requested discovery" is a coined phrase. An optional parenthetical, "(census for a marker or group; addressed pid+birth reads for saved identities)", would define it. The inline comment at `:320` already says this.

## What I did not do

I did not write a plan file or any other file; the host contract forbids writes, so this review is delivered inline.
