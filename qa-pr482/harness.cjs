"use strict";
// PR482 Windows window-observation harness (QA only, never product code).
// Runs INSIDE the console-less, daemon-like parent started by mimic-launch.cjs.
// For one checkout it drives the real consumers from that checkout's built dist
// against an npm-shaped fixture whose Node wrapper starts a NATIVE console
// grandchild with inherited stdio (Codex's shape), and against that native binary
// directly. Every scenario asserts that its consumer really ran and reached the
// native fixture (argv, pid and output are checked); a consumer that threw, answered
// wrongly or never spawned is FAILED, never "no window". Window/process evidence
// comes from observer.ps1.
//
// usage: node harness.cjs --checkout <repo> --label <name> --out <dir> [--hold-ms 1200]
//        [--posix-dry-run]  same consumers through a POSIX npm layout and a script
//                           stand-in for the native exe, to check this harness's own
//                           calls before a Windows run (no window evidence)
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const checkout = path.resolve(option("checkout"));
const label = option("label");
const out = path.resolve(option("out"));
const holdMs = Number(option("hold-ms", "1200"));
const dryRun = argv.includes("--posix-dry-run");
const SCENARIO_TIMEOUT_MS = 90_000;
fs.mkdirSync(out, { recursive: true });
const markers = path.join(out, `markers-${label}.jsonl`);
const mark = (record) =>
  fs.appendFileSync(markers, `${JSON.stringify({ at: Date.now(), label, pid: process.pid, ...record })}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const load = (relative) => import(pathToFileURL(path.join(checkout, relative)).href);
const need = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// ---- fixture: <prefix>\tool.cmd (recorded npm cmd-shim) -> <prefix>\node.exe ->
// node_modules\@fixture\tool\bin\tool.cjs -> <prefix>\native\fixture-native.exe
const NATIVE_STANDIN = `#!${process.execPath}
// POSIX dry-run stand-in for fixture-native.cs: same argv contract, same log.
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(fs.realpathSync(process.argv[1]));
let hold = 1200;
try { hold = parseInt(fs.readFileSync(path.join(dir, "hold.txt"), "utf8"), 10); } catch {}
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "native-calls.jsonl"), JSON.stringify({ pid: process.pid, args, at: Date.now() }) + "\\n");
if (args.includes("app-server")) {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    let request; try { request = JSON.parse(line); } catch { return; }
    if (request.id === undefined) return;
    setTimeout(() => {
      const result = request.method === "model/list"
        ? { data: [{ id: "fixture", isDefault: true, defaultReasoningEffort: "high",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] }
        : request.method === "account/rateLimits/read" ? { rateLimits: { primary: null, secondary: null } } : {};
      process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
    }, hold);
  });
} else setTimeout(() => {
  if (args.includes("--version")) console.log("fixture-cli 1.2.3");
  else if (args.includes("login") && args.includes("--help")) console.log("Usage: tool login [--with-api-key]");
  else console.log(process.env.PR482_MARKER || "native-done");
}, hold);
`;

function compileNative(nativeExe) {
  const root = process.env.windir || process.env.SystemRoot;
  const csc = path.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const result = spawnSync(
    csc,
    ["/nologo", "/target:exe", "/optimize", "/r:System.Web.Extensions.dll", `/out:${nativeExe}`, path.join(__dirname, "fixture-native.cs")],
    { encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  mark({ event: "native_compiled", csc, status: result.status, stdout: (result.stdout || "").slice(-1500), stderr: (result.stderr || "").slice(-1500) });
  if (result.status !== 0 || !fs.existsSync(nativeExe)) throw new Error(`fixture-native.exe did not compile (csc status ${result.status})`);
}

function buildFixture() {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), `pr482-${label}-`));
  const packageRoot = path.join(prefix, "node_modules", "@fixture", "tool");
  const nativeDir = path.join(prefix, "native");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(nativeDir, { recursive: true });
  const nativeExe = path.join(nativeDir, "fixture-native.exe");
  fs.copyFileSync(process.execPath, path.join(prefix, "node.exe"));
  fs.writeFileSync(path.join(nativeDir, "hold.txt"), String(holdMs));
  if (dryRun) {
    fs.writeFileSync(nativeExe, NATIVE_STANDIN, { mode: 0o755 });
  } else compileNative(nativeExe);
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@fixture/tool", version: "1.2.3", bin: { tool: "bin/tool.cjs" } }),
  );
  const shimBytes = fs.readFileSync(
    path.join(checkout, "packages", "core", "src", "fixtures", "npm-launch", "node.cmd"),
    "utf8",
  );
  fs.writeFileSync(path.join(prefix, "tool.cmd"), shimBytes.replace(/\r?\n/g, "\r\n"));
  if (dryRun) {
    // POSIX npm global layout: <prefix>/bin/tool -> lib/node_modules/@fixture/tool/bin/tool.cjs
    const posixRoot = path.join(prefix, "lib", "node_modules", "@fixture");
    fs.mkdirSync(posixRoot, { recursive: true });
    fs.symlinkSync(packageRoot, path.join(posixRoot, "tool"));
    fs.mkdirSync(path.join(prefix, "bin"));
    fs.symlinkSync(path.join(packageRoot, "bin", "tool.cjs"), path.join(prefix, "bin", "tool"));
    fs.symlinkSync(nativeExe, path.join(nativeDir, "fixture-native"));
  }
  // The Node wrapper: Codex's own launch shape, spawn(native, argv, {stdio: "inherit"}).
  // Its argv goes to the native binary unchanged, so the native call log shows
  // exactly what the consumer asked the vendor to run.
  fs.writeFileSync(
    path.join(packageRoot, "bin", "tool.cjs"),
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const path = require("node:path");
const native = process.env.PR482_NATIVE || path.join(path.dirname(process.execPath), "native", "fixture-native.exe");
const child = spawn(native, process.argv.slice(2), { stdio: "inherit", env: process.env });
child.on("error", (error) => { console.error(error); process.exit(1); });
child.on("exit", (code) => process.exit(code ?? 1));
`,
  );
  const entry = path.join(packageRoot, "bin", "tool.cjs");
  if (dryRun) fs.chmodSync(entry, 0o755);
  return {
    prefix, nativeExe, packageRoot, nativeDir,
    shim: dryRun ? path.join(prefix, "bin", "tool") : path.join(prefix, "tool.cmd"),
    callsLog: path.join(nativeDir, "native-calls.jsonl"),
  };
}

function baseEnv(fixture, extra = {}) {
  const home = path.join(fixture.prefix, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = {
    PATH: dryRun ? `${fixture.prefix}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin` : `${fixture.prefix};${process.env.SystemRoot}\\System32`,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    HOME: home,
    USERPROFILE: home,
    CLAUDEXOR_CONFIG_DIR: path.join(home, "claudexor"),
    PR482_MARKER: "grandchild-reached",
    PR482_NATIVE: fixture.nativeExe,
    ...extra,
  };
  for (const key of ["SystemRoot", "windir", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

let failedScenarios = 0;
function nativeCalls(fixture) {
  if (!fs.existsSync(fixture.callsLog)) return [];
  return fs
    .readFileSync(fixture.callsLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function scenario(fixture, name, run, check) {
  mark({ event: "scenario_start", scenario: name });
  const before = nativeCalls(fixture).length;
  let result;
  let timer;
  try {
    const value = await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`scenario exceeded ${SCENARIO_TIMEOUT_MS} ms`)), SCENARIO_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    const calls = nativeCalls(fixture).slice(before);
    need(calls.length > 0, "the consumer never started the native fixture (zero native calls)");
    check(value, calls);
    result = { status: "pass", value: JSON.stringify(value, (k, v) => (typeof v === "string" ? v.slice(0, 300) : v))?.slice(0, 1500) };
  } catch (error) {
    clearTimeout(timer);
    failedScenarios += 1;
    result = { status: "fail", error: error && error.stack ? String(error.stack).slice(0, 2000) : String(error) };
  }
  // Leave time for a late window and for cleanup to finish before the next scenario.
  await sleep(holdMs + 1500);
  const calls = nativeCalls(fixture).slice(before);
  mark({ event: "scenario_end", scenario: name, result, nativePids: calls.map((call) => call.pid), nativeCalls: calls });
}

const argsOf = (calls) => calls.flatMap((call) => call.args);

// Direct spawns from this console-less parent: the observer's controls.
function directChild(fixture, options) {
  return new Promise((resolve) => {
    const child = spawn(fixture.nativeExe, ["wrap"], { env: baseEnv(fixture), ...options });
    mark({ event: "spawned", what: "direct", childPid: child.pid, options: { ...options, env: undefined } });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.resume();
    child.on("close", (code, signal) => resolve({ code, signal, childPid: child.pid, stdout: stdout.trim() }));
    child.on("error", (error) => resolve({ error: String(error) }));
  });
}
const controlCheck = (value) => {
  need(value.error === undefined, `control child failed to start: ${value.error}`);
  need(value.code === 0, `control child exited ${value.code}`);
  need(value.stdout === "grandchild-reached", `control child printed ${JSON.stringify(value.stdout)}`);
};

async function main() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  mark({
    event: "harness_start", checkout, node: process.version, execPath: process.execPath, ppid: process.ppid,
    home, envKeys: Object.keys(process.env).sort(),
  });
  // The parent was started with a scratch-only environment; refuse to run otherwise.
  const scratchRoot = `${out}-scratch`;
  if (!within(scratchRoot, home) || !within(scratchRoot, os.tmpdir())) {
    throw new Error(`environment is not scratch-only: HOME/USERPROFILE=${home}, tmp=${os.tmpdir()}, scratch=${scratchRoot}`);
  }
  const fixture = buildFixture();
  mark({ event: "fixture", ...fixture });
  const core = await load("packages/core/dist/index.js");

  // Positive control: a console program started WITHOUT windowsHide from a parent
  // that has no console. If the observer cannot see this, every "no window" below
  // is INCONCLUSIVE, not a pass.
  await scenario(fixture, "control_visible_pipe", () => directChild(fixture, { stdio: ["pipe", "pipe", "pipe"] }), controlCheck);
  // Negative control: the same child with windowsHide and piped stdio.
  await scenario(
    fixture, "control_hidden_pipe",
    () => directChild(fixture, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    controlCheck,
  );

  await scenario(fixture, "consumer_stream", async () => {
    const events = [];
    for await (const event of core.spawnProcess(fixture.shim, [], { env: baseEnv(fixture), timeoutMs: 20000 }))
      events.push(event);
    return { events };
  }, ({ events }) => {
    need(events.some((e) => e.type === "stdout" && e.line.includes("grandchild-reached")), "stdout lacks the grandchild's marker");
    const exit = events.find((e) => e.type === "exit");
    need(exit && exit.code === 0, `exit event ${JSON.stringify(exit)}`);
  });
  await scenario(fixture, "consumer_raw", async () => {
    const result = await core.runCaptureRaw(fixture.shim, [], { env: baseEnv(fixture), timeoutMs: 20000 });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr.slice(0, 500) };
  }, (value) => {
    need(value.code === 0, `exit code ${value.code}`);
    need(value.stdout.includes("grandchild-reached"), "stdout lacks the grandchild's marker");
  });

  const checkQuota = (value, calls) => {
    need(value.value && typeof value.value === "object" && "rateLimits" in value.value, `quota answer ${JSON.stringify(value.value)}`);
    need(argsOf(calls).includes("app-server"), "native was not started as app-server");
  };
  const checkEfforts = (value, calls) => {
    need(value.value && value.value.defaultModel === "fixture" && value.value.models && value.value.models.fixture, `effort catalog ${JSON.stringify(value.value)}`);
    need(argsOf(calls).includes("app-server"), "native was not started as app-server");
  };
  const quota = async (bin) => {
    const { requestCodexAccount } = await load("packages/cli/dist/codex-quota-source.js");
    return { value: await requestCodexAccount(path.join(fixture.prefix, "codex-home"), baseEnv(fixture), bin) };
  };
  const efforts = async (bin) => {
    const { probeCodexEfforts } = await load("packages/harness-codex/dist/effort-probe.js");
    return { value: await probeCodexEfforts(bin, { env: baseEnv(fixture), timeoutMs: 20000 }) };
  };
  // Through the npm wrapper (Codex's shape) and with the native image as the direct child.
  await scenario(fixture, "consumer_quota", () => quota(fixture.shim), checkQuota);
  await scenario(fixture, "consumer_effort", () => efforts(fixture.shim), checkEfforts);
  await scenario(fixture, "consumer_quota_native", () => quota(fixture.nativeExe), checkQuota);
  await scenario(fixture, "consumer_effort_native", () => efforts(fixture.nativeExe), checkEfforts);

  const runtime = (env) => ({
    runnerNodePath: process.execPath, platform: dryRun ? process.platform : "win32", arch: process.arch,
    resolutionSource: env, environment: env, spawn: spawnSync,
  });
  const checkProof = (value, calls) => {
    need(value.ok === true, `proof ${JSON.stringify(value)}`);
    need(value.proof.installedVersion.includes("1.2.3"), `proved version ${value.proof.installedVersion}`);
    need(argsOf(calls).includes("--version"), "native was not asked for --version");
  };
  await scenario(fixture, "consumer_install_proof", async () => {
    const { proveInstalledNpm } = await load("packages/cli/dist/harness-install-proof.js");
    return proveInstalledNpm(
      { vendorRoot: fixture.prefix, npmPackage: "@fixture/tool", binaryNames: ["tool"], expectedVersion: "1.2.3" },
      runtime(baseEnv(fixture)),
    );
  }, checkProof);
  // A managed Windows Codex proof runs the package's native image itself: the same
  // proveVersion, with a native console program as the DIRECT child (no wrapper).
  await scenario(fixture, "consumer_install_proof_native", async () => {
    const { proveInstalledScriptVendor } = await load("packages/cli/dist/harness-install-proof.js");
    const env = baseEnv(fixture);
    env.PATH = `${fixture.nativeDir}${path.delimiter}${env.PATH}`;
    return proveInstalledScriptVendor("fixture-native", runtime(env));
  }, checkProof);
  await scenario(fixture, "consumer_login_help", async () => {
    const protocol = await load("packages/cli/dist/setup-login-protocol.js");
    const { runSetupLoginWorker } = await load("packages/cli/dist/setup-login-runner.js");
    // The sealed manifest binds the canonical path (macOS /var, Windows 8.3 TEMP names).
    const jobDir = fs.realpathSync(fs.mkdtempSync(path.join(fixture.prefix, "login-job-")));
    const binary = fs.realpathSync(path.join(fixture.packageRoot, "bin", "tool.cjs"));
    const executable = protocol.captureExecutableEvidence(binary);
    const args = ["login", "--device-auth"];
    const spec = protocol.sealLoginManifest({
      version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: "setup-pr482-login-help",
      executionId: "execution-1",
      harness: "codex",
      jobDir,
      binary,
      args,
      cwd: jobDir,
      // Without this the runner defaults CODEX_HOME to the real native Codex state root.
      profileConfigDir: path.join(jobDir, "codex-profile"),
      statePath: path.join(jobDir, "runner-state.json"),
      resultPath: path.join(jobDir, "runner-result.json"),
      permitPath: path.join(jobDir, "runner-permit.json"),
      permitDeadlineAt: new Date(Date.now() + 30000).toISOString(),
      executable,
      commandDigest: protocol.commandDigest(executable, args),
      interpreter: { binary: path.join(fixture.prefix, "node.exe"), args: [] },
    });
    const manifestPath = path.join(jobDir, "runner-manifest.json");
    protocol.atomicPrivateJson(manifestPath, spec);
    protocol.atomicPrivateJson(spec.permitPath, {
      version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: spec.jobId,
      executionId: spec.executionId,
      issuedAt: new Date().toISOString(),
      commandDigest: spec.commandDigest,
      manifestDigest: spec.manifestDigest,
    });
    // The fixture's help omits --device-auth, so the worker stops after the
    // captured probe (device_auth_unsupported) and never starts the sign-in.
    const code = await runSetupLoginWorker(manifestPath);
    const result = fs.existsSync(spec.resultPath) ? JSON.parse(fs.readFileSync(spec.resultPath, "utf8")) : null;
    return { code, result };
  }, ({ code, result }, calls) => {
    need(code === 1, `worker returned ${code}`);
    need(result && result.errorCode === "device_auth_unsupported" && result.commandStarted === false, `result ${JSON.stringify(result)}`);
    need(calls.length === 1 && calls[0].args.join(" ") === "login --help", `native calls ${JSON.stringify(calls)}`);
  });
  mark({ event: "harness_end", failedScenarios });
  if (failedScenarios > 0) process.exitCode = 3;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    mark({ event: "harness_error", error: String(error && error.stack ? error.stack : error) });
    process.exit(1);
  },
);
