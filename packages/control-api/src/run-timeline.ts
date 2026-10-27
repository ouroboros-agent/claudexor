/**
 * Timeline projection over a run's canonical events.jsonl: severity
 * classification (typed event kinds + typed tool status — no prose parsing),
 * bounded output with an EXPLICIT truncation marker, and the shared
 * event-reading helpers the budget snapshot reuses.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  ControlTimelineEvent,
  type ControlEvidenceIntegrity,
  ControlWebEvidence,
  FallbackReason,
  type RunTelemetry,
  type TaskContract,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { safeArtifactPath, safeArtifactRoot } from "./artifact-paths.js";
import { projectionRead } from "./projection-context.js";

const TIMELINE_EVENTS_MAX = 500;

/** Read buffers are bounded; canonical history is not. Budget, valuation and
 * plan folds need the prefix even when the display keeps only recent rows. */
const EVENTS_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Observability counter: how many times a run's events.jsonl was actually read
 * + parsed from disk. Detail requests thread ONE parsed snapshot through every
 * projection (D15 RunDetail perf), so this must stay at 1 per detail GET no
 * matter how many fields consume events — the single-parse test asserts it.
 */
let eventsParseCount = 0;
export function eventsParseCountForTests(): number {
  return eventsParseCount;
}
export function resetEventsParseCountForTests(): void {
  eventsParseCount = 0;
}

/** Structural dependency: anything carrying an optional runDir works. */
export interface RunDirCarrier {
  runDir?: string;
}

/**
 * Typed record of what the single lenient events.jsonl parser had to skip.
 * QA-074: a lenient reader that silently drops malformed/unreadable lines
 * turns incomplete canonical evidence into an apparently clean partial set.
 * This counts every non-intentional omission so the projections that already
 * disclose intentional bounding (timeline truncation) can also disclose
 * corruption, and distinguishes a legitimately-absent file (queued run) from a
 * genuinely unreadable one.
 */
export interface RunEventsIntegrity {
  /** File is absent (ENOENT) — a legitimate empty state for a queued/aborted-before-first-event run, NOT corruption. */
  absent: boolean;
  /** File exists but could not be read (permission/IO error, or a symlink/directory in place of the file). Evidence is UNAVAILABLE. */
  unreadable: boolean;
  /** Non-empty lines that failed JSON.parse and were dropped. */
  malformedLines: number;
  /** JSON values that parsed but were not plain objects (arrays/scalars/null) and were dropped. */
  nonObjectLines: number;
  /** Compatibility with earlier bounded-tail snapshots; complete reads leave this false. */
  tailTruncated: boolean;
}

export interface RunEventsRead {
  events: Record<string, unknown>[];
  integrity: RunEventsIntegrity;
}

const COMPLETE_INTEGRITY: RunEventsIntegrity = {
  absent: false,
  unreadable: false,
  malformedLines: 0,
  nonObjectLines: 0,
  tailTruncated: false,
};

/**
 * Collapse a typed integrity record to the three-state evidence level the DTOs
 * disclose. Intentional bounding (tailTruncated / absent-for-queued) is NOT an
 * integrity problem, so it maps to `complete` — only genuine unreadable files
 * and skipped corrupt lines degrade the level.
 */
export function evidenceLevel(i: RunEventsIntegrity): ControlEvidenceIntegrity {
  if (i.unreadable) return "unavailable";
  if (i.malformedLines > 0 || i.nonObjectLines > 0) return "incomplete";
  return "complete";
}

/**
 * The ONE lenient events.jsonl reader for Control projections. Returns the
 * parsed objects AND a typed count of everything it skipped, so no caller can
 * mistake a partial/empty set for complete evidence (QA-074). `readRunEvents`
 * preserves the historical array-only shape for callers that do not disclose
 * integrity.
 */
export function readRunEventsWithIntegrity(
  rec: RunDirCarrier,
  maxBytes?: number,
): RunEventsRead {
  return projectionRead(rec.runDir ?? "", `events:${maxBytes ?? "all"}`, () =>
    readEventsSnapshot(rec, maxBytes),
  );
}

function readEventsSnapshot(rec: RunDirCarrier, maxBytes?: number): RunEventsRead {
  const integrity: RunEventsIntegrity = { ...COMPLETE_INTEGRITY };
  if (!rec.runDir) return { events: [], integrity };
  const path = safeArtifactPath(rec.runDir, "events.jsonl");
  // safeArtifactPath returns null for a MISSING file (ENOENT — the legitimate
  // queued/never-written case) AND for an unsafe one (symlink/traversal). Only
  // the latter is an integrity problem: an absent file is honestly empty, an
  // unsafe/unreadable one must disclose as unavailable rather than empty-clean.
  if (!path) {
    const base = safeArtifactRoot(rec.runDir);
    if (base) {
      try {
        // lstat does NOT follow symlinks: any existing node here (symlink/other)
        // was refused by the path guard and is genuinely unreadable-as-events.
        lstatSync(join(base, "events.jsonl"));
        return { events: [], integrity: { ...integrity, unreadable: true } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT")
          return { events: [], integrity: { ...integrity, absent: true } };
      }
    }
    return { events: [], integrity: { ...integrity, unreadable: true } };
  }
  const out: Record<string, unknown>[] = [];
  const parseLine = (line: string): void => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      integrity.malformedLines++;
      return;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      out.push(parsed as Record<string, unknown>);
    } else {
      integrity.nonObjectLines++;
    }
  };
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || st.isDirectory())
      return { events: [], integrity: { ...integrity, unreadable: true } };
    const fd = openSync(path, "r");
    try {
      // Freeze the end on the opened descriptor: concurrent appends belong to
      // another snapshot and cannot turn a projection into an endless read.
      const end = fstatSync(fd).size;
      const buf = Buffer.allocUnsafe(EVENTS_READ_CHUNK_BYTES);
      const decoder = new StringDecoder("utf8");
      let carry = "";
      const startOffset = maxBytes === undefined ? 0 : Math.max(0, end - maxBytes);
      integrity.tailTruncated = startOffset > 0;
      let skipPartialLine = integrity.tailTruncated;
      for (let offset = startOffset; offset < end;) {
        const read = readSync(fd, buf, 0, Math.min(buf.length, end - offset), offset);
        if (read === 0) throw new Error("Run events changed while reading");
        offset += read;
        const text = carry + decoder.write(buf.subarray(0, read));
        let start = 0;
        for (
          let newline = text.indexOf("\n");
          newline !== -1;
          newline = text.indexOf("\n", start)
        ) {
          if (skipPartialLine) skipPartialLine = false;
          else parseLine(text.slice(start, newline));
          start = newline + 1;
        }
        carry = text.slice(start);
      }
      // Historical detail reads also accept a complete final JSON record with
      // no newline; a torn record is counted as malformed, never hidden.
      if (!skipPartialLine) parseLine(carry + decoder.end());
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    // ENOENT is the legitimate queued/never-written case: an empty event set is
    // the honest truth, NOT corruption. Every other read failure (EACCES, EIO…)
    // is a real integrity problem the projections must disclose as unavailable.
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT")
      return { events: [], integrity: { ...COMPLETE_INTEGRITY, absent: true } };
    return { events: [], integrity: { ...COMPLETE_INTEGRITY, unreadable: true } };
  }
  eventsParseCount++;
  return { events: out, integrity };
}

export function readRunEvents(rec: RunDirCarrier): Record<string, unknown>[] {
  return readRunEventsWithIntegrity(rec).events;
}

export function eventPayload(ev: Record<string, unknown>): Record<string, unknown> {
  return ev["payload"] && typeof ev["payload"] === "object" && !Array.isArray(ev["payload"])
    ? (ev["payload"] as Record<string, unknown>)
    : {};
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? redactSecrets(value) : null;
}

/** Project the orchestrator-owned telemetry artifact without reconstructing evidence. */
export function controlWebEvidence(
  telemetry: RunTelemetry | null,
  task: TaskContract | null,
): ControlWebEvidence {
  if (!telemetry) {
    return ControlWebEvidence.parse({
      required: task?.external_context.web_required ?? false,
      mode: task?.external_context.policy ?? "auto",
      effectiveMode:
        task?.external_context.effective_mode ?? task?.external_context.policy ?? "auto",
      available: false,
    });
  }
  return ControlWebEvidence.parse({
    required: telemetry.web.required,
    mode: telemetry.web.policy,
    effectiveMode: telemetry.web.effective_mode,
    attempted: telemetry.web.attempted,
    satisfied: telemetry.web.satisfied,
    status: telemetry.web.status,
    tool: telemetry.web.tool,
    target: telemetry.web.target,
    errorSummary: telemetry.web.error_summary,
    rawDetailRef: "final/telemetry.yaml",
    available: true,
  });
}

function prettyEventType(type: string): string {
  return type.replace(/\./g, " · ").replace(/_/g, " ");
}

const WARNING_EVENT_TYPES = new Set([
  "route.fallback.started",
  "route.fallback.auth_switched",
  "route.fallback.exhausted",
  "route.primary.diverged",
  "route.pool.degraded",
  "route.profile.headroom_exceeded",
  "route.profile.rotation_exhausted",
  "delegation.belt.degraded",
  "policy.web.upgraded",
  "run.blocked",
]);
const ERROR_EVENT_TYPES = new Set(["run.failed", "reviewer.failed", "reviewer.timed_out"]);

function timelineSeverity(
  type: string,
  payload: Record<string, unknown>,
  tool: Record<string, unknown>,
): "info" | "warning" | "error" {
  if (payload["error"] || tool["status"] === "error" || ERROR_EVENT_TYPES.has(type)) return "error";
  const reason = FallbackReason.safeParse(payload["reason"]);
  if (
    type === "route.fallback.auth_switched" &&
    reason.success &&
    reason.data === "readiness_preferred"
  )
    return "info";
  if (type === "control.applied") {
    const control = payload["control"] as Record<string, unknown> | null | undefined;
    const timeLimit = payload["timeLimit"] as Record<string, unknown> | null | undefined;
    if (
      control?.["kind"] === "time_limit" &&
      control["action"] === "reached" &&
      timeLimit?.["mode"] === "soft"
    )
      return "warning";
  }
  if (WARNING_EVENT_TYPES.has(type)) return "warning";
  return "info";
}

export function timelineEvents(
  rec: RunDirCarrier,
  events?: Record<string, unknown>[],
  integrity?: RunEventsIntegrity,
): ControlTimelineEvent[] {
  const snapshot = events ?? readRunEvents(rec);
  const tail: Record<string, unknown>[] = [];
  let eligible = 0;
  // Select rows before doing any redaction, projection or schema work. Raw
  // slice(-500) is not equivalent: buffered harness rows never occupy a slot.
  // Visit every type, preserving corrupted-log rejection even outside the tail;
  // only selected rows have their payloads projected. Leave the snapshot whole.
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const ev = snapshot[i]!;
    if (
      String(ev["type"] ?? "event") === "harness.event" &&
      eventPayload(eventPayload(ev))["buffered"] === true
    )
      continue;
    eligible++;
    if (tail.length < TIMELINE_EVENTS_MAX) tail.push(ev);
  }
  const out: ControlTimelineEvent[] = [];
  for (const ev of tail.reverse()) {
    const payload = eventPayload(ev);
    const type = String(ev["type"] ?? "event");
    const textKind =
      type === "harness.event" &&
      (payload["type"] === "thinking" || payload["type"] === "message") &&
      typeof payload["text"] === "string"
        ? payload["type"]
        : null;
    const textDelta = textKind !== null && eventPayload(payload)["delta"] === true;
    // Typed tool info travels on the normalized HarnessEvent `tool` field.
    const tool =
      payload["tool"] && typeof payload["tool"] === "object" && !Array.isArray(payload["tool"])
        ? (payload["tool"] as Record<string, unknown>)
        : {};
    const harnessId = stringOrNull(payload["harness_id"] ?? payload["harness"]);
    const attemptId = stringOrNull(payload["attempt_id"] ?? payload["attemptId"]);
    // Live-message receipts (message.*) and the adapter's consumption status
    // (harness.event status live_input_delivered) carry the message id so a
    // caller can reconcile delivery on the timeline (CONTRACT A26).
    const nested = eventPayload(payload);
    const messageId = stringOrNull(payload["message_id"] ?? nested["message_id"]);
    const outcome = type.startsWith("message.")
      ? stringOrNull(payload["outcome"])
      : nested["code"] === "live_input_delivered"
        ? "delivered"
        : null;
    const partialGitInitialization =
      type === "project.git.initialized" && payload["partial"] === true;
    const title =
      (partialGitInitialization
        ? "Git repository initialization incomplete"
        : stringOrNull(
            payload["title"] ??
              payload["message"] ??
              payload["summary"] ??
              payload["text"] ??
              payload["error"],
          )) ?? prettyEventType(type);
    const errorSummary = stringOrNull(tool["error_summary"] ?? payload["error"]);
    const detail = textKind
      ? stringOrNull(payload["text"])
      : partialGitInitialization
        ? `Stopped during ${String(payload["failed_stage"] ?? "unknown")} at ${String(payload["repo_root"] ?? "?")}; partial Git metadata may remain.`
        : (stringOrNull(payload["detail"] ?? payload["text"] ?? payload["error"]) ??
          stringOrNull(tool["content_summary"]) ??
          errorSummary);
    const toolName = stringOrNull(tool["name"]);
    const target = stringOrNull(tool["target"]);
    // INV-105 disclosure (QA-070): unsupported per-harness knobs the route could
    // not honor ride harness.started as `ignored_settings`. Project them (redacted,
    // bounded) so the row renders a visible warning instead of a benign start; a
    // non-empty list also lifts severity to `warning` (the raw event is info-shaped).
    const ignoredSettings = Array.isArray(payload["ignored_settings"])
      ? (payload["ignored_settings"] as unknown[])
          .map((s) => stringOrNull(s))
          .filter((s): s is string => s !== null)
      : [];
    const severity =
      ignoredSettings.length > 0 || partialGitInitialization
        ? "warning"
        : timelineSeverity(type, payload, tool);
    out.push(
      ControlTimelineEvent.parse({
        type,
        ts: typeof ev["ts"] === "string" ? ev["ts"] : undefined,
        harnessId,
        attemptId,
        messageId,
        outcome,
        title,
        detail,
        textKind,
        textDelta,
        severity,
        toolName,
        target,
        errorSummary,
        ignoredSettings,
        rawRef: "events.jsonl",
      }),
    );
  }
  // Bounded projection with an EXPLICIT truncation marker — no silent truncation.
  const omitted = Math.max(0, eligible - TIMELINE_EVENTS_MAX);
  if (omitted > 0) {
    out.unshift(
      ControlTimelineEvent.parse({
        type: "timeline.truncated",
        title: `${omitted} earlier event(s) omitted from this projection`,
        detail: "Full history remains in events.jsonl.",
        severity: "info",
        rawRef: "events.jsonl",
      }),
    );
  }
  // Corruption/unavailability is a DIFFERENT class from intentional volume
  // bounding above: malformed or unreadable canonical evidence must announce
  // itself so a partial timeline can never read as clean (QA-074). Prepended
  // last so it sits at the very top, most prominent.
  const marker = incompletenessMarker(integrity);
  if (marker) out.unshift(marker);
  return out;
}

/**
 * The explicit timeline row for non-intentional evidence loss, or null when the
 * events were fully readable. Mirrors the `timeline.truncated` disclosure
 * pattern: a synthetic row whose title carries the omitted-line count.
 */
function incompletenessMarker(integrity?: RunEventsIntegrity): ControlTimelineEvent | null {
  if (!integrity) return null;
  const level = evidenceLevel(integrity);
  if (level === "complete") return null;
  if (level === "unavailable") {
    return ControlTimelineEvent.parse({
      type: "timeline.evidence_unavailable",
      title: "Canonical run events could not be read",
      detail:
        "events.jsonl is present but unreadable; this timeline is projected from no events and may be missing the entire run history.",
      severity: "error",
      rawRef: "events.jsonl",
    });
  }
  const omitted = integrity.malformedLines + integrity.nonObjectLines;
  return ControlTimelineEvent.parse({
    type: "timeline.evidence_incomplete",
    title: `${omitted} malformed run event line(s) omitted from this projection`,
    detail: `events.jsonl had ${integrity.malformedLines} unparseable and ${integrity.nonObjectLines} non-object line(s); this timeline is incomplete — canonical evidence remains on disk.`,
    severity: "warning",
    rawRef: "events.jsonl",
  });
}

/** The LAST plan.progress event's typed items (the live plan checklist), or
 * null when the run never emitted one. Last-wins by construction: plan tools
 * re-emit the whole list on every revision. On RACES the candidates' lists
 * interleave — prefer the WINNER's attempt (decision.yaml) so the Plan tab
 * shows the shipped candidate's checklist, not whichever emitted last. */
export function latestPlanProgress(
  rec: RunDirCarrier,
  winnerAttemptId?: string | null,
  eventsSnapshot?: Record<string, unknown>[],
  integrity?: RunEventsIntegrity,
): {
  items: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" }>;
  evidence: ControlEvidenceIntegrity;
} | null {
  const read = eventsSnapshot
    ? { events: eventsSnapshot, integrity: integrity ?? COMPLETE_INTEGRITY }
    : readRunEventsWithIntegrity(rec);
  const events = read.events;
  const evidence = evidenceLevel(read.integrity);
  const pick = (matchWinner: boolean): Record<string, unknown> | null => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.["type"] !== "plan.progress") continue;
      if (matchWinner && eventPayload(ev)["attempt_id"] !== winnerAttemptId) continue;
      return ev;
    }
    return null;
  };
  const chosen = (winnerAttemptId ? pick(true) : null) ?? pick(false);
  {
    const ev = chosen;
    if (!ev) {
      // No plan.progress event survived the read. When evidence is incomplete/
      // unavailable, a plan event may have been the dropped line, so disclose a
      // non-complete empty checklist rather than the "never emitted one" null.
      return evidence === "complete" ? null : { items: [], evidence };
    }
    const payload = eventPayload(ev);
    const rawItems = Array.isArray(payload["items"]) ? (payload["items"] as unknown[]) : [];
    const items = rawItems
      .map((raw) => {
        const r = raw as { id?: unknown; title?: unknown; status?: unknown };
        if (typeof r.id !== "string" || typeof r.title !== "string") return null;
        const status =
          r.status === "completed"
            ? "completed"
            : r.status === "in_progress"
              ? "in_progress"
              : "pending";
        return {
          id: r.id,
          title: r.title,
          status: status as "pending" | "in_progress" | "completed",
        };
      })
      .filter(
        (x): x is { id: string; title: string; status: "pending" | "in_progress" | "completed" } =>
          x !== null,
      );
    return { items, evidence };
  }
}
