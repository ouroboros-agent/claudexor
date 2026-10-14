# 16-final-prose-opus

Author: Claude Opus5.5 (independent reviewer).

Subject: Final CX release-note and OB header correction; accepted wording applied without runtime change.

This is the full technical response, with only disclosed local-path substitutions. It is historical evidence, not an automatic current approval.

# Answer

# Prose corrections: Ouroboros PASS with one named residual, Claudexor PASS with one omission and one release-time obligation

Both live files contain exactly the post-images in `final-prose-ob.patch` and `final-prose-cx.patch`, and both branch refs are unchanged (Ouroboros (OB) `558b812f`, Claudexor (CX) `cb4a9386`). I had no shell, so I could not recompute the trees `d333da2c` and `2ae66053` or the patch and file SHA256s.

## OB: `process_scope.py` module header and `settle_task_scope` docstring

**CODE: PASS.** Only docstrings changed. File length grows by one line and stays within its existing size band. The long lines (110 and 118 characters) are under ruff's 120 limit, and E501 is ignored anyway (`pyproject.toml:151,156`).

**COUPLING: PASS with one named residual.** This closes my earlier OB-1 and the basis of Astra's FAIL. The new claims match the code:
- **Retirement:** a pending obligation retires only on a recorded outcome that is either settled or unsupported. See `process_scope.py:722-725` for task scopes and `:946-953` for the Panic record. An unreadable Panic record never retires (`:1026-1028`).
- **Engine index:** only installation-wide Panic reads it and requires it absent or read (`:911`, `:919`). Its callers are `:988` and `:1019-1020`.
- **Known-only Panic retry at startup:** it reads saved identities only. No census runs (`:320`) and the index is recorded as `not_read` (`:1021-1023`).
- **The new `settle_task_scope` text** matches `:714-725`. "Except denied signals" can only qualify unverified members, because a denied signal is never classed as a survivor.

**Residual, prose only:** "Ordinary startup checks saved identities without either discovery source" (line 24) is true only for the pending Panic retry (`server.py:1666` → `:176` → `:1021`). Ordinary startup also runs the task-scope sweep (`server_maintenance.py:887-891` → `settle_task_scopes`). That sweep does discover by marker and group (`:714-716` → census), and the same paragraph names task scope records.
- One-clause fix: "Ordinary startup retries a pending Panic's saved identities without either discovery source."

## CX: `CHANGELOG.md` v4.1.1 entry

**CODE (accuracy): PASS.**
- **#454:** the exclusions match `app-server-threads.ts:51-68` and `app-server-run.ts:529-538`. The `termination_unconfirmed` record staying on the completed payload matches `app-server-run.ts:337`, and the tests check it (`codex-cleanup-review.test.ts:101-109`, `run-codex-drain-detail.integration.test.ts:529-533`).
- **#455:** "since the engine store opened" matches `store-status.ts:70`, `ARCHITECTURE.md:3311-3313` and the CLI text.
- **Opening sentence:** the narrowing to "scoped cleanup" is consistent with the stated limits.

**COUPLING: PASS, with one omission and one release-time obligation.** This closes my earlier CX-1, CX-2 and CX-3.
1. **Dropped disclosure.** The old closing sentence said "a real daemon crash and restart were not run before release". The new one drops it, yet the entry still promises cleanup "at the next start after a crash". Unless crash and restart have since been exercised (nothing in the bindings says so), add it back:
   - "…native Windows matrix, real vendor-session acceptance and a real daemon crash-and-restart remain unverified."
2. **"The release candidate is still under qualification."** This is accurate now. But `release.yml:1164-1169` publishes the entry verbatim as the release notes, and `CHECKLISTS.md:362` says release notes describe shipped behavior. The sentence must be removed or replaced at the release edit.
3. **Optional nit:** `termination_unconfirmed` is a payload record, not a warning event. "record" would be more exact.

I could not check #454's "credential-free native Windows qualification" locally.

## Earlier verdicts and QA, kept separate

My earlier small-delta verdicts stand. The 30 s hook remains correct as code, with an accurate comment and the same pattern as sibling suites. However, the new d47 evidence shows it failing in the full gate: that hook, 7 other teardown hooks and 3 tests. That turns my earlier "30 s unproven" residual into an observed failure; it is a QA matter outside this prose review. I did not assess the OB parallel results (18 failures, 13 matching base). Nothing here is a release or publication approval.
