import type { JournalManager, ProjectPartitions } from "@claudexor/daemon";
import { describe, expect, it, vi } from "vitest";
import { createStartupAdmissionRuntime } from "./daemon-admission-runtime.js";
import { DaemonStartupAdmission } from "./daemon-startup.js";

vi.mock("./daemon-lifecycle.js", () => ({
  logLine: vi.fn(),
  runStartupCrashGc: vi.fn(async () => {}),
}));

function runtimeFixture(initialBlocked: string[]) {
  const admission = new DaemonStartupAdmission();
  const messages: string[] = [];
  let liveBlocked = [...initialBlocked];
  let liveRefreshError: Error | null = null;
  const global = {
    ready: () => true,
    inspect: () => ({ status: "ready" }),
    revalidatePreparation: vi.fn(),
    activatePrepared: vi.fn(),
    recoverAfterStartup: vi.fn(),
  } as unknown as JournalManager;
  const partitions = {
    refreshPreparation: vi.fn(() => {
      if (liveRefreshError) throw liveRefreshError;
      return {
        coverage: "complete",
        fingerprint: null,
        registeredProjectIds: [],
        trustedProjectRoots: [],
        partitions: [],
        readyPartitions: [],
        recoveryRequiredPartitions: [...liveBlocked],
      };
    }),
    revalidatePreparation: vi.fn(),
    activatePrepared: vi.fn(),
    recoverAfterStartup: vi.fn(),
  } as unknown as ProjectPartitions;
  const runtime = createStartupAdmissionRuntime({
    admission,
    grant: { advanceFloor: vi.fn() },
    global,
    partitions,
    diagnostics: {
      diagnostics: null,
      recordStage: (_stage, message) => messages.push(message),
      recordFailure: vi.fn(),
      close: vi.fn(),
    },
    normalPlane: {
      requested: () => false,
      armQuotaPolling: vi.fn(),
      beginPidSnapshots: vi.fn(),
      migrateAccounts: vi.fn(),
      startSetup: vi.fn(async () => {}),
      quarantineGhosts: vi.fn(),
      scheduleRetention: vi.fn(),
    },
  });
  return {
    runtime,
    messages,
    partitions,
    setLiveBlocked: (blocked: string[]) => {
      liveBlocked = [...blocked];
    },
    setLiveRefreshError: (error: Error | null) => {
      liveRefreshError = error;
    },
  };
}

describe("startup admission recovery verdict ordering", () => {
  it("keeps a live recovery verdict authoritative over a delayed frozen startup callback", async () => {
    const first = "project:first";
    const second = "project:second";
    const fixture = runtimeFixture([first, second]);
    const quarantine = fixture.runtime.wrapQuarantineWithReopen(async () => {
      fixture.setLiveBlocked([second]);
      return { ok: true };
    });

    await quarantine(first, {});
    const frozenStartup = vi.fn(() => [first, second]);
    await fixture.runtime.runAdmissionCompletion(frozenStartup);

    const verdicts = fixture.messages.filter((message) => message.includes("recovery required:"));
    expect(verdicts.at(-1)).toContain(`recovery required: ${second})`);
    expect(verdicts.at(-1)).not.toContain(first);
    expect(frozenStartup).not.toHaveBeenCalled();
    expect(fixture.partitions.refreshPreparation).toHaveBeenCalledTimes(2);
  });

  it("retains the frozen startup verdict when the recovery service fails before mutation", async () => {
    const first = "project:first";
    const fixture = runtimeFixture([first]);
    const quarantine = fixture.runtime.wrapQuarantineWithReopen(async () => {
      throw new Error("quarantine refused");
    });

    await expect(quarantine(first, {})).rejects.toThrow("quarantine refused");
    const frozenStartup = vi.fn(() => [first]);
    await fixture.runtime.runAdmissionCompletion(frozenStartup);

    expect(frozenStartup).toHaveBeenCalledTimes(1);
    expect(fixture.partitions.refreshPreparation).not.toHaveBeenCalled();
    expect(fixture.messages.at(-1)).toContain(`recovery required: ${first})`);
  });

  it("retains the frozen startup verdict when the live recovery re-verdict fails", async () => {
    const first = "project:first";
    const fixture = runtimeFixture([first]);
    const quarantine = fixture.runtime.wrapQuarantineWithReopen(async () => {
      fixture.setLiveRefreshError(new Error("live preparation unavailable"));
      return { ok: true };
    });

    await expect(quarantine(first, {})).resolves.toEqual({ ok: true });
    const frozenStartup = vi.fn(() => [first]);
    await expect(fixture.runtime.runAdmissionCompletion(frozenStartup)).resolves.toBe(
      "recovery_only",
    );

    expect(frozenStartup).toHaveBeenCalledTimes(1);
    expect(fixture.partitions.refreshPreparation).toHaveBeenCalledTimes(1);
    expect(fixture.messages.at(-1)).toContain(`recovery required: ${first})`);
  });
});
