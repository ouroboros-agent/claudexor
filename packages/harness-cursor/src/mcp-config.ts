import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtraMcpServer } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

/**
 * Engine-owned MCP injection for cursor-agent (the delegation belt, and any
 * future engine-owned server). Unlike claude (inline `--mcp-config` JSON) and
 * codex (`-c mcp_servers.*` overrides), cursor-agent has no stateless
 * transport: it reads `mcp.json` from its config dir. Claudexor already owns
 * the per-lane `CURSOR_CONFIG_DIR` (a Claudexor-created state dir under the
 * lane/profile HOME — INV-063: scoped vendor state stays outside every
 * worktree), so injection writes `<CURSOR_CONFIG_DIR>/mcp.json` there and the
 * run adds `--approve-mcps` so the headless agent does not stall on an
 * approval prompt.
 *
 * The write is a RECONCILE, not a blind overwrite: a sidecar manifest
 * (claudexor-managed-mcp.json) records exactly which server names Claudexor
 * injected, so a later run without `extra_mcp_servers` removes ONLY those
 * entries (a stale belt must never ride a non-delegate run — that would be an
 * undisclosed injection), while entries written by the vendor or a human are
 * preserved byte-for-byte.
 */

const MANAGED_MANIFEST = "claudexor-managed-mcp.json";

/** The lane config dir cursor-agent will actually read `mcp.json` from:
 * the explicit CURSOR_CONFIG_DIR when the env carries one (profile routes),
 * else the scoped HOME's `.cursor` (cursor's own default resolution). Null
 * when the env has neither — the HOST ~/.cursor is never touched. */
export function resolveCursorMcpConfigDir(
  env: Record<string, string | null | undefined>,
): string | null {
  const explicit = env["CURSOR_CONFIG_DIR"];
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const home = env["HOME"];
  if (typeof home === "string" && home.trim()) return join(home, ".cursor");
  return null;
}

type McpJson = { mcpServers: Record<string, unknown> } & Record<string, unknown>;

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readManagedNames(dir: string): string[] {
  const parsed = readJsonObject(join(dir, MANAGED_MANIFEST));
  return parsed["version"] === 1 && Array.isArray(parsed["names"])
    ? (parsed["names"] as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Reconcile `<dir>/mcp.json` so it contains EXACTLY the requested engine
 * servers among the Claudexor-managed entries: previously managed names are
 * removed, the requested servers written, and foreign entries preserved.
 * With no servers requested and nothing managed on disk this is a no-op
 * (`existsSync` only); when the reconciled file would carry no servers and no
 * foreign keys, both files are removed. Throws on an unwritable dir — the
 * caller surfaces that as a typed run error (never a silent drop, INV-030).
 */
export function syncCursorMcpServers(dir: string, servers: readonly ExtraMcpServer[]): void {
  const mcpPath = join(dir, "mcp.json");
  const managed = readManagedNames(dir);
  if (servers.length === 0 && managed.length === 0 && !existsSync(join(dir, MANAGED_MANIFEST))) {
    return;
  }
  const current = readJsonObject(mcpPath);
  const currentServers =
    current["mcpServers"] !== null &&
    typeof current["mcpServers"] === "object" &&
    !Array.isArray(current["mcpServers"])
      ? { ...(current["mcpServers"] as Record<string, unknown>) }
      : {};
  for (const name of managed) delete currentServers[name];
  for (const server of servers) {
    currentServers[server.name] = {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  }
  const next: McpJson = { ...current, mcpServers: currentServers };
  const empty =
    Object.keys(currentServers).length === 0 &&
    Object.keys(next).every((key) => key === "mcpServers");
  if (empty) {
    rmSync(mcpPath, { force: true });
    rmSync(join(dir, MANAGED_MANIFEST), { force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(mcpPath, `${JSON.stringify(next, null, 2)}\n`);
  const names = servers.map((server) => server.name);
  if (names.length > 0) {
    writeFileAtomic(
      join(dir, MANAGED_MANIFEST),
      `${JSON.stringify({ version: 1, names }, null, 2)}\n`,
    );
  } else {
    rmSync(join(dir, MANAGED_MANIFEST), { force: true });
  }
}

/**
 * One pre-spawn decision for runCursor: reconcile the lane's mcp.json —
 * writing the requested servers, or removing previously managed ones so a
 * stale belt never rides a non-delegate run — and report whether the run
 * must add `--approve-mcps`. A run that REQUESTED injection but has no
 * Claudexor-owned config dir to write into refuses loudly (the host
 * ~/.cursor is never written, and a silent drop would fake a capability —
 * INV-030/INV-063). On approval the env is pinned to the exact dir written.
 */
export function prepareCursorMcpInjection(
  env: Record<string, string | null | undefined>,
  servers: readonly ExtraMcpServer[],
): { approved: boolean } | { refusal: string } {
  const dir = resolveCursorMcpConfigDir(env);
  try {
    if (servers.length > 0 && dir === null) {
      return {
        refusal:
          "cursor MCP injection requires a Claudexor-owned lane config dir (CURSOR_CONFIG_DIR or a scoped HOME); the host ~/.cursor is never written",
      };
    }
    if (dir !== null) syncCursorMcpServers(dir, servers);
  } catch (err) {
    return {
      refusal: `cursor MCP injection failed before spawn: ${redactSecrets(
        err instanceof Error ? err.message : String(err),
      )}`,
    };
  }
  if (servers.length > 0) {
    env["CURSOR_CONFIG_DIR"] = dir;
    return { approved: true };
  }
  return { approved: false };
}
