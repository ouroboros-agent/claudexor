import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { WorkProduct, WorkspaceFilesManifest } from "@claudexor/schema";
import { sha256, readFileUtf8BoundedSync } from "@claudexor/util";
import { safeArtifactPath } from "./artifact-paths.js";
import type { DaemonRunRecord } from "./run-record.js";
import { projectionRead } from "./projection-context.js";

/** Exact immutable result, shared by apply, display, and artifact streaming. */
export function readFilesWorkProduct(record: Pick<DaemonRunRecord, "runDir">, maxBytes?: number) {
  return projectionRead(record.runDir ?? "", `files-work-product:${maxBytes ?? "all"}`, () =>
    readFilesWorkProductRaw(record, maxBytes),
  );
}

function readFilesWorkProductRaw(record: Pick<DaemonRunRecord, "runDir">, maxBytes?: number) {
  const read = (path: string) =>
    maxBytes === undefined ? readFileSync(path, "utf8") : readFileUtf8BoundedSync(path, maxBytes);
  if (!record.runDir) return null;
  const runDir = record.runDir;
  const workProductText = projectionRead<string | null>(
    runDir,
    `files-work-product:raw:${maxBytes ?? "all"}:final/work_product.yaml`,
    () => {
      const wpPath = safeArtifactPath(runDir, "final/work_product.yaml");
      return wpPath ? read(wpPath) : null;
    },
  );
  if (workProductText === null) return null;
  // Authority parsing keeps this reader's path policy and unredacted bytes:
  // presentation redaction must not change the immutable manifest binding.
  const workProduct = WorkProduct.parse(parseYaml(workProductText));
  if (workProduct.kind !== "files") return null;
  const manifestPath = workProduct.files.manifest;
  const manifestSha256 = workProduct.meta.manifest_sha256;
  if (typeof manifestPath !== "string" || typeof manifestSha256 !== "string")
    throw new Error("Files work product has no immutable manifest reference");
  const text = projectionRead<string | null>(
    runDir,
    `files-work-product:raw:${maxBytes ?? "all"}:${manifestPath}`,
    () => {
      const path = safeArtifactPath(runDir, manifestPath);
      return path ? read(path) : null;
    },
  );
  if (text === null) throw new Error("Files work product manifest is unavailable");
  if (sha256(text) !== manifestSha256) throw new Error("Files manifest digest mismatch");
  return {
    workProduct,
    manifest: WorkspaceFilesManifest.parse(JSON.parse(text)),
    manifestPath,
    manifestSha256,
    artifactRoot: record.runDir,
    text,
  };
}
