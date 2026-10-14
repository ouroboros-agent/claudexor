# 02-original-fable

Author: Claude Fable5.1 (independent reviewer).

Subject: 211a8f52acbde19803e9104960639c903c54f752..7cc1eea3b3611cb8f82b81b570f1a87a4684b72b.

This is the full technical response, with only disclosed local-path substitutions. It is historical evidence, not an automatic current approval.

# Answer

Final check done: the diff-review CLI calls `reviewDiff`, not `run()`, so it has no custody at all, which matches the disclosed exception. I have what I need; no further reads are required. Review follows.

## Verdicts

**Subject.** Base 211a8f52acbde19803e9104960639c903c54f752 to index/worktree tree 7cc1eea3b3611cb8f82b81b570f1a87a4684b72b at workspace/lifecycle-43b5-cx-joined, HEAD e18ce620832d38f36d691b8ff78e552789f60b54 with 21 staged paths. The retained leaf patch and the nanny's integrated patch list the same 137 files with identical per-file hunk sizes. I read the whole leaf patch and then read the final bytes of the core product files directly in the tree. They match the patch.

**CODE: PASS with non-blocking findings.** I found no reachable defect on a default-configuration path that violates an invariant or an owner decision. The seams named in the brief hold in source. Findings 1 to 5 below are hygiene, class and robustness items, none of which changes a verdict or a delivered answer.

**COUPLING: PASS with two stated residuals.** Cross-module intent is coherent: marker minted before launch, carried through every production spawn route, terminal held through settlement and one record attempt, explicit API null, Windows exception bounded to exact root finality plus proof-only uncertainty, late root frames rechecked on confirmed POSIX death. The residuals are the unrepaired sibling surface in the Codex auth refresh (finding 2) and the measurable per-run census cost that now sits inside every orchestrator run, tests included (finding 4).

**Qualification stays RED.** Nothing here implies full qualification. The joined suite passed 23/23 in the long path and 22/23 in the short path for a fixture-timing reason analysed below.

## Findings

1. **One-off branch-pinned CI step** (`.github/workflows/ci.yml` lines 353 to 382). The baseline-reproduction step runs only when the PR head ref equals one historical branch name and fetches a hard-coded base SHA. It will never run for the joined PR or any later PR, so it is dead scratch in the permanent Windows job. Remedy: drop it before release or move it behind a dispatch input; keep the following step, which runs the three credential-free cleanup suites. Classification: accepted, minor.

2. **Same failure class on a second surface** (`refreshCodexModelAuth` in packages/harness-codex/src/model-auth.ts, lines 159 to 189). It still treats any unconfirmed termination as a failed refresh, and its early iterator break triggers the tree reap, which on Windows always answers with the typed proof limitation (process-tree.ts lines 381 to 386). Consequence: every expired-token refresh for managed Codex model operations fails on Windows. This predates the base and is disclosed in the FEATURES row, so it is out of scope for this verdict. I flag it because INV-121 asks the class question once two surfaces show the same failure, and the shared predicate already exists in app-server-threads.ts. The FEATURES row also cites line numbers that will drift; naming the function is safer.

3. **Unresolved index entries are never aged out** (`settleDeadOwners` in packages/cli/src/run-scope-index.ts). Only settled or unsupported outcomes retire an entry. An entry with a persistent survivor or a persistently unreadable member is re-reaped at every daemon start, each with its own 5 s budget, sequentially and uncapped. Reachable only with an unkillable or identity-unreadable leftover. Remedy: retire after a bounded number of starts with a disclosed action. Classification: deferred, low.

4. **Real process census inside every orchestrator run, tests included.** Without an injected custodian the engine falls back to the in-process custodian with the real reaper, so every run terminal shells out to `ps` on macOS. The long-path run shows the shift on the same host and tree family:

| orchestrator.test.ts | pinned base | candidate, long path | candidate, short path |
|---|---|---|---|
| suite time | 195.9 s | 255.7 s | 1108.3 s |
| until-clean no-progress case | 10.3 s | 12.1 s | 20.0 s (timeout) |

The long-path shift is consistent with the barrier cost, not proven by it, since the two runs overlapped other validation. Production impact is a fraction of a second per terminal. The test-suite coupling reduces headroom of timing-bound cases. Remedy is test-only: inject a cheap custodian in suites that do not test custody.

5. **Release notes omit the Windows454 behaviour.** The v4.1.1 CHANGELOG entry describes the custody work but not the completed-answer exception on Windows or the forced-drain disclosure, while ARCHITECTURE, WHITEPAPER and FEATURES do. CHECKLISTS require release notes to describe shipped behaviour. One sentence fixes it.

6. **Constitutional marker is unverifiable here.** The staged tree edits the INV-144 block. Every Bible-touching commit in the release range, plus the final commit of the staged edit, needs an owner-approved CONCEPT-CHANGE(INV-144) marker, which the concept gate checks per commit. I cannot read commit messages, so this is a parent verification item, not a defect.

7. **Marker shedding asymmetry with the host** (`daemonLaunchEnvironment` in packages/cli/src/daemon-launch.ts). An autostarted daemon sheds only run markers and keeps any inherited host task marker. Whether a daemon should outlive a host task is the host's decision, and the asymmetry is not stated in INTEGRATIONS. Observation only.

8. **Minor accuracy notes.** The record reports `marker+capture` coverage whenever the daemon index supplied arrays, even empty ones, so coverage can read richer than what was actually captured when the identity helper is unavailable; completeness still says not provable on macOS, so nothing reads clean. The new summary field has no in-repo consumer beyond tests and docs; the Swift app decodes with a lenient decoder and is unaffected.

**Clean judgments, verified in source.** The marker reaches race, plan, ask, deep-scan, synthesis, continuation and reviewer spec envs, the readiness-probe route contexts, the shared CLI run loop used by claude, cursor, agy, opencode and codex exec, the Codex app-server env, the ACP env through its credential filter, and raw captures; only the diff-review CLI has no run and no custody, as disclosed. Every announced run defers its terminal, the barrier settles and records once in a finally block, every path in the terminal net flushes through the continuation flush, the settled hook is idempotent, and pre-announce refusals settle the minted marker. Cancellation is frozen at strategy end for ordinary runs while delegate parents keep the live signal. The Windows exception requires zero survivors, non-empty unresolved entries, all with the one typed reason, plus a completed root turn with settled lifecycle, no goal, no owned terminals and non-empty final text; late root errors, failed or interrupted completions and new root turns invalidate it even after confirmed death, and child-thread frames cannot. The drain never treats a capacity-blocked reader as idle, keeps complete frames including chunks already buffered in the Readable, drops only a partial frame, and labels the closure on the exit event, the Codex terminal payload on success, cancel and failure paths, and the durable event. The detail projection is null unless the run is terminal and the artifact parses strictly; list rows are null through the schema default; the three generated schemas carry the regenerated descriptions; the index file has exactly one writer, the daemon. Owner decisions 03f2 (always-present key, explicit null), 05ed (settlement independent of discovery completeness, no universal gate) and the original macOS SIP acceptance are implemented as stated.

## Late QA, coverage and limits

**Fixture timing versus the drain promise.** The failing case in the short-path run is the confirmed-cleanup twin of the child-frames scenario. Its received stream shows the ten root frames and an exit with code 0 labelled truncated, no child frames, and the after-exit file present. The holder detects root death by polling every 10 ms and only then writes its frames, while this fixture sets the quiet bound to 150 ms against a production default of 2000 ms. A holder that is scheduled late writes into an already closed reader and swallows the error, which produces exactly this picture. The product promise was kept: quiet for the bound, forced closure, every frame already read delivered. The fixture premise was not. The same case passed in the long path, its Windows-cleanup twin passed in the short path, and the whole short-path run was four to six times slower per suite with teardown hooks exceeding 10 s. The scheduling hypothesis is therefore the best explanation but unproven, because the suite removes its scenario telemetry on teardown unless a capture directory is set. The fixture fails safe: a timing miss can only fail a case, never fake a pass, for positive and negative scenarios alike. Test-only remedies for the parent: widen the fixture bounds, or have the peer notify the holder over IPC right before exit, and run gates with the capture directory set.

**Other short-path failures.** Three model-service cases match both the pinned base and the long-path candidate. The remaining eight (three orchestrator cases, retained output, image custody, two plugin doctor exits, four teardown hook timeouts and the one unhandled rejection from model-services) are new relative to the long-path candidate run on the same tree, all timeout or slow-I/O shaped, and have no base counterpart in the short environment, so they stay unattributed. The budget-downgrade assertion is the only non-timeout shape among them and sits in the suite that ran 4.3 times slower; I could not exclude timing-sensitive event ordering.

**Inspected.** Full leaf patch; final bytes of app-server-run.ts, app-server-threads.ts, app-server-cancel.ts, runScope.ts, runTerminals.ts, orchestrator.ts (run entry, spec build), proc.ts, process-lines.ts, event-log index, continuation-custody.ts, run-artifact-read.ts, harness-acp env.ts and transport.ts, model-auth.ts, ci.yml, concept-gate.mjs, vitest.setup.ts, review-command.ts, both schema sources, CHANGELOG, Bible, DEVELOPMENT, CHECKLISTS; grep-level checks of consumers, spawn routes, DTOs and the three JUnit records.

**Limits.** No git and no execution: before-state comes from the retained patches, and HEAD-committed files were judged from the patch plus hunk-size parity rather than byte reads. Generated schemas, run-scope-index.ts and most of orchestrator.ts were read as hunks only. The 23 retained HTTP bodies were not replayed. Windows and Linux legs were judged from source on a macOS reader. Commit messages were not visible. The parent, not this review, owns the stray fixture ref, the RED gates, the CONCEPT-CHANGE marker check, release and publication.
