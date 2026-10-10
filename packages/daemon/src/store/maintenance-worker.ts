import { lstatSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { BLOB_OWNER_PREDICATE } from "./blob-files.js";
import { sqlitePrimaryCode } from "./errors.js";
import { STORE_WORKER_DATA_KEY } from "./flusher-protocol.js";
import type {
  ExportReport,
  IntegrityReport,
  MaintenanceRequest,
  MaintenanceResponse,
  MaintenanceWorkerData,
  SweepReport,
} from "./maintenance.js";

const BLOB_NAME = /^[0-9a-f]{64}$/;
const PART_NAME = /^(.+)\.part$/;

/** A blob file is owned when its row exists or any reverse index points at it. */
const SWEEP_OWNER_SQL = `SELECT (EXISTS(SELECT 1 FROM blob WHERE sha256 = ?1) OR ${BLOB_OWNER_PREDICATE}) AS owned`;
/** A finished upload's part may go; an open/uploaded/finalizing one is still in use. */
const PART_LIVE_SQL = `SELECT EXISTS(SELECT 1 FROM upload WHERE id = ?1 AND state NOT IN ('published', 'discarded')) AS live`;

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

function integrityCheck(db: DatabaseSync): IntegrityReport {
  const started = performance.now();
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const problems = rows.map((row) => row.integrity_check).filter((text) => text !== "ok");
    return {
      ok: rows.length === 1 && problems.length === 0,
      problems,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    // A malformed page can abort the check itself: that IS the failed verdict.
    const primary = sqlitePrimaryCode(error);
    if (primary !== SQLITE_CORRUPT && primary !== SQLITE_NOTADB) throw error;
    return {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
      durationMs: performance.now() - started,
    };
  }
}

function vacuumInto(db: DatabaseSync, target: string): ExportReport {
  const started = performance.now();
  db.prepare("VACUUM INTO ?").run(target);
  return { target, bytes: statSync(target).size, durationMs: performance.now() - started };
}

function sweepOrphans(
  db: DatabaseSync,
  request: Extract<MaintenanceRequest, { kind: "sweep_orphans" }>,
): SweepReport {
  const started = performance.now();
  const owned = db.prepare(SWEEP_OWNER_SQL);
  const live = db.prepare(PART_LIVE_SQL);
  const report: SweepReport = {
    scanned: 0,
    removedBlobs: [],
    removedTemps: [],
    removedParts: [],
    keptOwned: 0,
    keptYoung: 0,
    durationMs: 0,
  };
  const entries = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const oldRegularFile = (path: string): boolean => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return false;
    if (stat.mtimeMs >= request.olderThanMs) {
      report.keptYoung += 1;
      return false;
    }
    return true;
  };
  for (const name of entries(request.blobsDir)) {
    report.scanned += 1;
    const path = join(request.blobsDir, name);
    if (name.endsWith(".tmp")) {
      if (oldRegularFile(path)) {
        unlinkSync(path);
        report.removedTemps.push(name);
      }
      continue;
    }
    if (!BLOB_NAME.test(name) || !oldRegularFile(path)) continue;
    if (Number((owned.get(name) as { owned: number | bigint }).owned) === 1) {
      report.keptOwned += 1;
      continue;
    }
    unlinkSync(path);
    report.removedBlobs.push(name);
  }
  for (const name of entries(request.uploadsDir)) {
    report.scanned += 1;
    const path = join(request.uploadsDir, name);
    if (name.endsWith(".tmp")) {
      if (oldRegularFile(path)) {
        unlinkSync(path);
        report.removedTemps.push(name);
      }
      continue;
    }
    const part = PART_NAME.exec(name);
    if (!part || !oldRegularFile(path)) continue;
    if (Number((live.get(part[1]!) as { live: number | bigint }).live) === 1) {
      report.keptOwned += 1;
      continue;
    }
    unlinkSync(path);
    report.removedParts.push(name);
  }
  report.durationMs = performance.now() - started;
  return report;
}

export function runMaintenanceWorker(port: MessagePort, data: MaintenanceWorkerData): void {
  const db = new DatabaseSync(data.dbPath, { readOnly: true, timeout: 0 });
  port.on("message", (request: MaintenanceRequest) => {
    let response: MaintenanceResponse;
    try {
      switch (request.kind) {
        case "integrity_check":
          response = { id: request.id, ok: true, result: integrityCheck(db) };
          break;
        case "vacuum_into":
          response = { id: request.id, ok: true, result: vacuumInto(db, request.target) };
          break;
        case "sweep_orphans":
          response = { id: request.id, ok: true, result: sweepOrphans(db, request) };
          break;
      }
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    port.postMessage(response);
  });
}

const spawnData = workerData as Partial<MaintenanceWorkerData> | null | undefined;
if (!isMainThread && parentPort && spawnData?.[STORE_WORKER_DATA_KEY] === "maintenance") {
  runMaintenanceWorker(parentPort, spawnData as MaintenanceWorkerData);
}
