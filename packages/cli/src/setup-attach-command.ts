import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, constants, existsSync, openSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { daemonDir } from "@claudexor/daemon";
import { type ParsedArgs } from "./args.js";
import { printUsageError } from "./cli-io.js";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { resolveSetupLoginRunnerPath } from "./setup-job-support.js";
import { runnerBootstrapEnv } from "./setup-login-runner-support.js";

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        process.stderr.write(`claudexor setup attach: runner exited on ${signal}\n`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

export function claimSetupAttachment(directory: string): void {
  const path = join(directory, "client-pty-attached");
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new Error("setup job already has a client_pty attachment");
  }
  closeSync(descriptor);
}

export interface SetupAttachRunnerInvocation {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * Windows must keep the login worker in the terminal that attached the job:
 * entering `--worker` directly avoids the detached bootstrap hop that daemon-
 * hosted jobs require. POSIX retains the existing bootstrap invocation.
 */
export function setupAttachRunnerInvocation(input: {
  platform: NodeJS.Platform;
  nodePath: string;
  runnerPath: string;
  manifestPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): SetupAttachRunnerInvocation {
  if (input.platform === "win32") {
    return {
      command: input.nodePath,
      args: [input.runnerPath, "--worker", input.manifestPath],
      options: {
        cwd: input.cwd,
        stdio: "inherit",
        env: runnerBootstrapEnv(input.env),
        detached: false,
      },
    };
  }
  return {
    command: input.nodePath,
    args: [input.runnerPath, input.manifestPath],
    options: { cwd: input.cwd, stdio: "inherit", env: input.env },
  };
}

/**
 * One owner for the interactive setup attachment role. The full CLI and the
 * packaged daemon bundle both enter here; neither re-authors daemon lookup,
 * the one-use claim, adjacent runner resolution, nor the Windows worker shape.
 */
export async function setupAttachCommand(argv: readonly string[], json: boolean): Promise<number> {
  const sub = argv[1];
  const jobId = argv[2];
  if (
    argv[0] !== "setup" ||
    sub !== "attach" ||
    typeof jobId !== "string" ||
    !/^setup-[A-Za-z0-9-]+$/.test(jobId) ||
    argv.length !== 3
  ) {
    return printUsageError(json, "usage: claudexor setup attach <jobId>");
  }
  if (json) {
    return printUsageError(
      true,
      "claudexor setup attach owns an interactive PTY and cannot use --json",
    );
  }
  const daemon = await connectDaemonIfRunning();
  if (!daemon) throw new Error("setup daemon is not running");
  const response = await controlApiFetch(daemon.addr, `/setup/jobs/${encodeURIComponent(jobId)}`);
  const body = (await response.json()) as {
    state?: string;
    phase?: string;
    transport?: string;
  };
  if (!response.ok) throw new Error(`setup job lookup failed (HTTP ${response.status})`);
  if (body.transport !== "client_pty") {
    throw new Error("setup job is not authorized for client_pty attachment");
  }
  if (
    !["queued", "running", "waiting_for_input"].includes(body.state ?? "") ||
    !["launching", "awaiting_user"].includes(body.phase ?? "")
  ) {
    throw new Error(`setup job is not attachable (${body.state ?? "unknown"})`);
  }
  const artifactDirectory = join(daemonDir(), "setup-artifacts", jobId);
  const manifest = join(artifactDirectory, "runner-manifest.json");
  if (!existsSync(manifest)) throw new Error("sealed setup manifest is unavailable");
  const runner = resolveSetupLoginRunnerPath();
  if (!existsSync(runner)) throw new Error("setup login runner is unavailable");
  // A sealed login job authorizes exactly one terminal runner. O_EXCL is the
  // cross-process fence; the marker intentionally survives a crashed client so
  // users cancel/recreate instead of accidentally launching the vendor login
  // twice against one daemon-owned job.
  claimSetupAttachment(artifactDirectory);
  const invocation = setupAttachRunnerInvocation({
    platform: platform(),
    nodePath: process.execPath,
    runnerPath: runner,
    manifestPath: manifest,
    cwd: artifactDirectory,
    env: process.env,
  });
  return waitForChild(spawn(invocation.command, invocation.args, invocation.options));
}

/** Full-CLI adapter over the shared raw-argv role owner. */
export function setupCommand(args: Pick<ParsedArgs, "_">, json: boolean): Promise<number> {
  return setupAttachCommand(args._, json);
}
