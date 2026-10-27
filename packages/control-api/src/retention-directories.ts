import { lstatSync, readdirSync, rmdirSync, utimesSync } from "node:fs";
import { basename, join } from "node:path";

/** A synchronous bottom-up walk preserves the admission boundary. Snapshot each
 * directory's age before our child removals change its mtime; rmdir itself is
 * the final emptiness proof. Links, tombstones and frozen stores are never walked. */
export function pruneEmptyRuntimeDirectories(root: string, startedAt: number): boolean {
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory()) return false;
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.some((entry) => entry.name === "tombstone.yaml")) return false;
    let changed = false;
    let expectedMtime = stat.mtimeMs;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === "journal-legacy" ||
        entry.name === "journal-archived" ||
        (entry.name === "idempotency" && basename(root) === "resource-store")
      )
        continue;
      if (pruneEmptyRuntimeDirectories(join(root, entry.name), startedAt)) {
        changed = true;
        expectedMtime = lstatSync(root).mtimeMs;
      }
    }
    if (stat.mtimeMs >= startedAt) return false;
    const current = lstatSync(root);
    if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino)
      return false;
    try {
      rmdirSync(root);
      return true;
    } catch (error) {
      if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      // A surviving run may use its directory timestamp as terminal age.
      // Removing empty children must not renew that evidence's age window.
      if (changed && current.mtimeMs === expectedMtime) utimesSync(root, stat.atime, stat.mtime);
    }
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
  }
  return false;
}
