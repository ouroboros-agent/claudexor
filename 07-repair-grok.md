# 07-repair-grok

Author: Grok4.7 (independent reviewer).

Subject: 7cc1eea3b3611cb8f82b81b570f1a87a4684b72b..fad717ad8a5c6890084a96640666366b5897bda6.

This is the full technical response, with only disclosed local-path substitutions. It is historical evidence, not an automatic current approval.

## summary

CODE FAIL. COUPLING FAIL. The failure is one seam: a successful ACP prompt does not disclose a forced post-exit drain. The other four Astra repairs hold on the paths I read. The prior Windows-root-custody FAIL is not reachable through the supported default registration or the run-scope index; the opt-in Windows reader is a different lane and is not wired to persisted `root_groups`. I am not turning that old FAIL into a PASS of the injected row, and I am not authorizing retention, a reader, or an age-out.

Subject read: HEAD `d35e6ed8a7cf937f33f3f2fcc052e3a18314fed8` on `lifecycle/43b5-review-repair`, trees `7cc1eea3b3611cb8f82b81b570f1a87a4684b72b` → `fad717ad8a5c6890084a96640666366b5897bda6`, 29 files. I did not reread the other 127 files of the 156-file contribution. Status returned no porcelain lines. No tests run here.

## findings

1. ACP success drops `output_drain` — reachable, this delta.

`acpRunner` awaits `agent.request(session/prompt)` and only then, in `finally`, calls `transport.close()` and reads `outputDrainTruncated()` (`packages/harness-acp/src/run.ts` around 136–194). `session/prompt` resolves when `pull` enqueues that JSON-RPC result and returns (`transport.ts` stdout branch, `controller.enqueue` then `return`). A descendant holding stdout keeps the child `close` event, and therefore the `exit` ProcEvent, behind `postExitDrain`. `close()` sets `closing` and `process.return()`s the generator (`transport.ts` 162–170). `return()` runs `spawnProcess`'s `finally` (`proc.ts` 414–418: `lines.close()`, `drain.clear()`) and does not yield a not-yet-pulled exit. The flag is set only in `pull` on `event.type === "exit"`, and `pull` returns immediately if `closing` (`transport.ts` 77–88). The completed payload is built after `close()` resolves.

So a normal ACP answer whose process has not yet yielded `exit` omits `output_drain: "truncated"`. `held-exit` does not cover this: `fixtures/agent.mjs` 113–118 exits without a prompt result, so that request cannot resolve until the stream ends, which is after the exit yield. `adapter.test.ts` 134–147 locks that no-response path only.

Consequence: the consumer named by this delta's changelog — ACP's completed event — does not get the disclosure on the success path the drain exists for. Cleanup of the direct child can still start via `abort()`/`requestCancel()`; the disclosure is what is lost. `drain.clear()` in the generator `finally` can also disarm the timer before it records truncation if it runs before `arm()`.

Smallest remedy: settle a process-closed promise from the child `close` handler that already pushes `{type:"exit", drain}` (`proc.ts` 284–293), have `transport.close()` await that promise and set the flag there, and do not depend on `pull`. Add a fixture that writes the prompt result and holds stdout, asserting `completed.payload.output_drain === "truncated"`. Narrow the changelog sentence until that path is true.

2. Windows known-root retirement — prior criticism, not a supported default defect.

`registerChildProcess` (`process-registry.ts` 39–56) calls `defaultProcessGroupService.captureLeader`. That service is `new ProcessGroupService()` with `defaultProcessIdentityService` (`process-group.ts` 212, `process-identity.ts` 483). Win32 `read` returns `unsupported_platform` unless `runWin32Reader` was passed (`process-identity.ts` 467–468). Unknown capture deletes the pid and does not notify listeners, so `DaemonRunScopeIndex.seedRoot` never runs and never writes `leader_identity` (`run-scope-index.ts` 112–154, 521–524). `daemonRunScopeIndex()` injects no identity reader. `defaultAsyncProcessIdentityReader` is also unsupported on win32 and says the scope reaper does not census Windows (`process-identity.ts` 524–572). `reapOnce` returns `unsupportedOutcome` before scanning `rootGroups` when `createScopeCensusReader` is null (`process-scope-census.ts` 327–328).

`processGroupServiceWithWindowsSupport` (`process-tree.ts` 49–57) is the opt-in reader plus `taskkill`. Callers I found: `setup-login-runner.ts` 91, `setup-jobs.ts` 135, and process-tree tests. None of those construct `DaemonRunScopeIndex` or call `registerChildProcess`. `spawnProcess`'s optional `processGroups` (`proc.ts` 190) is only the direct-group signal handle; registration still uses the default service (`proc.ts` 162, 496).

`retireOrKeep` still splices the row when `census === "unsupported"` (`run-scope-index.ts` 416–421). This delta only changes the log to `retired without proof (no environment census on this platform)`. The new test injects an unsupported outcome and still expects `entries === []` (`run-scope-index.test.ts` new case). That is an injected row, not a default writer.

Disposition: do not add retention, a probe, a reader, or an age-out. A future call that wires the opt-in reader into `registerChildProcess` or the index would revive the loss; that wiring is not in this tree. PID reuse inside one settlement window remains unproven. `seen` is unchanged.

3. The other four repairs — no remaining defect I could reach.

- PGID vs death: `compareProcessBirth` drops only `processGroupId` (`process-identity.ts` 222–234). `admitMarker` and `stillSame` use it (`process-scope-census.ts` 406, 494). `signalMember` signals the pid, not the old group. Leader/group authority stays `compareProcessIdentity` (`process-group.ts` 138–139, census 468, index `rootStillSame` 226). Roots are spawned `detached: true` (`proc.ts` 160), so a session leader's pgid stays its pid. I did not runtime-test that.
- Unmarked gates: `gateSpecsFromContract` adds `runScopeGateEnv` (`contract-gates.ts` 79–90, `runScope.ts` 98–100). `runGate` merges `spec.env` over the allowlist copy, so the marker is not stripped (`gates.ts` 48, 171–183), and `inheritEnv: "clean"` is the spawn env. Candidate gates, `finalVerifyRun`, and both adoption `verifyAndDeliver*` sites pass `runScopeMarker` (`orchestrator.ts` 2787, 4093, 4143, 4213, 5355). `renderTestsEvidence` calls `gateSpecsFromContract` without a marker and does not spawn.
- Deadline: `bounded` invokes the read only after `pastDeadline()` (`process-scope-census.ts` 354–359). The probe loop returns after `sleep` before `probe()` (544–546). A same-turn start if the timer fires inside an already-entered call is not a demonstrated extra read. No universal completeness gate was added. Discovery unreadability still does not become membership.
- Post-stop errors: `expectedEnd` is `stopped && code === "ERR_STREAM_PREMATURE_CLOSE"` (`process-lines.ts` 45–46, 80, 102, 119). Size, fatal UTF-8, other stream errors, and callback throws propagate. `closed` still discards; that is the consumer-gone path, not the drain. Linux/Windows destroy-error class was not run. If another platform uses a different code, it would now surface as a failure rather than be swallowed. That is the disclosed residual, not a reason to widen the predicate.

Gate pass path: `review.test.ts` 979–983 expects `output_truncated: false` when a passing gate's drain was truncated, because tails are not stored. That matches `gates.ts` 70–83. The schema sentence in `schema/src/gate.ts` is a little wider than that test ("or cut because the drain force-closed"). Not a release bug. Narrow the sentence to non-passing stored tails if you touch it.

Joined fixture: `drain-holder.mjs` waits on files (`held`, `afterExit`, `written`, `afterDrain`, `stop`), not on the old quiet bound. `stallMs` is an extra SIGSTOP, `runIf` not win32. Late root frames, child frames, cancel, survivor/mixed/empty, and write-failure `processScope: null` remain separate expectations (`run-codex-drain-detail.integration.test.ts` 541–623). I did not execute it. A 20ms sleep remains only between split-frame halves.

OB consumer, read in `lifecycle-43b5-ob-joined`: `checking_writers_settled` (`review_checking.py` 491–520) releases a succeeded detail only when `processScope` is absent or `settled is True`. Explicit null and unsettled keep the copy. This CX delta does not change that projection. Unsupported Windows census stays `settled: false`, so the host copy stays. I am not approving the whole OB tree.

## evidence

- Brief `CX-REVIEW-CONTINUATION.md`; handoffs `67a9ee80/CX-REMEDIATION-HANDOFF.md` and `cx-qualification/r2/HANDOFF-r2.md`.
- Tree diff name list and the production hunks/sources named above. Commit ref file equals `d35e6ed8a7cf937f33f3f2fcc052e3a18314fed8`.
- Changelog v4.1.1 paragraph now says Codex, the shared CLI loop, and ACP all put `output_drain: "truncated"` on completed. Shared CLI is `runCliHarness` (`runloop.ts` 190–191, 301), used by Claude, Cursor, agy, and OpenCode. Codex copies `event.drain` in `app-server-run.ts` 214–215 onto `terminalPayload` 338, and that file is not in this 29-file delta. ACP is the broken consumer.
- Parent message this round: exact `fad` `release:verify` exit 1, JUnit 8081 cases, 8067 pass / 1 fail / 13 skip; the fail is `model-services.test` catalog-refusal still running; cause unknown; later `&&` gates not run; source unchanged; old plugin/fixture RED did not repeat in that run. I did not open that JUnit. It is not a demonstrated product defect of these five repairs, and it is not GREEN. Prior full RED is not erased. Native Windows, Linux, and vendor sessions were not newly qualified.

## blockers

None for this read-only review. I did not run the suite, hash the patch bytes, or reread the frozen 156-file body. Panic entrypoints are not in the 29-file delta; I did not re-read the panic implementation.

## recommended_parent_action

Keep this CODE/COUPLING FAIL on the ACP success-path disclosure. Do not reopen Windows retention unless a real caller writes a known leader into `root_groups`. Do not treat the new catalog-refusal timeout as a lifecycle repair failure unless a trace shows it. The other four repairs do not need another structural pass from what I read. After the ACP close-handler fix, review that delta only; do not buy another whole-tree panel for identical `fad` bytes. Full `release:verify` remains RED until the one failure is attributed and the unrun gates actually run.
