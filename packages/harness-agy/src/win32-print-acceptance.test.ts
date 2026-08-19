import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { killWindowsProcessTree } from "@claudexor/core";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const fixture = resolve(
  repoRoot,
  "packages",
  "core",
  "dist",
  "native-test",
  "claudexor-conpty-test-child.exe",
);
const worker = resolve(repoRoot, "scripts", "win32-agy-print-acceptance-worker.mjs");

interface FakeEvidence {
  mode: "print" | "hang" | "interactive";
  command: "model" | "quota";
  pid: number;
  consoleCodePage: number;
  windowPresent: boolean;
  coninAvailable: boolean;
  stdinEof: boolean;
  homeMatchesUserProfile: boolean;
  autoUpdateDisabled: boolean;
  providerKeysAbsent: boolean;
}

interface AcceptanceSummary {
  ok: boolean;
  workerPid: number;
  observedPids: number[];
  error?: string;
  paths: {
    config: string;
    evidenceB: string;
    browserSentinel: string;
  };
  control: { status: number; evidence: FakeEvidence[] };
  model: { kind: string; modelId: string | null };
  quota: {
    snapshots: Array<{
      subject: { subject_id: string };
      constraints: Array<{
        id: string;
        used_ratio: number | null;
        window_seconds: number | null;
        applies_to_unspecified_model?: boolean;
      }>;
    }>;
    absences: unknown[];
  };
  timeout: {
    result: { kind: string; reason?: string };
    pids: { vendor: number; descendant: number };
  };
  browserSentinelBeforeClientPty: boolean;
  browserSentinelAfterClientPty: boolean;
  login: {
    exit: number;
    signal: NodeJS.Signals | null;
    runnerPid: number;
    receipt: {
      commandStarted: boolean;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      errorCode?: string;
    } | null;
  };
  evidence: FakeEvidence[];
}

describe.skipIf(process.platform !== "win32")("Win32 agy print and client_pty acceptance", () => {
  it("keeps production print probes console-free while direct client_pty inherits CONIN$", async () => {
    expect(existsSync(fixture), `missing native fixture: ${fixture}`).toBe(true);
    expect(existsSync(worker), `missing acceptance worker: ${worker}`).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "claudexor-win32-agy-"));
    const resultPath = join(root, "acceptance-result.json");
    const child = spawn(
      fixture,
      [
        "--console-host",
        process.execPath,
        worker,
        "--repo-root",
        repoRoot,
        "--fixture",
        fixture,
        "--root",
        root,
        "--result",
        resultPath,
      ],
      {
        cwd: repoRoot,
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (!child.pid) throw new Error("console host PID was not assigned");
    const hostPid = child.pid;
    let summary: AcceptanceSummary | null = null;
    try {
      const completed = await withTimeout(collect(child), 45_000, "agy acceptance console host");
      if (existsSync(resultPath)) {
        summary = JSON.parse(readFileSync(resultPath, "utf8")) as AcceptanceSummary;
      }
      expect(completed.code, summary?.error ?? completed.stderr).toBe(0);
      expect(completed.signal).toBeNull();
      expect(summary?.ok, summary?.error).toBe(true);
      if (!summary?.ok) throw new Error(summary?.error ?? "acceptance worker failed");

      expect(parseConsoleState(completed.stdout, "HOST_BEFORE")).toEqual({
        consoleCodePage: 0,
        windowPresent: false,
        windowVisible: false,
        coninAvailable: false,
      });
      const hostAfter = parseConsoleState(completed.stdout, "HOST_AFTER");
      expect(hostAfter.consoleCodePage).toBeGreaterThan(0);
      expect(hostAfter.coninAvailable).toBe(true);

      expect(summary.paths.config).toBe(join(root, "config.yaml"));
      expect(existsSync(summary.paths.config)).toBe(true);
      expect(summary.model).toEqual({
        kind: "authenticated",
        modelId: "gemini-3.7-flash-high",
      });
      expect(summary.quota.absences).toEqual([]);
      expect(summary.quota.snapshots).toHaveLength(1);
      expect(summary.quota.snapshots[0]?.subject.subject_id).toBe("agy-win-a");
      expect(summary.quota.snapshots[0]?.constraints).toEqual([
        expect.objectContaining({
          id: "gemini-weekly",
          used_ratio: 0.75,
          window_seconds: 7 * 24 * 60 * 60,
          applies_to_unspecified_model: true,
        }),
      ]);

      const printEvidence = summary.evidence.filter(
        (row) => row.mode === "print" || row.mode === "hang",
      );
      expect(printEvidence.filter((row) => row.mode === "print")).toHaveLength(3);
      expect(printEvidence.filter((row) => row.mode === "hang")).toHaveLength(1);
      expect(printEvidence.filter((row) => row.command === "quota")).toHaveLength(1);
      for (const row of printEvidence) {
        expect(row).toMatchObject({
          consoleCodePage: 0,
          windowPresent: false,
          coninAvailable: false,
          stdinEof: true,
          homeMatchesUserProfile: true,
          autoUpdateDisabled: true,
          providerKeysAbsent: true,
        });
      }
      const clientPty = summary.evidence.filter((row) => row.mode === "interactive");
      expect(clientPty).toHaveLength(1);
      expect(clientPty[0]).toMatchObject({
        command: "model",
        coninAvailable: true,
        homeMatchesUserProfile: true,
        autoUpdateDisabled: true,
        providerKeysAbsent: true,
      });
      expect(clientPty[0]!.consoleCodePage).toBeGreaterThan(0);

      expect(summary.control.status).toBe(0);
      expect(summary.control.evidence).toHaveLength(1);
      expect(summary.control.evidence[0]).toMatchObject({
        mode: "interactive",
        coninAvailable: true,
        homeMatchesUserProfile: true,
        autoUpdateDisabled: true,
        providerKeysAbsent: true,
      });
      expect(summary.control.evidence[0]!.consoleCodePage).toBeGreaterThan(0);
      expect(existsSync(summary.paths.evidenceB)).toBe(false);
      expect(summary.browserSentinelBeforeClientPty).toBe(false);
      expect(summary.browserSentinelAfterClientPty).toBe(true);
      expect(existsSync(summary.paths.browserSentinel)).toBe(true);

      expect(summary.timeout.result).toMatchObject({
        kind: "failed",
        reason: "termination_unconfirmed",
      });
      expect(summary.login.exit).toBe(0);
      expect(summary.login.signal).toBeNull();
      expect(summary.login.runnerPid).toBeGreaterThan(0);
      expect(summary.login.receipt).toMatchObject({
        commandStarted: true,
        exitCode: 0,
        signal: null,
      });
      expect(summary.login.receipt).not.toHaveProperty("errorCode");
      for (const row of [...summary.evidence, ...summary.control.evidence]) {
        expect(row.pid).toBeGreaterThan(0);
      }

      const observedPids = [
        hostPid,
        summary.workerPid,
        summary.timeout.pids.vendor,
        summary.timeout.pids.descendant,
        summary.login.runnerPid,
        ...summary.observedPids,
        ...summary.evidence.map((row) => row.pid),
        ...summary.control.evidence.map((row) => row.pid),
      ];
      await expectPidsGone(observedPids, 5_000);
    } finally {
      const exactPids = new Set<number>([hostPid]);
      if (summary) {
        exactPids.add(summary.workerPid);
        for (const pid of summary.observedPids ?? []) exactPids.add(pid);
        exactPids.add(summary.timeout?.pids.vendor ?? 0);
        exactPids.add(summary.timeout?.pids.descendant ?? 0);
        for (const row of summary.evidence ?? []) exactPids.add(row.pid);
        for (const row of summary.control?.evidence ?? []) exactPids.add(row.pid);
      }
      for (const pid of exactPids) {
        if (pid > 0 && pidAlive(pid)) killWindowsProcessTree(pid);
      }
      try {
        await expectPidsGone([...exactPids], 5_000);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 60_000);
});

interface CollectedChild {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function collect(child: ChildProcess): Promise<CollectedChild> {
  if (!child.stdout || !child.stderr) throw new Error("console host pipes were not created");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return await new Promise<CollectedChild>((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal, stdout, stderr }));
  });
}

function parseConsoleState(
  output: string,
  label: string,
): {
  consoleCodePage: number;
  windowPresent: boolean;
  windowVisible: boolean;
  coninAvailable: boolean;
} {
  const match = new RegExp(`${label}\\t([0-9]+)\\t([01])\\t([01])\\t([01])`).exec(output);
  if (!match) throw new Error(`invalid ${label} console state`);
  return {
    consoleCodePage: Number(match[1]),
    windowPresent: match[2] === "1",
    windowVisible: match[3] === "1",
    coninAvailable: match[4] === "1",
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectPidsGone(pids: number[], timeoutMs: number): Promise<void> {
  const unique = [...new Set(pids.filter((pid) => pid > 0))];
  const deadline = Date.now() + timeoutMs;
  while (unique.some(pidAlive)) {
    if (Date.now() >= deadline) throw new Error(`processes survived cleanup: ${unique.join(",")}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
