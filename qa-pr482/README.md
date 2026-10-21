# PR482 Windows window observation (QA only)

Status: prepared, **not run on Windows**. Native Windows evidence for PR482 does not
exist until this runs on a GitHub-hosted Windows runner and `summary.md` says
"Evidence complete: yes". Nothing here is product code or belongs in the product PR.
macOS/Linux runs of these files (self-test, POSIX dry-run) check the scripts, not windows.

## What it answers

1. Does the baseline (main `2b2dfc15`) show a console window when a daemon-shaped,
   console-less parent runs each changed consumer against an npm wrapper whose Node
   script starts a native console child with inherited stdio (Codex's shape)?
2. Does the candidate show none for the same scenario, on this host?
3. For quota, effort and the install proofs: the same with the **native image as the
   direct child**, and for the wrapper shape, does the wrapper's native grandchild get
   a window? A candidate `VISIBLE` owned by `fixture-native` there means those probes
   need the same compatible preload. Report it; do not change it by analogy.
4. Is every process the scenario started gone by the scenario end (RPC cleanup)?

It does not answer anything about Windows 11 with Windows Terminal as the default
terminal, ConPTY sign-in, device-code login, vendor update or real vendor binaries.
A Windows Server runner (`productType` 3) with conhost is not Windows 11 with Windows
Terminal. Launch flags and unit tests are not visibility evidence; only `verdict.json`
from a calibrated, complete run is.

## Files

| file | role |
|---|---|
| `windows-observation.yml` | workflow: `push` to `qa/pr482-windows` or `workflow_dispatch`; windows-2022/Node 24.15.0 and windows-latest/Node 24.16.0 (ci.yml's pairing); `contents: read`, no secrets |
| `observer.ps1` | Windows PowerShell 5.1. SetWinEventHook CREATE/SHOW for top-level windows on its own message pump, a 100 ms visible-window poll (records a window each time it becomes visible), `Win32_ProcessStartTrace`/`StopTrace`, host facts. Bounded: `-MaxSeconds`, `-DrainSeconds` |
| `mimic-launch.cjs` | starts `harness.cjs` like `daemon-launch.ts` (`detached`, stdio `ignore/ignore/pipe`, no `windowsHide`) with an **explicit scratch-only environment** (HOME/USERPROFILE/APPDATA/TEMP under `<out>-scratch`) |
| `harness.cjs` | inside that parent: compiles the native fixture, runs the controls and consumers from one checkout's built `dist`, asserts each, writes markers |
| `fixture-native.cs` | the only native fixture: a real console-subsystem `.exe` (csc, C# 5). It holds before every answer, logs each start (pid, argv) beside itself |
| `analyze.cjs` | joins markers, window and process events: per-scenario verdicts, calibration, comparisons, `summary.md`; exit 3 when evidence is incomplete |
| `selftest-analyze.cjs` | synthetic check of the verdict rules, 13 cases including the negative controls below |

## Fixture and scenarios

`<tmp>\tool.cmd` holds recorded npm cmd-shim bytes (the checkout's
`packages/core/src/fixtures/npm-launch/node.cmd`). It selects `<tmp>\node.exe`, a copy of
the runner Node, which runs `node_modules\@fixture\tool\bin\tool.cjs`. That script does
`spawn(fixture-native.exe, <its own argv>, {stdio: "inherit"})`, so the native call log
shows exactly the argv the consumer asked the vendor to run. `fixture-native.exe` answers
app-server JSON-RPC (`initialize`, `model/list`, `account/rateLimits/read`) **after
the hold** and stays alive until stdin closes, prints a version after the hold for
`--version`, help without `--device-auth` for `login --help`, else a marker.
The hold (default 1200 ms, `--hold-ms`) is in `hold.txt` beside the exe: the login runner
scrubs environment variables.

| scenario | real consumer from the checkout | asserted |
|---|---|---|
| `control_visible_pipe` | direct `spawn(native)`, piped, **no** `windowsHide` | exit 0, marker, native logged |
| `control_hidden_pipe` | the same with `windowsHide: true` | same |
| `consumer_stream` | `spawnProcess(tool.cmd)` | marker in stdout, exit event 0 |
| `consumer_raw` | `runCaptureRaw(tool.cmd)` | code 0, marker |
| `consumer_quota` / `consumer_quota_native` | `requestCodexAccount(home, env, bin)` through the wrapper / with the native exe as the direct child | `rateLimits` answer, native started as `app-server` |
| `consumer_effort` / `consumer_effort_native` | `probeCodexEfforts(bin)` likewise | catalog with default model `fixture`, `app-server` |
| `consumer_install_proof` | `proveInstalledNpm` on the npm prefix | `ok`, version 1.2.3, native asked `--version` |
| `consumer_install_proof_native` | `proveInstalledScriptVendor("fixture-native")` | `ok`, `--version` reached the native exe directly |
| `consumer_login_help` | `runSetupLoginWorker`, sealed manifest with a scratch `profileConfigDir` | worker 1, `device_auth_unsupported`, `commandStarted: false`, exactly one native call `login --help` |

A scenario that throws, answers wrongly, times out (90 s) or never reaches the native
fixture is recorded as failed and becomes `FAILED`; no window verdict survives it.

## Run it

Normal route: a fork where you may run Actions. Put `windows-observation.yml` in
`.github/workflows/` of a QA branch named `qa/pr482-windows` that contains the exact
candidate commit plus this directory (an ordinary tracked path). Pushing that branch
runs it with the pushed commit as the candidate. For other refs use `workflow_dispatch`
(`candidate_ref`, `base_ref` default `2b2dfc15…`, `original_ref` empty by default, `qa_dir`
default `qa-pr482`). Change the branch name in the `on.push` list if you use another.

Every run uploads `pr482-observation-<runner>` **always** (even after a failure): the raw
`observer-*.jsonl`, `observer-host.json`, `markers-*.jsonl`, harness stderr/exit files,
`run-inputs.json` (requested and resolved commits, runner image, node/pnpm),
`build-*.log` and `build-exit.json`, `observe-exit.json` (every step's exit status),
`verdict.json` and `summary.md`. The job is red when a build or harness exits abnormally, the
observer does not exit, or `analyze.cjs` exits 3 (evidence incomplete). Green means the
evidence is complete, not that no window appeared: read `summary.md`.

By hand on a disposable Windows machine, in PowerShell, after `pnpm install
--frozen-lockfile` and `pnpm build` in each checkout (never on someone's desktop session):

```powershell
$qa  = "<this directory>"
$out = "$env:TEMP\pr482-observation"
$obs = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @(
  "-NoProfile","-ExecutionPolicy","Bypass","-File","$qa\observer.ps1","-OutDir",$out)
while (-not (Test-Path "$out\observer.ready")) { Start-Sleep -Milliseconds 200 }
node "$qa\mimic-launch.cjs" --checkout <base checkout> --label base --out $out
node "$qa\mimic-launch.cjs" --checkout <candidate checkout> --label cand --out $out
New-Item "$out\observer.stop" | Out-Null; $obs.WaitForExit(45000) | Out-Null
node "$qa\analyze.cjs" $out
```

Labels `base` and `cand` (optionally `orig`) are fixed: comparisons are made against `base`,
and `base` and `cand` are required for a complete run.

## Reading the result

Per checkout, `analyze.cjs` first checks calibration. The checkout's scenarios are all
`INCONCLUSIVE` (the raw reading kept as `observedVerdict`) when any of these holds:

- the window hook did not install, or process events are not `registered`;
- the harness process's own start event was not captured (events not delivered);
- a console host started for the harness (the parent had a console: not the daemon's shape);
- `control_visible_pipe` did not execute, or was not `VISIBLE`/`VISIBLE_BY_TIME`;
- `control_hidden_pipe` did not execute, or saw a window.

Per scenario, before any window reading: `FAILED` if the consumer failed its assertions or
has no end marker; `INCONCLUSIVE` if it passed but the native child's pid (reported by the
fixture itself) has no start event under the harness in the process capture. Only then:
`VISIBLE` (a WS_VISIBLE top-level window owned by the scenario's process tree),
`VISIBLE_BY_TIME` (a visible console-host window in the interval not linked to the tree),
`AMBIGUOUS` (only another unattributed visible window), or `NONE`. "Visible" means
WS_VISIBLE on the runner's desktop, not that a person saw it.

Comparisons against `base`: baseline `VISIBLE*` with candidate `NONE` means the window was
reproduced and is absent with the candidate on this host; a baseline that shows no window
makes the candidate's `NONE` no evidence of the fix; a missing or undecided baseline is
`INCONCLUSIVE`. `notStoppedByScenarioEnd` lists processes without a stop event by scenario
end; for the candidate's quota/effort/login-help it should be empty.

Record `observer-host.json` with any conclusion: OS caption/build, `productType`, session,
window station, desktop and input desktop, conhost version, `DelegationConsole`/
`DelegationTerminal`, whether Windows Terminal is installed. The owner's desktop stays a
separate, unrun acceptance. Joseph's three manual Codex runs remain author evidence.

## Already checked without Windows (macOS, Node 24.16.0)

- `node --check` on all `.cjs`; `selftest-analyze.cjs` passes 13/13, and each of five
  deliberate weakenings of `analyze.cjs` (ignore consumer failure, skip harness-pid,
  parent-console, native-capture and process-capture checks) makes it fail.
- `--posix-dry-run` of `harness.cjs` (POSIX npm layout, a script stand-in for the native
  exe) passes all eleven scenarios and assertions against the candidate build and the
  baseline build; with the raw consumer deliberately redirected it records `FAILED`
  ("zero native calls"). This checks the harness's own calls, the scratch-only
  environment and the assertions only; it is no window evidence.
- Never executed anywhere: `observer.ps1`, `fixture-native.cs` (no PowerShell host or
  C# compiler was available) and the workflow. Their first real run is on the runner; the
  C# was reviewed by hand for C# 5 / .NET Framework 4 compatibility.
