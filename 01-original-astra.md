# 01-original-astra

Author: GPT-6-Astra (independent reviewer).

Subject: 211a8f52acbde19803e9104960639c903c54f752..7cc1eea3b3611cb8f82b81b570f1a87a4684b72b.

This is the full technical response, with only disclosed local-path substitutions. It is historical evidence, not an automatic current approval.

# Answer

**CODE: FAIL. COUPLING: FAIL.** Five source-level findings remain. This is an independent source review, not a configured-review PASS or release approval.

Subject: base `211a8f52acbde19803e9104960639c903c54f752` → frozen tree `7cc1eea3b3611cb8f82b81b570f1a87a4684b72b`. Read-only comparisons at the beginning and end confirmed that both worktree and index match that tree. HEAD remains `e18ce620832d38f36d691b8ff78e552789f60b54`. The review covered the cumulative contribution, not merely the staged changes after HEAD.

1. **P1 — A process-group change can produce a false settled receipt.** In [the scope reaper’s `stillSame`](workspace/lifecycle-43b5-cx-joined/packages/core/src/process-scope-census.ts:489), individual-process death proof uses `compareProcessIdentity`, whose comparison includes `processGroupId` (`process-identity.ts:222`). A marked descendant can retain its PID and kernel birth while changing groups through `setsid()` or `setpgid()`. If that happens after TERM, the probe interprets the group change as death, removes the live member and adds it to `ended`. The subsequent census cannot recover it because `admitMarker` and `admitCaptured` permanently skip its PID through `seen`.

   Source trace: admit marked PID → TERM → same PID/birth changes PGID → comparison returns `different` → record `ended` → rescan skips PID → `settled: true`. The index can then retire its obligation, and the detail API exposes that false settlement. The selected host’s `checking_writers_settled` permits release on this value. This violates INV-144 for an affirmatively identified member; it is unrelated to accepted discovery uncertainty.

   Minimal remedy: compare immutable process birth for individual-PID liveness, independently of group membership, and permit appropriate re-evaluation during rescans. Preserve the stricter comparison used for group-signalling authority.

2. **P1 — Deterministic gate processes are outside the new run scope.** [Candidate gate execution](workspace/lifecycle-43b5-cx-joined/packages/orchestrator/src/orchestrator.ts:2789) passes `wsm.envFor(envelope)`, which contains scoped HOME/config paths but no run marker. The marker exists only in the separately constructed harness environment. Final verification also calls `runGates` with only a working directory: [patch verification](workspace/lifecycle-43b5-cx-joined/packages/delivery/src/final-verifier.ts:104) and `files-verifier.ts:50`.

   An ordinary configured gate can start a background server or worker and exit successfully. Its descendants carry no run marker; registry entries consequently have no scope attribution, so the index’s seed/capture paths ignore them. Successful `spawnProcess` completion does not run the cancellation reaper. The whole-run barrier can therefore report settlement while these engine-launched writers remain alive, contrary to INV-144 and the accepted whole-run lifecycle goal.

   Minimal remedy: pass the owning run’s marker through candidate gates and run-owned final verification into their spawn environments. Keep cleanup at the run boundary; this finding does not require killing processes after every successful command.

3. **P2 — Shared harness consumers discard forced-drain disclosure.** The new drain applies by default to every `spawnProcess` caller, but [the shared `runCliHarness` exit handler](workspace/lifecycle-43b5-cx-joined/packages/core/src/runloop.ts:184) retains only exit code and signal. It drops `ev.drain`. Claude, Cursor, Antigravity and OpenCode use this loop. Its eventual completed event consequently contains no truncation disclosure when inherited pipes force closure. `runCapture` likewise discards the flag; ACP’s transport does not project it either.

   A zero-exit native process whose descendant holds a pipe now completes after forced truncation, while these public consumers present the capture without that qualification. The Codex-specific implementation correctly preserves the field, but does not cover the shared behavior introduced by this contribution.

   Minimal remedy: propagate the drain fact through the shared completed-event and capture consumers, using their existing diagnostic channels. Preserve substantive results rather than converting truncation alone into failure.

4. **P2 — Settlement starts new identity/table reads after its deadline.** [The deadline wrapper](workspace/lifecycle-43b5-cx-joined/packages/core/src/process-scope-census.ts:353) accepts an already-started promise. `stillSame` invokes `identity.read` or `table.row` before passing it to that wrapper, without checking the deadline first. The loop also calls `probe()` immediately after sleeping, before its next deadline check.

   If the deadline expires during that sleep or the first batch of probes, later batches still start fresh reads. On macOS these can launch additional identity helpers or `ps` processes even though `bounded` immediately returns `DEADLINE`. The signal guard remains effective, and the receipt reports incompleteness, but the explicit INV-144 promise that scanning stops at the deadline is violated.

   Minimal remedy: check expiry before starting each read, or make the bounded operation lazy; stop scheduling further probe batches once expired. Retain the known members as unresolved/surviving evidence.

5. **P2 — Forced drain suppresses protocol validation failures.** In [the bounded line reader](workspace/lifecycle-43b5-cx-joined/packages/core/src/process-lines.ts:69), both the stdout catch and outer guard suppress every error once `stopped` is true. That includes `feed()` failures for oversized frames and invalid UTF-8, not just the expected premature-close error caused by destroying the pipe.

   With a backpressured ACP reader, the drain can fire while a complete frame awaits capacity. Resuming can then raise a decoding error, or processing the retained tail can exceed the frame limit; both failures are swallowed. Remaining buffered frames may be abandoned while the process stream reports an ordinary truncated exit. This weakens the existing bounded protocol validation precisely on the new stop path.

   Minimal remedy: suppress only the expected stream-close condition; continue propagating frame-size and decoding failures after forced stop.

**Checks without an additional finding:** The Codex completed-answer exception requires explicit completed root status, a nonempty final, settled lifecycle, no active goal/background commands, and proof-only Windows uncertainty. Cancellation, survivors, mixed reasons and empty uncertainty evidence remain negative. The post-stop guard rechecks queued root starts and failed/interrupted completions, with root system errors observed separately; child lifecycle frames do not invalidate the root. Codex’s `output_drain` survives `terminalPayload` and `harnessEventPayload` serialization.

The custody barrier settles and attempts the receipt once before terminal publication. Receipt-write/schema failure is swallowed without retry or substantive verdict replacement. Detail projection returns explicit null for missing, invalid or unavailable receipts; list rows default to null. The inspected generated scope schema agrees with that nullable contract. The selected host counterpart distinguishes omitted keys from explicit null and uses settlement independently of completeness, preserving the owner’s historical-run and unreadable-discovery decisions.

Run-marker inheritance, ACP filtering, scoped HOME/cache precedence and daemon removal of Claudexor run markers were inspected. Restart recovery consumes indexed obligations before the workspace sweep. Shutdown participants synchronously fence admission. These checks do not remove the findings above.

**Coverage and limits:** I read the full brief, enumerated all 143 changed paths, inspected the lifecycle production changes and relevant unchanged consumers across core, CLI, orchestrator, review, delivery, Codex, ACP, event-log and control API. I inspected focused regression-test source, including the joined native-pipe/API scenarios and their synthetic seams. Repository standards came from `CLAUDEXOR_BIBLE.md`, relevant DEVELOPMENT/CHECKLISTS sections, architecture/integration contracts and DESIGN_SYSTEM navigation. This is not a claim of line-by-line inspection of every historical test or repetitive package changelog.

No tests, runtime fixtures, vendor/account calls or live daemon operations were executed. Findings are source-derived failure traces requiring maintainer reproduction/disposition under INV-139. Independent host Panic and native Ouroboros command lifetime were not established by the supplied counterpart pointer; I inspected only its checking-copy settlement consumer. No separate SYSTEM.md/BIBLE.md, reference-book projection or own-body DESIGN source was supplied or located in the repository; that remains a disclosed source gap.

The supplied qualification remains **RED**: full gate 7,864 passed / 175 failed / 13 skipped with eight uncaught errors; canary 9 passed / 55 failed. The reported 267 affected passes and Windows454-only CI do not qualify the combined tree. The short-path exact-tree gate was pending in the brief; I obtained no later result.

No files or history were changed. One mistaken initial `git write-tree` invocation was rejected when the sandbox denied index-lock creation; subsequent identity checks used read-only comparisons.
