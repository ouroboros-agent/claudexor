import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
}));

// Partial mocks (spread the real module) so the wide ops-commands import graph
// keeps every other export intact — only the daemon seam is stubbed.
vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureDaemon: mocks.ensureDaemon,
}));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  controlApiFetch: mocks.controlApiFetch,
}));

import { parseArgs } from "./args.js";
import { doctorCommand } from "./ops-commands.js";

function harness(configuredModelCheck: { status: "ok" | "rejected"; message?: string | null }) {
  return {
    harnesses: [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [],
        enabledIntents: ["explain"],
        routableIntents: ["explain"],
        disabledIntents: [],
        checks: [],
        reasons: [],
        configuredModel: "claude-opus-5-5",
        configuredModelCheck,
      },
    ],
  };
}

const routeHealth = {
  windowDays: 7,
  from: "2026-10-21T12:00:00.000Z",
  generatedAt: "2026-10-28T12:00:00.000Z",
  scannedRuns: 125,
  complete: true,
  incompleteReason: null,
  routes: [
    {
      harnessId: "agy",
      access: "readonly",
      runs: 123,
      succeeded: 57,
      failed: 64,
      cancelled: 2,
      other: 0,
      topFailures: [
        {
          category: "harness_error",
          code: null,
          message: "agy headless tool permission refused: read_file",
          count: 38,
        },
      ],
    },
    {
      harnessId: "claude",
      access: "readonly",
      runs: 2,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
      other: 0,
      topFailures: [],
    },
  ],
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("the human doctor output and the configured-model verdict (INV-104)", () => {
  let out: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    mocks.ensureDaemon.mockResolvedValue({ addr: { host: "127.0.0.1", port: 1, token: "t" } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function serve(
    check: { status: "ok" | "rejected"; message?: string | null },
    health: () => Response = () => jsonResponse(routeHealth),
  ) {
    mocks.controlApiFetch.mockImplementation(async (_addr: unknown, path: string) =>
      path.startsWith("/daemon/route-health") ? health() : jsonResponse(harness(check)),
    );
  }

  async function doctorText(check: { status: "ok" | "rejected"; message?: string | null }) {
    serve(check);
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude"]), false)).toBe(0);
    return out.join("");
  }

  it("prints the admission note of an advisory harness beside the model", async () => {
    const text = await doctorText({
      status: "ok",
      message: 'model "claude-opus-5-5" is not in this account\'s listed models; forwarded',
    });
    expect(text).toContain(
      'model: claude-opus-5-5 — model "claude-opus-5-5" is not in this account\'s listed models; forwarded',
    );
  });

  it("stays silent for a listed model and still shouts for a refused one", async () => {
    expect(await doctorText({ status: "ok", message: null })).not.toContain("model:");
    out.length = 0;
    expect(await doctorText({ status: "rejected", message: "not in the truth source" })).toContain(
      "model: INVALID — not in the truth source",
    );
  });

  it("prints the daemon's route health after the harness rows: a summary and the failing routes", async () => {
    const text = await doctorText({ status: "ok", message: null });
    const lines = text.split("\n");
    const summary = lines.indexOf(
      "route health, last 7 days: 125 run(s) over 2 route(s), 1 with failures",
    );
    expect(summary).toBeGreaterThan(lines.indexOf("[ok] claude"));
    expect(lines[summary + 1]).toBe(
      "    agy readonly: 64/123 failed (52%), 2 cancelled; most: harness_error — agy headless tool permission refused: read_file ×38",
    );
    expect(text).not.toContain("claude readonly:");
  });

  it("carries the same answer under route_health in --json", async () => {
    serve({ status: "ok", message: null });
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude", "--json"]), true)).toBe(
      0,
    );
    const envelope = JSON.parse(out.join("")) as { route_health: unknown; harnesses: unknown[] };
    expect(envelope.route_health).toEqual(routeHealth);
    expect(envelope.harnesses).toHaveLength(1);
  });

  it("names an older engine without the read (404) in both forms instead of failing doctor", async () => {
    const older = () => new Response("no such route", { status: 404 });
    serve({ status: "ok", message: null }, older);
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude"]), false)).toBe(0);
    expect(out.join("")).toContain("? route health: unavailable from this engine version");
    out.length = 0;
    serve({ status: "ok", message: null }, older);
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude", "--json"]), true)).toBe(
      0,
    );
    expect((JSON.parse(out.join("")) as { route_health: unknown }).route_health).toBeNull();
  });
});
