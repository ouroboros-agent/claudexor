import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawRequestCapacity } from "@claudexor/core";
import { RawContextRefusalError, runCapture } from "@claudexor/core";
import {
  RawContextPacket,
  type ImplementationTransport,
  type OmissionEntry,
  type RawContextFile,
  type ScopeAtlasEntry,
  type WorkspaceEnvelope,
} from "@claudexor/schema";
import { hashJson, sha256 } from "@claudexor/util";
import { buildScopeAtlas } from "./atlas.js";

/** Optional-content ceiling when no model window is known (#147): an
 * assumption carried over from the scope atlas, never a fact about a model. */
export const RAW_CONTEXT_ASSUMED_CEILING_TOKENS = 200_000;
const TOKEN_BUDGET_REASON = "token budget exceeded";
/** Same length as a real `sha256:<hex>` packet hash, for self-measurement. */
const HASH_PLACEHOLDER = `sha256:${"0".repeat(64)}`;

interface GitEntry {
  mode: string;
  oid: string;
}

/** What the production packet must honour: the project's `ProjectConfig.context`. */
export interface RawContextOptions {
  mandatory_files?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
}

/** Builds one request's packet for the capacity of the request it rides
 * (null = no window known). */
export type RawContextSizer = (capacity: RawRequestCapacity | null) => Promise<RawContextPacket>;

/**
 * The packet builder of an envelope whose transport inlines a RawContextPacket,
 * or null for any other transport. Isolation is checked here, before anything
 * is dispatched; each dispatch then builds its own packet for the capacity its
 * catalog read gives (#147).
 */
export function rawContextSizer(
  transport: ImplementationTransport,
  envelope: WorkspaceEnvelope,
  options: RawContextOptions = {},
): RawContextSizer | null {
  if (transport !== "git_patch_envelope") return null;
  if (envelope.worktree_path === envelope.repo_root)
    throw new Error(
      "raw_patch_requires_isolation: raw patch producers require an isolated envelope",
    );
  return (capacity) =>
    buildRawContextPacket(envelope.worktree_path, envelope.base_sha ?? "HEAD", {
      mandatory: [...(options.mandatory_files ?? [])],
      include: [...(options.include ?? [])],
      exclude: [...(options.exclude ?? [])],
      capacity,
    });
}

async function gitOutput(repo: string, args: string[]): Promise<string> {
  const result = await runCapture("git", ["-C", repo, ...args], {
    timeoutMs: 30_000,
    windowsConsole: "none",
  });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function baseEntries(repo: string, baseCommitSha: string): Promise<Map<string, GitEntry>> {
  const output = await gitOutput(repo, ["ls-tree", "-r", "-z", baseCommitSha]);
  const entries = new Map<string, GitEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode && type === "blob" && oid && path) entries.set(path, { mode, oid });
  }
  return entries;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function mandatoryRefusal(files: string[]): RawContextRefusalError {
  return new RawContextRefusalError(
    "raw_context_mandatory_unavailable",
    `raw_context_mandatory_unavailable: mandatory context cannot be delivered complete: ${files.join("; ")}. ` +
      "Commit the files at the run's base, or remove them from context.mandatory_files.",
  );
}

/**
 * Build the complete, bounded text packet consumed by raw patch producers.
 * Project mandatory files are delivered complete (exempt from the ordinary
 * per-file and budget omissions) or the packet is refused. With a KNOWN model
 * window the whole rendered request (framing + packet + output allowance) is
 * sized to it: optional files are dropped deterministically from the end of
 * path order, and mandatory content that still cannot fit refuses before any
 * request is sent. Without a window the assumed ceiling bounds optional file
 * contents and is labelled as an assumption. Estimates are chars/4.
 */
export async function buildRawContextPacket(
  repoRoot: string,
  baseCommitSha: string,
  options: {
    mandatory?: string[];
    include?: string[];
    exclude?: string[];
    capacity?: RawRequestCapacity | null;
  } = {},
): Promise<RawContextPacket> {
  const capacity = options.capacity ?? null;
  const window = capacity?.contextWindow ?? null;
  const limit =
    capacity && window !== null ? window - capacity.outputAllowance - capacity.framingTokens : null;
  const mandatory = new Set(options.mandatory ?? []);
  const [atlas, treeSha, entries] = await Promise.all([
    buildScopeAtlas(repoRoot, {
      mandatory: [...mandatory],
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      tokenLimit: limit === null ? RAW_CONTEXT_ASSUMED_CEILING_TOKENS : Math.max(limit, 0),
    }),
    gitOutput(repoRoot, ["rev-parse", `${baseCommitSha}^{tree}`]).then((value) => value.trim()),
    baseEntries(repoRoot, baseCommitSha),
  ]);
  // Every mandatory path is delivered complete or named here, with its cause.
  const unavailable = new Map<string, string>();
  const readableFiles: RawContextFile[] = [];
  const omissions: OmissionEntry[] = [...atlas.omitted];
  const omittedPaths = new Set(omissions.map((item) => item.path));

  for (const entry of atlas.atlas) {
    if (entry.disposition !== "full") {
      if (mandatory.has(entry.path)) unavailable.set(entry.path, entry.reason ?? entry.disposition);
      if (!omittedPaths.has(entry.path)) {
        omissions.push({
          path: entry.path,
          reason: entry.reason ?? entry.disposition,
          replacement: "index",
          ...(entry.hash ? { hash: entry.hash } : {}),
        });
      }
      continue;
    }
    const gitEntry = entries.get(entry.path);
    if (!gitEntry || (gitEntry.mode !== "100644" && gitEntry.mode !== "100755")) {
      const reason = gitEntry
        ? `unsupported git mode ${gitEntry.mode}`
        : "missing base-tree evidence";
      if (mandatory.has(entry.path)) unavailable.set(entry.path, reason);
      omissions.push({ path: entry.path, reason, replacement: "index" });
      continue;
    }
    const content = readFileSync(join(repoRoot, entry.path), "utf8");
    readableFiles.push({
      path: entry.path,
      mode: gitEntry.mode,
      blob_oid: gitEntry.oid,
      content_hash: sha256(content),
      content,
    });
  }
  for (const path of atlas.missingMandatory)
    if (!unavailable.has(path)) unavailable.set(path, "missing or unreadable");
  if (unavailable.size > 0)
    throw mandatoryRefusal([...unavailable].map(([path, cause]) => `${path} (${cause})`));

  readableFiles.sort((a, b) => a.path.localeCompare(b.path));
  const kept = readableFiles.filter((file) => mandatory.has(file.path));
  const optional = readableFiles.filter((file) => !mandatory.has(file.path));
  const dropped: RawContextFile[] = [];
  const assemble = (): RawContextPacket => {
    const files = [...kept, ...optional].sort((a, b) => a.path.localeCompare(b.path));
    const droppedPaths = new Set(dropped.map((file) => file.path));
    const manifest: ScopeAtlasEntry[] = atlas.atlas.map((entry) =>
      droppedPaths.has(entry.path)
        ? { path: entry.path, disposition: "omitted", bytes: entry.bytes, reason: "token_budget" }
        : entry,
    );
    const packetOmissions = [
      ...omissions,
      ...dropped.map((file) => ({
        path: file.path,
        reason: TOKEN_BUDGET_REASON,
        replacement: "index" as const,
        hash: file.content_hash,
      })),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const budgetOmitted = packetOmissions.filter((item) => item.reason === TOKEN_BUDGET_REASON);
    const body = {
      schema_version: 1 as const,
      budget: {
        estimator: "chars_div_4" as const,
        basis: limit === null ? ("assumed_ceiling" as const) : ("model_context_window" as const),
        model: capacity?.model ?? null,
        context_window: window,
        output_allowance_tokens: capacity?.outputAllowance ?? null,
        framing_tokens: capacity?.framingTokens ?? null,
        selection_limit_tokens:
          limit === null ? RAW_CONTEXT_ASSUMED_CEILING_TOKENS : Math.max(limit, 1),
        estimated_packet_tokens: 0,
        omitted_for_budget: budgetOmitted.length,
        mandatory_paths: [...mandatory].sort(),
      },
      base_commit_sha: baseCommitSha,
      base_tree_sha: treeSha,
      readable_files: files,
      editable_paths: files.map((file) => file.path),
      creatable_roots: ["."],
      file_manifest: manifest,
      omissions: packetOmissions,
      evidence_refs: files.map((file) => `git:${treeSha}:${file.path}:${file.blob_oid}`),
    };
    // The estimate covers the packet exactly as the adapter embeds it; the second
    // pass absorbs the length of the figure itself.
    const measure = () =>
      estimateTokens(JSON.stringify({ ...body, packet_hash: HASH_PLACEHOLDER }));
    body.budget.estimated_packet_tokens = measure();
    body.budget.estimated_packet_tokens = measure();
    return RawContextPacket.parse({ ...body, packet_hash: hashJson(body) });
  };

  let packet = assemble();
  if (limit === null) return packet;
  while (packet.budget!.estimated_packet_tokens > limit && optional.length > 0) {
    let excess = (packet.budget!.estimated_packet_tokens - limit) * 4;
    while (excess > 0 && optional.length > 0) {
      const file = optional.pop()!;
      dropped.unshift(file);
      excess -= JSON.stringify(file).length;
    }
    packet = assemble();
  }
  if (packet.budget!.estimated_packet_tokens <= limit) return packet;
  const files = kept.map((file) => ({
    path: file.path,
    estimated_tokens: estimateTokens(JSON.stringify(file)),
  }));
  const sizes = files.map((file) => `${file.path} (~${file.estimated_tokens} tokens)`);
  throw new RawContextRefusalError(
    "raw_context_exceeds_window",
    `raw_context_exceeds_window: the raw request for "${capacity!.model}" cannot fit its ${window}-token context window: ` +
      `the packet needs ~${packet.budget!.estimated_packet_tokens} tokens with every optional file omitted` +
      (sizes.length > 0
        ? ` (mandatory: ${sizes.join(", ")})`
        : " (no mandatory files; file manifest and metadata)") +
      `, the request framing ~${capacity!.framingTokens} and the output allowance ${capacity!.outputAllowance} (estimates, chars/4). ` +
      "Choose a model with a larger window, or reduce context.mandatory_files.",
    {
      model: capacity!.model,
      context_window: window!,
      packet_tokens: packet.budget!.estimated_packet_tokens,
      framing_tokens: capacity!.framingTokens,
      output_allowance_tokens: capacity!.outputAllowance,
      // Largest first, the order a reader trims in; ties keep path order.
      mandatory_files: [...files].sort((a, b) => b.estimated_tokens - a.estimated_tokens),
    },
  );
}
