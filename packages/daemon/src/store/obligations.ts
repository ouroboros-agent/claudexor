import type { EngineStore } from "./store.js";

/** `effect_obligation.kind` values (SYNTHESIS_R5 §4.6). Data, not enum-in-logic:
 * stores register a completion handler per kind at startup. */
export const OBLIGATION_KINDS = [
  "terminal_files",
  "publish_blob",
  "archive_fs",
  "purge_fs",
  "quarantine_fs",
] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export interface ObligationRow {
  kind: ObligationKind;
  key: string;
  pid: number;
  createdAt: string;
  payload: unknown;
}

/** What a completion handler may do: redo the effect and bind its directories. */
export interface ObligationEffects {
  register(dir: string): number;
}

export type ObligationHandler = (obligation: ObligationRow, effects: ObligationEffects) => void;

export interface ObligationCompletionReceipt {
  completed: Array<{ kind: ObligationKind; key: string }>;
  failed: Array<{ kind: ObligationKind; key: string; error: string }>;
  unhandled: Array<{ kind: ObligationKind; key: string }>;
}

interface Tracked {
  generations: number[];
  completed: boolean;
}

function trackKey(kind: string, key: string): string {
  return `${kind}\0${key}`;
}

/**
 * Obligations (SYNTHESIS_R5 §4.6): the row is created in the SAME transaction
 * as the decision it protects; the effect runs (files, links, renames) and
 * registers its directories; once `synced(g)` covers every registration the
 * row is deleted in a micro-transaction. Startup replays the open rows through
 * idempotent handlers — their count is unfinished work, never history.
 */
export class Obligations {
  private readonly tracked = new Map<string, Tracked>();
  private readonly handlers = new Map<ObligationKind, ObligationHandler>();
  private readonly unsubscribe: () => void;

  constructor(private readonly store: EngineStore) {
    this.unsubscribe = store.onSynced((generation) => this.clearSynced(generation));
  }

  /** Inside the caller's transaction. A duplicate (kind, key) is a constraint violation. */
  create(kind: ObligationKind, key: string, pid: number, payload: unknown): void {
    if (!this.store.inTransaction) {
      throw new Error("an obligation is created inside the transaction of its decision");
    }
    this.store
      .prepare(
        "INSERT INTO effect_obligation(kind, key, pid, created_at, payload) VALUES(?, ?, ?, ?, ?)",
      )
      .run(kind, key, pid, this.store.now().toISOString(), Buffer.from(JSON.stringify(payload)));
    this.tracked.set(trackKey(kind, key), { generations: [], completed: false });
  }

  /** Bind a directory the effect touched; returns the registration generation. */
  registerEffect(kind: ObligationKind, key: string, dir: string): number {
    const g = this.store.registerExternal(dir);
    this.entry(kind, key).generations.push(g);
    return g;
  }

  /** The effect is done; the row clears after every bound generation is synced. */
  complete(kind: ObligationKind, key: string): void {
    const entry = this.entry(kind, key);
    entry.generations.push(this.store.mark());
    entry.completed = true;
  }

  open(): ObligationRow[] {
    return (
      this.store
        .prepare(
          "SELECT kind, key, pid, created_at, payload FROM effect_obligation ORDER BY created_at, kind, key",
        )
        .all() as Array<{
        kind: ObligationKind;
        key: string;
        pid: number | bigint;
        created_at: string;
        payload: Uint8Array;
      }>
    ).map((row) => ({
      kind: row.kind,
      key: row.key,
      pid: Number(row.pid),
      createdAt: row.created_at,
      payload: JSON.parse(Buffer.from(row.payload).toString("utf8")) as unknown,
    }));
  }

  /** Stores register one idempotent completion handler per kind at startup. */
  registerHandler(kind: ObligationKind, handler: ObligationHandler): void {
    if (this.handlers.has(kind))
      throw new Error(`obligation handler for '${kind}' already registered`);
    this.handlers.set(kind, handler);
  }

  /**
   * Startup hook: redo every open obligation through its handler. A handler
   * failure leaves the row open (the fact `obligations_open` discloses it);
   * a kind without a handler is reported, never silently dropped.
   */
  completeOpen(): ObligationCompletionReceipt {
    const receipt: ObligationCompletionReceipt = { completed: [], failed: [], unhandled: [] };
    for (const obligation of this.open()) {
      const handler = this.handlers.get(obligation.kind);
      if (!handler) {
        receipt.unhandled.push({ kind: obligation.kind, key: obligation.key });
        continue;
      }
      try {
        handler(obligation, {
          register: (dir) => this.registerEffect(obligation.kind, obligation.key, dir),
        });
        this.complete(obligation.kind, obligation.key);
        receipt.completed.push({ kind: obligation.kind, key: obligation.key });
      } catch (error) {
        receipt.failed.push({
          kind: obligation.kind,
          key: obligation.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return receipt;
  }

  close(): void {
    this.unsubscribe();
    this.tracked.clear();
  }

  private entry(kind: ObligationKind, key: string): Tracked {
    const id = trackKey(kind, key);
    let entry = this.tracked.get(id);
    if (!entry) {
      entry = { generations: [], completed: false };
      this.tracked.set(id, entry);
    }
    return entry;
  }

  private clearSynced(generation: number): void {
    if (this.store.isClosed) return;
    const clearable: Array<[string, string]> = [];
    for (const [id, entry] of this.tracked) {
      if (!entry.completed) continue;
      if (entry.generations.some((g) => g > generation)) continue;
      const [kind, key] = id.split("\0") as [string, string];
      clearable.push([kind, key]);
    }
    if (clearable.length === 0) return;
    const remove = this.store.prepare("DELETE FROM effect_obligation WHERE kind = ? AND key = ?");
    this.store.transaction(() => {
      for (const [kind, key] of clearable) remove.run(kind, key);
    });
    for (const [kind, key] of clearable) this.tracked.delete(trackKey(kind, key));
  }
}
