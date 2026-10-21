"use strict";
// Synthetic self-test of analyze.cjs verdict rules (runs anywhere; no Windows needed).
// The negative controls matter most: each one must stop a quiet-looking run from
// reading as "no window".
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCENARIOS = [
  "control_visible_pipe", "control_hidden_pipe", "consumer_stream", "consumer_raw", "consumer_quota", "consumer_effort",
  "consumer_quota_native", "consumer_effort_native", "consumer_install_proof", "consumer_install_proof_native", "consumer_login_help",
];

function run(build, { processCapture = "registered" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr482-analyze-"));
  const w = [], p = [];
  const marks = {};
  const t0 = 1_000_000;
  p.push({ kind: "observer", processCapture, at: t0 });
  w.push({ source: "observer", hookInstalled: true, at: t0 });
  build({ w, p, marks, t0 });
  fs.writeFileSync(path.join(dir, "observer-windows.jsonl"), "﻿" + w.map((x) => JSON.stringify(x)).join("\n"));
  fs.writeFileSync(path.join(dir, "observer-processes.jsonl"), p.map((x) => JSON.stringify(x)).join("\r\n"));
  fs.writeFileSync(path.join(dir, "observer-host.json"), JSON.stringify({ osCaption: "Synthetic", osBuild: "0" }));
  for (const [label, list] of Object.entries(marks)) {
    fs.writeFileSync(path.join(dir, `markers-${label}.jsonl`), list.map((x) => JSON.stringify(x)).join("\n"));
    fs.writeFileSync(path.join(dir, `harness-${label}.exit.json`), JSON.stringify({ code: 0 }));
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, "analyze.cjs"), dir], { stdio: "ignore" });
  return { report: JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8")), status: result.status };
}

// One checkout: harness pid H, scenarios in sequence. `windowFor` decides each scenario's window.
// options: failed(scenario) -> consumer assertion failed; reportNative=false -> fixture reported no pid;
// captureNative=false -> no start event for the native child; harnessStart=false -> no start event for H;
// parentConsole -> a console host started for H; only -> run just these scenarios.
function checkout({ w, p, marks }, label, base, H, windowFor, options = {}) {
  const { failed = () => false, reportNative = true, captureNative = true, harnessStart = true, parentConsole = false, only = SCENARIOS } = options;
  const list = (marks[label] = []);
  list.push({ event: "harness_start", at: base, pid: H });
  if (harnessStart) p.push({ kind: "start", at: base - 10, pid: H, ppid: 1, name: "node.exe" });
  if (parentConsole) p.push({ kind: "start", at: base - 5, pid: H + 900, ppid: H, name: "conhost.exe" });
  let at = base + 100;
  let pid = H + 1;
  for (const scenario of only) {
    list.push({ event: "scenario_start", scenario, at });
    const child = pid++;
    if (captureNative) p.push({ kind: "start", at: at + 10, pid: child, ppid: H, name: "fixture-native.exe" });
    const kind = windowFor(scenario);
    if (kind === "owned") w.push({ source: "hook", at: at + 20, pid: child, visible: true, class: "ConsoleWindowClass", image: "fixture-native" });
    if (kind === "conhost") {
      const host = pid++;
      p.push({ kind: "start", at: at + 15, pid: host, ppid: 4, name: "conhost.exe" });
      w.push({ source: "hook", at: at + 20, pid: host, visible: true, class: "ConsoleWindowClass", image: "conhost" });
    }
    if (kind === "hidden") w.push({ source: "hook", at: at + 20, pid: child, visible: false, class: "ConsoleWindowClass", image: "fixture-native" });
    if (scenario !== "consumer_quota" || label !== "leaky") p.push({ kind: "stop", at: at + 900, pid: child, ppid: H, name: "fixture-native.exe" });
    list.push({
      event: "scenario_end", scenario, at: at + 1000,
      result: failed(scenario) ? { status: "fail", error: "assertion failed: synthetic" } : { status: "pass" },
      nativePids: reportNative ? [child] : [], nativeCalls: [],
    });
    at += 2000;
  }
  list.push({ event: "harness_end", at });
}
const quiet = (s) => (s === "control_visible_pipe" ? "owned" : "hidden");
const reproduces = (s) => (s === "control_hidden_pipe" ? "hidden" : "owned");
const verdictOf = (r, label, scenario) => r.report.labels[label].scenarios[scenario].verdict;
let count = 0;
const ok = (fn) => { fn(); count += 1; };

// 1. Base reproduces, candidate quiet, observer calibrated: complete, exit 0.
let r = run((ctx) => {
  checkout(ctx, "base", ctx.t0, 100, reproduces);
  checkout(ctx, "cand", ctx.t0 + 40000, 200, quiet);
});
ok(() => {
  assert.equal(r.report.labels.base.observerBlind, false);
  assert.equal(verdictOf(r, "base", "consumer_stream"), "VISIBLE");
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "NONE");
  assert.match(r.report.comparisons["cand:consumer_stream"], /reproduced; none/);
  assert.deepEqual(r.report.problems, []);
  assert.equal(r.status, 0);
});

// 2. Console-host window not linked by process parentage counts by time, calibrated by controls.
r = run((ctx) => checkout(ctx, "cand", ctx.t0, 300, (s) => (s === "control_hidden_pipe" ? "none" : "conhost")));
ok(() => {
  assert.equal(r.report.labels.cand.controls.positive, "VISIBLE_BY_TIME");
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "VISIBLE_BY_TIME");
});

// 3. Observer blind: positive control not seen => every scenario INCONCLUSIVE, never NONE.
r = run((ctx) => checkout(ctx, "cand", ctx.t0, 400, () => "none"));
ok(() => {
  assert.equal(r.report.labels.cand.observerBlind, true);
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "INCONCLUSIVE");
  assert.equal(r.report.labels.cand.scenarios.consumer_stream.observedVerdict, "NONE");
  assert.notEqual(r.status, 0);
});

// 4. Cleanup evidence: a process without a stop event by scenario end is reported.
r = run((ctx) => checkout(ctx, "leaky", ctx.t0, 500, quiet));
ok(() => assert.deepEqual(r.report.labels.leaky.scenarios.consumer_quota.notStoppedByScenarioEnd, [{ pid: 505, name: "fixture-native.exe" }]));

const calibrated = (ctx, options, label = "cand", pid = 600) => {
  checkout(ctx, "base", ctx.t0, 100, reproduces);
  checkout(ctx, label, ctx.t0 + 40000, pid, quiet, options);
};

// 5. A consumer that threw / answered wrongly is FAILED, not "no window".
r = run((ctx) => calibrated(ctx, { failed: (s) => s === "consumer_raw" }));
ok(() => {
  assert.equal(verdictOf(r, "cand", "consumer_raw"), "FAILED");
  assert.equal(r.report.labels.cand.scenarios.consumer_raw.observedVerdict, "NONE");
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "NONE");
  assert.match(r.report.comparisons["cand:consumer_raw"], /^INCONCLUSIVE/);
  assert.equal(r.status, 3);
  assert.ok(r.report.problems.some((x) => x.startsWith("cand:consumer_raw: FAILED")));
});

// 6. Process capture unavailable (WMI refused): everything INCONCLUSIVE and the cause is named.
r = run((ctx) => checkout(ctx, "cand", ctx.t0, 700, quiet), { processCapture: "unavailable: access denied" });
ok(() => {
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "INCONCLUSIVE");
  assert.ok(r.report.labels.cand.blindReasons.some((x) => /process events unavailable/.test(x)));
});

// 7. Harness start never captured (no process events delivered): blind, even with windows seen.
r = run((ctx) => calibrated(ctx, { harnessStart: false }));
ok(() => {
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "INCONCLUSIVE");
  assert.ok(r.report.labels.cand.blindReasons.some((x) => /harness process start was not captured/.test(x)));
});

// 8. The parent had a console: not the daemon's shape, so no scenario may read as clean.
r = run((ctx) => calibrated(ctx, { parentConsole: true }));
ok(() => {
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "INCONCLUSIVE");
  assert.ok(r.report.labels.cand.blindReasons.some((x) => /parent had a console/.test(x)));
});

// 9. Zero child: the consumer "passed" but the fixture reported no start, or its start was never captured.
r = run((ctx) => calibrated(ctx, { reportNative: false }));
ok(() => assert.equal(verdictOf(r, "cand", "consumer_stream"), "FAILED"));
r = run((ctx) => calibrated(ctx, { captureNative: false }));
ok(() => {
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "INCONCLUSIVE");
  assert.match(r.report.labels.cand.scenarios.consumer_stream.reason, /not captured/);
});

// 10. No baseline: a quiet candidate has nothing to be compared with.
r = run((ctx) => checkout(ctx, "cand", ctx.t0, 800, quiet));
ok(() => {
  assert.match(r.report.comparisons["cand:consumer_stream"], /^INCONCLUSIVE: no baseline/);
  assert.ok(r.report.problems.some((x) => x.startsWith("base: no markers")));
  assert.equal(r.status, 3);
});

// 11. A scenario that never ran is INCONCLUSIVE, not absent; the negative control seeing a window is blind.
r = run((ctx) => calibrated(ctx, { only: SCENARIOS.filter((s) => s !== "consumer_login_help") }));
ok(() => assert.equal(verdictOf(r, "cand", "consumer_login_help"), "INCONCLUSIVE"));
r = run((ctx) => {
  checkout(ctx, "base", ctx.t0, 100, reproduces);
  checkout(ctx, "cand", ctx.t0 + 40000, 900, () => "owned");
});
ok(() => {
  assert.equal(verdictOf(r, "cand", "consumer_stream"), "INCONCLUSIVE");
  assert.ok(r.report.labels.cand.blindReasons.some((x) => /negative control saw a window/.test(x)));
});

console.log(`analyze.cjs synthetic self-test: ${count}/${count} passed`);
