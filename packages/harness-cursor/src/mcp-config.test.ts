import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliRunLoopOptions } from "@claudexor/core";
import { ExtraMcpServer, HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createCursorAdapter } from "./index.js";
import {
  prepareCursorMcpInjection,
  resolveCursorMcpConfigDir,
  syncCursorMcpServers,
} from "./mcp-config.js";

const belt = (name = "claudexor") =>
  ExtraMcpServer.parse({
    name,
    command: "/usr/bin/node",
    args: ["/opt/claudexord.js", "mcp", "serve-belt"],
    env: { CLAUDEXOR_CONFIG_DIR: "/real/config" },
    required: true,
  });

describe("cursor mcp.json injection (delegation belt host)", () => {
  const dirs: string[] = [];
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-cursor-mcp-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the lane config dir: explicit CURSOR_CONFIG_DIR, then scoped HOME, never the host", () => {
    expect(resolveCursorMcpConfigDir({ CURSOR_CONFIG_DIR: "/lane/.cursor" })).toBe("/lane/.cursor");
    expect(resolveCursorMcpConfigDir({ HOME: "/lane" })).toBe(join("/lane", ".cursor"));
    expect(
      resolveCursorMcpConfigDir({ CURSOR_CONFIG_DIR: "/lane/.cursor", HOME: "/other" }),
    ).toBe("/lane/.cursor");
    expect(resolveCursorMcpConfigDir({})).toBeNull();
    expect(resolveCursorMcpConfigDir({ HOME: "  " })).toBeNull();
  });

  it("writes the belt descriptor as mcp.json plus a managed-name sidecar", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    const written = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(written).toEqual({
      mcpServers: {
        claudexor: {
          command: "/usr/bin/node",
          args: ["/opt/claudexord.js", "mcp", "serve-belt"],
          env: { CLAUDEXOR_CONFIG_DIR: "/real/config" },
        },
      },
    });
    expect(JSON.parse(readFileSync(join(dir, "claudexor-managed-mcp.json"), "utf8"))).toEqual({
      version: 1,
      names: ["claudexor"],
    });
  });

  it("a later run without servers removes ONLY managed entries; foreign ones survive", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    // A human/vendor entry lands beside ours between runs.
    const current = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    current.mcpServers["user_tool"] = { command: "/usr/local/bin/thing", args: [] };
    writeFileSync(join(dir, "mcp.json"), JSON.stringify(current));
    syncCursorMcpServers(dir, []);
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { user_tool: { command: "/usr/local/bin/thing", args: [] } },
    });
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(false);
  });

  it("a stale belt with no foreign entries is removed entirely (no undisclosed injection)", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    syncCursorMcpServers(dir, []);
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
    expect(existsSync(join(dir, "claudexor-managed-mcp.json"))).toBe(false);
  });

  it("tolerates a corrupt mcp.json and repairs it on the next injection", () => {
    const dir = join(scratch(), ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    writeFileSync(join(dir, "mcp.json"), "{not json");
    syncCursorMcpServers(dir, [belt()]);
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers),
    ).toEqual(["claudexor"]);
  });

  it("no servers and nothing managed is a pure no-op (no dir created)", () => {
    const dir = join(scratch(), "never-created", ".cursor");
    syncCursorMcpServers(dir, []);
    expect(existsSync(dir)).toBe(false);
  });

  it("prepareCursorMcpInjection refuses without a Claudexor-owned dir and pins the env on approval", () => {
    const noDir = prepareCursorMcpInjection({}, [belt()]);
    expect(noDir).toHaveProperty("refusal");
    expect((noDir as { refusal: string }).refusal).toContain("never written");
    const home = scratch();
    const env: Record<string, string | null | undefined> = { HOME: home };
    const approved = prepareCursorMcpInjection(env, [belt()]);
    expect(approved).toEqual({ approved: true });
    expect(env["CURSOR_CONFIG_DIR"]).toBe(join(home, ".cursor"));
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
  });
});

describe("cursor adapter belt wiring (runCursor)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const spec = (overrides: Partial<HarnessRunSpec> = {}): HarnessRunSpec =>
    HarnessRunSpec.parse({
      session_id: "s-cursor-belt",
      intent: "implement",
      prompt: "delegate things",
      cwd: "/repo",
      ...overrides,
    });

  const adapterCapturing = (sink: { opts?: CliRunLoopOptions }) =>
    createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ kind: "authenticated" as const }),
      cursorApiKey: () => null,
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "unused" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        sink.opts = opts;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

  it("writes the belt into the lane config dir and adds --approve-mcps", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-lane-"));
    dirs.push(home);
    const sink: { opts?: CliRunLoopOptions } = {};
    const events: HarnessEvent[] = [];
    for await (const ev of adapterCapturing(sink).run(
      spec({
        env: { HOME: home, AGENT_CLI_CREDENTIAL_STORE: "file" },
        extra_mcp_servers: [belt()],
      }),
    )) {
      events.push(ev);
    }
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.every((ev) => ev.type !== "error")).toBe(true);
    expect(sink.opts?.args).toContain("--approve-mcps");
    const dir = sink.opts?.env?.["CURSOR_CONFIG_DIR"];
    expect(typeof dir).toBe("string");
    const written = JSON.parse(readFileSync(join(dir as string, "mcp.json"), "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["claudexor"]);
  });

  it("refuses typed (never a silent drop) when injection has no lane dir", async () => {
    // An API-key route with NO scoped HOME resolves fine — but injection has
    // nowhere Claudexor-owned to write, and the host ~/.cursor is off-limits.
    const sink: { opts?: CliRunLoopOptions } = {};
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ kind: "loggedOut" as const }),
      cursorApiKey: () => "cursor-key",
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "ok" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        sink.opts = opts;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      spec({ env: {}, auth_preference: "api_key", extra_mcp_servers: [belt()] }),
    )) {
      events.push(ev);
    }
    expect(sink.opts).toBeUndefined();
    expect(events[0]).toMatchObject({
      type: "error",
      payload: { code: "required_mcp_startup_failed" },
    });
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("an ordinary run does not add --approve-mcps and clears a stale managed belt", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-stale-"));
    dirs.push(home);
    const dir = join(home, ".cursor");
    syncCursorMcpServers(dir, [belt()]);
    const sink: { opts?: CliRunLoopOptions } = {};
    for await (const ev of adapterCapturing(sink).run(
      spec({ env: { HOME: home, AGENT_CLI_CREDENTIAL_STORE: "file" } }),
    )) {
      void ev;
    }
    expect(sink.opts?.args).not.toContain("--approve-mcps");
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
  });
});
