import { describe, expect, it } from "vitest";
import { EngineRuntimeUnsupportedError } from "./errors.js";
import { compareDottedVersions, ENGINE_SQLITE_MIN_VERSION, loadEngineRuntime } from "./runtime.js";

describe("engine runtime refusal (Node 20/22 without the WAL-reset fix)", () => {
  it("orders dotted versions numerically", () => {
    expect(compareDottedVersions("3.51.3", "3.51.3")).toBe(0);
    expect(compareDottedVersions("3.51.2", "3.51.3")).toBe(-1);
    expect(compareDottedVersions("3.53.0", "3.51.3")).toBe(1);
    expect(compareDottedVersions("3.6", "3.51.3")).toBe(-1);
    expect(compareDottedVersions("4", "3.51.3")).toBe(1);
  });

  it("refuses a Node without node:sqlite (Node 20 shape) before importing anything", async () => {
    let imported = 0;
    const failure = await loadEngineRuntime({
      versions: { node: "20.19.0" },
      importSqlite: async () => {
        imported += 1;
        throw new Error("Cannot find module 'node:sqlite'");
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineRuntimeUnsupportedError);
    expect(failure).toMatchObject({
      code: "engine_runtime_unsupported",
      status: 503,
      retryable: false,
      nodeVersion: "20.19.0",
      sqliteVersion: null,
      requiredSqlite: ENGINE_SQLITE_MIN_VERSION,
    });
    expect(imported).toBe(0);
  });

  it("refuses the WAL-reset-affected SQLite (Node 22.22 / 24.14 shape) and admits the fixed one", async () => {
    const affected = await loadEngineRuntime({
      versions: { node: "24.14.1", sqlite: "3.51.2" },
      importSqlite: () => import("node:sqlite"),
    }).catch((error: unknown) => error);
    expect(affected).toBeInstanceOf(EngineRuntimeUnsupportedError);
    expect((affected as Error).message).toContain("WAL-reset");
    expect(affected).toMatchObject({ sqliteVersion: "3.51.2", nodeVersion: "24.14.1" });

    const fixed = await loadEngineRuntime({
      versions: { node: "24.15.0", sqlite: "3.51.3" },
      importSqlite: () => import("node:sqlite"),
    });
    expect(fixed.sqliteVersion).toBe("3.51.3");
    expect(typeof fixed.sqlite.DatabaseSync).toBe("function");
  });

  it("types an import failure on an admitted version", async () => {
    const cause = new Error("ERR_UNKNOWN_BUILTIN_MODULE");
    const failure = await loadEngineRuntime({
      versions: { node: "24.16.0", sqlite: "3.53.0" },
      importSqlite: async () => {
        throw cause;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineRuntimeUnsupportedError);
    expect((failure as Error).cause).toBe(cause);
  });

  it("admits the running Node", async () => {
    const runtime = await loadEngineRuntime();
    expect(runtime.sqliteVersion).toBe(process.versions.sqlite);
  });
});
