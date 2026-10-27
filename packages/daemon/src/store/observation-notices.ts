/** Committed addresses (job and run ids) of rows a run observation reads;
 * no argument means anything may have changed (the served view moved). */
export type ObservationListener = (changed?: ReadonlySet<string>) => void;

/**
 * In-process, ephemeral post-commit notices. Durable rows stay the only
 * authority: a notice only says which rows to read again, and a listener that
 * misses one still reads the current rows on its next pass.
 */
export class ObservationNotices {
  private readonly listeners = new Set<ObservationListener>();

  subscribe(listener: ObservationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(changed?: ReadonlySet<string>): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(changed);
      } catch {
        /* an observer never fails a committed mutation */
      }
    }
  }
}
