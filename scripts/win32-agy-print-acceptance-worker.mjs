#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_FILE = ".claudexor-agy-fake-evidence.tsv";
const BROWSER_SENTINEL = ".claudexor-agy-fake-browser-sentinel";
const HANG_MARKER = ".claudexor-agy-fake-hang";
const PROVIDER_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "CLAUDE_API_KEY",
];

const input = parseArgs(process.argv.slice(2));
const repoRoot = resolve(required(input, "repo-root"));
const fixture = resolve(required(input, "fixture"));
const root = resolve(required(input, "root"));
const resultPath = resolve(required(input, "result"));

mkdirSync(root, { recursive: true });
process.env.CLAUDEXOR_CONFIG_DIR = root;
process.env.CLAUDEXOR_AGY_BIN = fixture;
for (const key of PROVIDER_KEYS) process.env[key] = "must-be-scrubbed";

const observedPids = new Set([process.pid]);
let summary = { ok: false, workerPid: process.pid, observedPids: [...observedPids] };
try {
  if (process.platform !== "win32") throw new Error("Windows acceptance worker requires win32");
  const importFromRepo = (relative) => import(pathToFileURL(join(repoRoot, relative)).href);
  const [
    { updateGlobalConfig },
    profile,
    printCommand,
    quota,
    protocol,
    remoteCommand,
    setupJobSupport,
  ] = await Promise.all([
    importFromRepo("packages/config/dist/index.js"),
    importFromRepo("packages/harness-agy/dist/profile.js"),
    importFromRepo("packages/harness-agy/dist/print-command.js"),
    importFromRepo("packages/cli/dist/agy-quota-source.js"),
    importFromRepo("packages/cli/dist/setup-login-protocol.js"),
    importFromRepo("packages/cli/dist/remote-command.js"),
    importFromRepo("packages/cli/dist/setup-job-support.js"),
  ]);

  const homeA = join(root, "profiles", "agy-win-a");
  const homeB = join(root, "profiles", "agy-win-b");
  const controlHome = join(root, "control-home");
  for (const dir of [homeA, homeB, controlHome]) mkdirSync(dir, { recursive: true });

  const profileA = credentialProfile("agy-win-a", "Windows A", homeA, true);
  const profileB = credentialProfile("agy-win-b", "Windows B", homeB, false);
  const configured = updateGlobalConfig((current) => ({
    ...current,
    credential_profiles: [profileA, profileB],
  }));
  assert(configured.path === join(root, "config.yaml"), "config root did not own config.yaml");

  const controlEnv = { ...process.env };
  for (const key of PROVIDER_KEYS) delete controlEnv[key];
  Object.assign(controlEnv, {
    HOME: controlHome,
    USERPROFILE: controlHome,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  });
  const control = spawnSync(fixture, ["-p", "/model", "--output-format", "json"], {
    cwd: root,
    env: controlEnv,
    shell: false,
    detached: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  assert(control.error === undefined, "console control fake failed to spawn");
  if (Number.isSafeInteger(control.pid) && control.pid > 0) observedPids.add(control.pid);
  assert(control.status === 0, `console control fake exited ${String(control.status)}`);
  assert(control.signal === null, "console control fake exited by signal");
  assert(
    existsSync(join(controlHome, BROWSER_SENTINEL)),
    "console control did not enter the interactive/browser branch",
  );

  const route = profile.resolveAgyProfileRoute(profileA);
  assert(!("refusal" in route), "enabled profile route was refused");
  assert(route.home === realpathSync(homeA), "enabled profile route selected the wrong HOME");
  const model = await profile.defaultAgyModelProbe(route.env);
  assert(model.kind === "authenticated", `model probe returned ${model.kind}`);
  assert(model.modelId === "gemini-3.7-flash-high", "model probe parsed the wrong model");

  const quotaResult = await quota.refreshAgyQuota({ bin: fixture, platform: "win32" });
  assert(quotaResult.snapshots.length === 1, "quota did not select exactly one enabled profile");
  assert(quotaResult.absences.length === 0, "quota returned an unexpected absence");

  const hangMarker = join(homeA, HANG_MARKER);
  writeFileSync(hangMarker, "hang\n", "utf8");
  let timeoutResult;
  try {
    timeoutResult = await printCommand.runAgyPrintCommand(fixture, "/model", route.env, {
      timeoutMs: 250,
      cancelDeadlineMs: 3_000,
      drainMs: 100,
    });
  } finally {
    if (existsSync(hangMarker)) unlinkSync(hangMarker);
  }
  assert(timeoutResult.kind === "failed", "hanging print probe unexpectedly completed");
  assert(
    timeoutResult.reason === "termination_unconfirmed",
    `hanging print probe returned ${timeoutResult.reason}`,
  );
  const timeoutPids = parsePidLine(timeoutResult.stdout);
  observedPids.add(timeoutPids.vendor);
  observedPids.add(timeoutPids.descendant);
  await expectPidsGone(timeoutPids, 5_000);

  const browserSentinel = join(homeA, BROWSER_SENTINEL);
  const browserSentinelBeforeClientPty = existsSync(browserSentinel);
  assert(!browserSentinelBeforeClientPty, "print probes entered the browser branch");

  const jobDir = join(root, "client-pty-job");
  mkdirSync(jobDir, { recursive: true });
  const args = ["-p", "/model", "--output-format", "json"];
  const executable = protocol.captureExecutableEvidence(fixture);
  const manifestPath = join(jobDir, "runner-manifest.json");
  const manifest = protocol.sealLoginManifest({
    version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: "win32-agy-client-pty",
    executionId: "win32-agy-client-pty-execution-1",
    harness: "agy",
    jobDir,
    binary: fixture,
    args,
    cwd: jobDir,
    profileConfigDir: homeA,
    statePath: join(jobDir, "runner-state.json"),
    resultPath: join(jobDir, "runner-result.json"),
    permitPath: join(jobDir, "runner-permit.json"),
    permitDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
    permitWaitMs: 5_000,
    executable,
    commandDigest: protocol.commandDigest(executable, args),
  });
  protocol.atomicPrivateJson(manifestPath, manifest);
  const runnerPath = setupJobSupport.resolveSetupLoginRunnerPath();
  const invocation = remoteCommand.setupAttachRunnerInvocation({
    platform: process.platform,
    nodePath: process.execPath,
    runnerPath,
    manifestPath,
    cwd: jobDir,
    env: process.env,
  });
  const loginRunner = spawn(invocation.command, invocation.args, invocation.options);
  if (!loginRunner.pid) throw new Error("client_pty runner PID was not assigned");
  const loginRunnerPid = loginRunner.pid;
  observedPids.add(loginRunnerPid);
  const loginFinished = waitForChild(loginRunner);
  await Promise.race([
    waitFor(
      () => readJsonIfPresent(manifest.statePath)?.stage === "awaiting_permit",
      3_000,
      "client_pty runner permit state",
    ),
    loginFinished.then(({ code, signal }) => {
      throw new Error(
        `client_pty runner exited before permit (code ${String(code)}; signal ${String(signal)})`,
      );
    }),
  ]);
  protocol.atomicPrivateJson(manifest.permitPath, {
    version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: manifest.jobId,
    executionId: manifest.executionId,
    issuedAt: new Date().toISOString(),
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
  });
  const loginProcess = await loginFinished;
  const loginReceipt = protocol.readRunnerResult(manifest.resultPath);
  assert(loginProcess.code === 0, `client_pty worker exited ${String(loginProcess.code)}`);
  assert(loginProcess.signal === null, "client_pty worker exited by signal");
  assert(loginReceipt?.commandStarted === true, "client_pty receipt did not start the command");
  assert(loginReceipt?.exitCode === 0, "client_pty receipt did not record exit 0");
  assert(loginReceipt?.signal === null, "client_pty receipt recorded a signal");
  assert(loginReceipt?.errorCode === undefined, "client_pty receipt recorded a transport error");
  const browserSentinelAfterClientPty = existsSync(browserSentinel);
  assert(browserSentinelAfterClientPty, "direct client_pty path did not expose CONIN$");

  const controlEvidence = readEvidence(controlHome);
  const profileEvidence = readEvidence(homeA);
  for (const row of [...controlEvidence, ...profileEvidence]) observedPids.add(row.pid);
  assert(
    controlEvidence.some((row) => row.mode === "interactive"),
    "control evidence is absent",
  );
  assert(
    profileEvidence.some((row) => row.mode === "interactive"),
    "client_pty evidence is absent",
  );
  assert(!existsSync(join(homeB, EVIDENCE_FILE)), "disabled profile B was probed");

  summary = {
    ok: true,
    workerPid: process.pid,
    observedPids: [...observedPids],
    paths: {
      config: configured.path,
      homeA,
      homeB,
      controlHome,
      evidenceA: join(homeA, EVIDENCE_FILE),
      evidenceB: join(homeB, EVIDENCE_FILE),
      controlEvidence: join(controlHome, EVIDENCE_FILE),
      browserSentinel,
    },
    control: {
      status: control.status,
      stdout: control.stdout,
      evidence: controlEvidence,
    },
    model,
    quota: quotaResult,
    timeout: { result: timeoutResult, pids: timeoutPids },
    browserSentinelBeforeClientPty,
    browserSentinelAfterClientPty,
    login: {
      exit: loginProcess.code,
      signal: loginProcess.signal,
      runnerPid: loginRunnerPid,
      receipt: loginReceipt,
    },
    evidence: profileEvidence,
  };
} catch (error) {
  summary = {
    ok: false,
    workerPid: process.pid,
    observedPids: [...observedPids],
    error: error instanceof Error ? error.message : String(error),
  };
  process.exitCode = 1;
} finally {
  writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function credentialProfile(profileId, displayName, isolationLocator, enabled) {
  return {
    profile_id: profileId,
    harness_id: "agy",
    display_name: displayName,
    credential_kind: "config_dir_login",
    isolation_locator: isolationLocator,
    secret_ref: null,
    enabled,
    created_at: null,
  };
}

function parseArgs(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: win32-agy-print-acceptance-worker --repo-root DIR --fixture EXE --root DIR --result FILE",
      );
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readEvidence(home) {
  const path = join(home, EVIDENCE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 11 || fields[0] !== "FAKE") {
        throw new Error("fake agy wrote malformed evidence");
      }
      return {
        mode: fields[1],
        command: fields[2],
        pid: Number(fields[3]),
        consoleCodePage: Number(fields[4]),
        windowPresent: fields[5] === "1",
        coninAvailable: fields[6] === "1",
        stdinEof: fields[7] === "1",
        homeMatchesUserProfile: fields[8] === "1",
        autoUpdateDisabled: fields[9] === "1",
        providerKeysAbsent: fields[10] === "1",
      };
    });
}

function parsePidLine(output) {
  const match = /PIDS\t([1-9][0-9]*)\t([1-9][0-9]*)/.exec(output);
  if (!match) throw new Error("hanging fake agy did not disclose exact PIDs");
  return { vendor: Number(match[1]), descendant: Number(match[2]) };
}

async function expectPidsGone(pids, timeoutMs) {
  await waitFor(
    () => !pidAlive(pids.vendor) && !pidAlive(pids.descendant),
    timeoutMs,
    "fake agy timeout tree cleanup",
  );
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal }));
  });
}
