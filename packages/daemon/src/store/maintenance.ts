import { Worker } from "node:worker_threads";
import { StoreError } from "./errors.js";
import { STORE_WORKER_DATA_KEY, resolveStoreWorkerEntry } from "./flusher-protocol.js";
import type { EngineStore } from "./store.js";
// Static import: the worker module must be part of this module graph so the
// single-file daemon bundle embeds it (its self-start is inert on the main thread).
import "./maintenance-worker.js";

export interface MaintenanceWorkerData {
  [STORE_WORKER_DATA_KEY]: "maintenance";
  dbPath: string;
}

/** Requests are a discriminated union: the importer (PR-D) adds its kind here
 * and a handler in the worker; nothing else changes. */
export type MaintenanceRequest =
  | { id: number; kind: "integrity_check" }
  | { id: number; kind: "vacuum_into"; target: string }
  | {
      id: number;
      kind: "sweep_orphans";
      blobsDir: string;
      uploadsDir: string;
      /** Files whose mtime is at or after this epoch-ms instant are left alone. */
      olderThanMs: number;
    };

export interface IntegrityReport {
  ok: boolean;
  problems: string[];
  durationMs: number;
}

export interface ExportReport {
  target: string;
  bytes: number;
  durationMs: number;
}

export interface SweepReport {
  scanned: number;
  removedBlobs: string[];
  removedTemps: string[];
  removedParts: string[];
  keptOwned: number;
  keptYoung: number;
  durationMs: number;
}

export type MaintenanceResponse =
  | { id: number; ok: true; result: IntegrityReport | ExportReport | SweepReport }
  | { id: number; ok: false; error: string };

export interface MaintenanceControllerOptions {
  workerEntry?: string;
  log?: (line: string) => void;
  /** Epoch ms of this process's start: the sweep's deterministic age bound. */
  processStartedAt?: number;
}

interface Pending {
  request: MaintenanceRequest;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

/**
 * Maintenance (SYNTHESIS_R5 §2, §6.5, §7 p.6): long operations that must not
 * touch the flusher's pass — `integrity_check` after admission and on request,
 * `VACUUM INTO` export, the orphan sweep for files older than the process
 * start. The worker owns a separate read-only connection, never shares a
 * thread or connection with the flusher, and never writes a row; the sweep's
 * only mutations are unlinks of files no row points at.
 */
export class MaintenanceController {
  private readonly entry: string;
  private readonly processStartedAt: number;
  private worker: Worker | null = null;
  private readonly queue: Pending[] = [];
  private inFlight: Pending | null = null;
  private nextId = 1;
  private closing = false;

  constructor(
    private readonly store: EngineStore,
    private readonly options: MaintenanceControllerOptions = {},
  ) {
    this.entry =
      options.workerEntry ?? resolveStoreWorkerEntry(import.meta.url, "maintenance-worker.js");
    this.processStartedAt =
      options.processStartedAt ?? Date.now() - Math.round(process.uptime() * 1000);
  }

  /** `PRAGMA integrity_check` on the worker; the verdict becomes the `integrity` fact. */
  async integrityCheck(): Promise<IntegrityReport> {
    const report = await this.run<IntegrityReport>({ id: 0, kind: "integrity_check" });
    this.store.recordIntegrity(report.ok ? "ok" : "failed");
    return report;
  }

  /** `VACUUM INTO target`: a consistent snapshot copy, written by the worker. */
  exportTo(target: string): Promise<ExportReport> {
    return this.run<ExportReport>({ id: 0, kind: "vacuum_into", target });
  }

  /** Unlink blob files, `.tmp` leftovers and finished `.part` files older than
   * the process start that no row points at (SYNTHESIS_R5 §6.5). */
  async sweepOrphans(): Promise<SweepReport> {
    const report = await this.run<SweepReport>({
      id: 0,
      kind: "sweep_orphans",
      blobsDir: this.store.paths.blobs,
      uploadsDir: this.store.paths.uploads,
      olderThanMs: this.processStartedAt,
    });
    if (report.removedBlobs.length + report.removedTemps.length > 0)
      this.store.registerExternal(this.store.paths.blobs);
    if (report.removedParts.length > 0) this.store.registerExternal(this.store.paths.uploads);
    return report;
  }

  async stop(): Promise<void> {
    this.closing = true;
    const failure = new StoreError("store_closed", 503, false, "engine store is closing");
    for (const pending of this.queue.splice(0)) pending.reject(failure);
    this.inFlight?.reject(failure);
    this.inFlight = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  private run<T>(request: MaintenanceRequest): Promise<T> {
    if (this.closing) {
      return Promise.reject(new StoreError("store_closed", 503, false, "engine store is closing"));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        request: { ...request, id: this.nextId++ },
        resolve: resolve as (value: never) => void,
        reject,
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0 || this.closing) return;
    const pending = this.queue.shift()!;
    this.inFlight = pending;
    this.ensureWorker().postMessage(pending.request);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const data: MaintenanceWorkerData = {
      [STORE_WORKER_DATA_KEY]: "maintenance",
      dbPath: this.store.paths.database,
    };
    const worker = new Worker(this.entry, {
      workerData: data,
      name: "claudexor-store-maintenance",
    });
    this.worker = worker;
    worker.on("message", (response: MaintenanceResponse) => {
      const current = this.inFlight;
      if (!current || current.request.id !== response.id) return;
      this.inFlight = null;
      if (response.ok) current.resolve(response.result as never);
      else current.reject(new StoreError("store_maintenance_failed", 503, true, response.error));
      this.pump();
    });
    worker.on("error", (error) => {
      this.options.log?.(`store maintenance worker error: ${error.message}`);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.closing) return;
      const failure = new StoreError(
        "store_maintenance_unavailable",
        503,
        true,
        `the maintenance worker exited with code ${code}`,
      );
      this.inFlight?.reject(failure);
      this.inFlight = null;
      // The next request spawns a fresh worker; queued requests continue on it.
      this.pump();
    });
    return worker;
  }
}
