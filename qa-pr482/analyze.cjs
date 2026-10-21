"use strict";
// Merge observer evidence with harness markers into per-scenario verdicts.
// usage: node analyze.cjs <out-dir>   -> writes verdict.json and summary.md there
// exit 0: every required checkout (base, cand) has a decided verdict for every scenario
// exit 3: anything FAILED, INCONCLUSIVE, missing or not exited cleanly (see `problems`)
//
// Verdict vocabulary (per checkout label and scenario):
//   FAILED     the consumer threw, answered wrongly, never reached the native fixture, or
//              did not finish: nothing about windows may be concluded from it
//   INCONCLUSIVE  the consumer ran, but the observation cannot support "no flash":
//              the window hook or process events did not work, the harness process or
//              the native child was not captured, the parent had a console, or a control
//              did not behave (positive control not seen / negative control seen)
//   VISIBLE    a WS_VISIBLE top-level window owned by the scenario's process tree
//   VISIBLE_BY_TIME  a visible window owned by a console host (conhost, OpenConsole,
//              Windows Terminal) whose process is not linked to the tree, during
//              the interval: attributed by time only, calibrated by the controls
//   NONE       no such window, and no unattributed visible window in the interval
//   AMBIGUOUS  only another unattributed visible window appeared in the interval
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(process.argv[2]);
const EXPECTED_SCENARIOS = [
  "control_visible_pipe",
  "control_hidden_pipe",
  "consumer_stream",
  "consumer_raw",
  "consumer_quota",
  "consumer_effort",
  "consumer_quota_native",
  "consumer_effort_native",
  "consumer_install_proof",
  "consumer_install_proof_native",
  "consumer_login_help",
];
const REQUIRED_LABELS = ["base", "cand"];
const CONSOLE_HOSTS = /^(conhost|openconsole|windowsterminal)(\.exe)?$/i;
const SEEN = (verdict) => verdict === "VISIBLE" || verdict === "VISIBLE_BY_TIME";

let parseErrors = 0;
const lines = (name) =>
  fs.existsSync(path.join(dir, name))
    ? fs
        .readFileSync(path.join(dir, name), "utf8")
        .split(/\r?\n/)
        .map((line) => line.replace(/^﻿/, "").trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            parseErrors += 1;
            return [];
          }
        })
    : [];
const json = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
};
const host = json("observer-host.json");
const inputs = json("run-inputs.json");
const windows = lines("observer-windows.jsonl");
const processes = lines("observer-processes.jsonl");
const hookInstalled = windows.some((w) => w.source === "observer" && w.hookInstalled === true);
const processCapture = processes.find((p) => p.kind === "observer" && p.processCapture)?.processCapture ?? "missing";
const starts = processes.filter((p) => p.kind === "start");
const stops = new Map(processes.filter((p) => p.kind === "stop").map((p) => [p.pid, p]));

function descendants(rootPid, from, to) {
  // PIDs can be reused: only process starts inside [from, to] join the tree.
  const tree = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of starts)
      if (p.at >= from && p.at <= to && tree.has(p.ppid) && !tree.has(p.pid)) {
        tree.add(p.pid);
        grew = true;
      }
  }
  return tree;
}

const labels = fs
  .readdirSync(dir)
  .filter((name) => /^markers-.+\.jsonl$/.test(name))
  .map((name) => name.slice("markers-".length, -".jsonl".length));
const report = {
  inputs,
  host,
  capture: { hookInstalled, processCapture, windowEvents: windows.length, processEvents: starts.length, parseErrors },
  labels: {},
  problems: [],
};

for (const label of labels) {
  const marks = lines(`markers-${label}.jsonl`);
  const harness = marks.find((m) => m.event === "harness_start");
  const end = marks.find((m) => m.event === "harness_end") ?? marks.at(-1);
  const harnessError = marks.find((m) => m.event === "harness_error")?.error ?? null;
  const exitInfo = json(`harness-${label}.exit.json`);
  if (!harness) {
    report.labels[label] = { harnessStarted: false, harnessError, exitInfo, observerBlind: true, blindReasons: ["no harness_start marker"], controls: {}, scenarios: {} };
    continue;
  }
  const tree = descendants(harness.pid, harness.at - 1000, end.at + 5000);
  const harnessProcess = starts.find((p) => p.pid === harness.pid);
  const ownConsoleHost = starts.filter((p) => p.ppid === harness.pid && CONSOLE_HOSTS.test(p.name));
  const scenarios = {};
  for (const startMark of marks.filter((m) => m.event === "scenario_start")) {
    const endMark = marks.find((m) => m.event === "scenario_end" && m.scenario === startMark.scenario);
    const from = startMark.at - 50;
    const to = (endMark ?? end).at + 250;
    const created = starts.filter((p) => p.at >= from && p.at <= to && tree.has(p.pid));
    const inInterval = windows.filter((w) => w.source !== "observer" && w.at >= from && w.at <= to);
    const attributed = inInterval.filter((w) => tree.has(w.pid));
    const visible = attributed.filter((w) => w.visible);
    const unattributedVisible = inInterval.filter((w) => w.visible && !tree.has(w.pid));
    const consoleHostVisible = unattributedVisible.filter((w) => CONSOLE_HOSTS.test(w.image));
    const survivors = created
      .filter((p) => !CONSOLE_HOSTS.test(p.name))
      .filter((p) => {
        const stop = stops.get(p.pid);
        return !stop || stop.at > to;
      });
    // The fixture reports its own pid; the process capture must independently have seen
    // that pid start inside this harness's tree. Neither alone proves attribution.
    const nativePids = endMark?.nativePids ?? [];
    const nativeCaptured = nativePids.filter((pid) => created.some((p) => p.pid === pid));
    const observedVerdict = visible.length
      ? "VISIBLE"
      : consoleHostVisible.length
        ? "VISIBLE_BY_TIME"
        : unattributedVisible.length
          ? "AMBIGUOUS"
          : "NONE";
    let execution = "ok";
    let reason = null;
    if (!endMark) [execution, reason] = ["failed", "the harness has no scenario_end marker (it died or hung)"];
    else if (endMark.result?.status !== "pass") [execution, reason] = ["failed", (endMark.result?.error ?? "consumer assertion failed").split("\n")[0]];
    else if (nativePids.length === 0) [execution, reason] = ["failed", "no native fixture start was reported"];
    else if (nativeCaptured.length === 0) [execution, reason] = ["unobserved", "the native child's start was not captured under the harness (process events or parentage missing)"];
    scenarios[startMark.scenario] = {
      verdict: execution === "failed" ? "FAILED" : execution === "unobserved" ? "INCONCLUSIVE" : observedVerdict,
      observedVerdict,
      reason,
      result: endMark?.result ?? null,
      nativePids,
      nativeCapturedPids: nativeCaptured,
      nativeCalls: endMark?.nativeCalls ?? [],
      processes: created.map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name })),
      consoleHostsStarted: created.filter((p) => CONSOLE_HOSTS.test(p.name)).map((p) => p.pid),
      visibleWindows: visible,
      hiddenWindows: attributed.filter((w) => !w.visible).length,
      unattributedVisible,
      notStoppedByScenarioEnd: survivors.map((p) => ({ pid: p.pid, name: p.name })),
    };
  }
  for (const name of EXPECTED_SCENARIOS)
    scenarios[name] ??= {
      verdict: "INCONCLUSIVE", observedVerdict: null, reason: "scenario never started", result: null, nativePids: [], nativeCapturedPids: [],
      nativeCalls: [], processes: [], consoleHostsStarted: [], visibleWindows: [], hiddenWindows: 0, unattributedVisible: [], notStoppedByScenarioEnd: [],
    };

  // Calibration. Controls are a precondition of every other scenario's window verdict.
  const positive = scenarios.control_visible_pipe;
  const negative = scenarios.control_hidden_pipe;
  const blindReasons = [];
  if (!hookInstalled) blindReasons.push("window hook not installed");
  if (processCapture !== "registered") blindReasons.push(`process events ${processCapture}`);
  if (!harnessProcess) blindReasons.push("the harness process start was not captured (process events not delivered or harness not under the observer)");
  if (ownConsoleHost.length) blindReasons.push("a console host started for the harness: the parent had a console, so it does not represent the daemon");
  if (positive.verdict === "FAILED" || (positive.verdict === "INCONCLUSIVE" && positive.reason)) blindReasons.push(`positive control did not execute (${positive.reason})`);
  else if (!SEEN(positive.observedVerdict)) blindReasons.push(`positive control not seen (${positive.observedVerdict})`);
  if (negative.verdict === "FAILED" || (negative.verdict === "INCONCLUSIVE" && negative.reason)) blindReasons.push(`negative control did not execute (${negative.reason})`);
  else if (negative.observedVerdict !== "NONE") blindReasons.push(`negative control saw a window (${negative.observedVerdict})`);
  const blind = blindReasons.length > 0;
  if (blind)
    for (const scenario of Object.values(scenarios)) if (scenario.verdict !== "FAILED") scenario.verdict = "INCONCLUSIVE";
  report.labels[label] = {
    harnessPid: harness.pid,
    harnessStarted: true,
    harnessStartedByObserver: Boolean(harnessProcess),
    harnessConsoleHostsStarted: ownConsoleHost.map((p) => p.pid),
    harnessError,
    exitInfo,
    observerBlind: blind,
    blindReasons,
    controls: { positive: positive.verdict, negative: negative.verdict },
    scenarios,
  };
}

// Baseline/candidate reading for each consumer, never upgraded past the evidence.
const comparisons = {};
const baseline = report.labels.base;
const decided = (verdict) => verdict !== undefined && verdict !== "INCONCLUSIVE" && verdict !== "FAILED";
for (const [label, data] of Object.entries(report.labels)) {
  if (label === "base") continue;
  for (const name of EXPECTED_SCENARIOS) {
    if (name.startsWith("control_")) continue;
    const before = baseline?.scenarios[name]?.verdict;
    const after = data.scenarios[name]?.verdict;
    comparisons[`${label}:${name}`] = !baseline
      ? "INCONCLUSIVE: no baseline checkout was observed"
      : !decided(before) || !decided(after)
        ? `INCONCLUSIVE: baseline ${before ?? "missing"}, ${label} ${after ?? "missing"}`
        : /^VISIBLE/.test(before) && after === "NONE"
          ? "baseline window reproduced; none with this checkout on this host"
          : !/^VISIBLE/.test(before) && after === "NONE"
            ? "baseline did not reproduce a window: NONE here is not evidence of the fix"
            : `baseline ${before}, ${label} ${after}`;
  }
}
report.comparisons = comparisons;

// Completeness: what makes this run unfit to read as evidence.
for (const label of REQUIRED_LABELS) {
  const data = report.labels[label];
  if (!data) {
    report.problems.push(`${label}: no markers (checkout not observed)`);
    continue;
  }
  if (data.harnessError) report.problems.push(`${label}: harness error: ${data.harnessError.split("\n")[0]}`);
  if (!data.exitInfo) report.problems.push(`${label}: no harness exit record`);
  else if (data.exitInfo.code !== 0 && data.exitInfo.code !== 3) report.problems.push(`${label}: harness exit ${JSON.stringify(data.exitInfo)}`);
  for (const reason of data.blindReasons) report.problems.push(`${label}: observer blind: ${reason}`);
  for (const [name, scenario] of Object.entries(data.scenarios))
    if (scenario.verdict === "FAILED" || scenario.verdict === "INCONCLUSIVE")
      report.problems.push(`${label}:${name}: ${scenario.verdict}${scenario.reason ? ` (${scenario.reason})` : ""}`);
}
if (parseErrors) report.problems.push(`${parseErrors} unparseable evidence line(s)`);
if (!host) report.problems.push("observer-host.json missing");
report.complete = report.problems.length === 0;
fs.writeFileSync(path.join(dir, "verdict.json"), JSON.stringify(report, null, 2));

const summary = [
  "# PR482 Windows window observation",
  "",
  `Evidence complete: **${report.complete ? "yes" : "NO"}**`,
  "",
  inputs
    ? `Inputs: ${Object.entries(inputs.refs ?? {}).map(([k, v]) => `${k} \`${v.requested ?? ""}\` -> \`${v.resolved ?? "?"}\``).join("; ")}; runner image ${inputs.runner?.imageVersion ?? "?"}; node ${inputs.runner?.node ?? "?"}; event ${inputs.event ?? "?"}`
    : "Inputs: run-inputs.json missing",
  `Host: ${host ? `${host.osCaption} build ${host.osBuild} (productType ${host.productType}); session ${host.observerSessionId}; station ${host.windowStation}; desktop ${host.desktop}; input desktop ${host.inputDesktop || "not accessible"}; userInteractive ${host.userInteractive}` : "missing"}`,
  `Console host: conhost ${host?.conhostVersion ?? "?"}; DelegationConsole ${host?.delegationConsole ?? "unset"}; DelegationTerminal ${host?.delegationTerminal ?? "unset"}; Windows Terminal ${host?.windowsTerminal ?? "not installed"}`,
  `Capture: window hook ${hookInstalled ? "installed" : "NOT installed"}; process events ${processCapture}; ${starts.length} process starts, ${windows.length} window records`,
  "",
  "A Windows Server runner with conhost does not stand for Windows 11 with Windows Terminal as the default terminal.",
  "",
  "| checkout | scenario | verdict | windows (visible/hidden) | console hosts | not stopped at end |",
  "|---|---|---|---|---|---|",
];
for (const [label, data] of Object.entries(report.labels))
  for (const [name, s] of Object.entries(data.scenarios))
    summary.push(
      `| ${label} | ${name} | ${s.verdict}${s.observedVerdict && s.observedVerdict !== s.verdict ? ` (observed ${s.observedVerdict})` : ""} | ${s.visibleWindows.length}/${s.hiddenWindows} | ${s.consoleHostsStarted.length} | ${s.notStoppedByScenarioEnd.map((p) => p.name).join(", ") || "-"} |`,
    );
summary.push("", "## Comparisons", "");
for (const [key, value] of Object.entries(comparisons)) summary.push(`- ${key}: ${value}`);
summary.push("", "## Problems", "");
if (report.problems.length) for (const problem of report.problems) summary.push(`- ${problem}`);
else summary.push("- none");
fs.writeFileSync(path.join(dir, "summary.md"), `${summary.join("\n")}\n`);
process.stdout.write(`${summary.join("\n")}\n`);
process.exitCode = report.complete ? 0 : 3;
