import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  continuationRefusal,
  RunResumable,
  RunTelemetry,
  SCHEMA_VERSION,
  type RunContinuityReceipt,
  type RunEvent,
} from "@claudexor/schema";
import { readContinuationEvidence } from "./continuation-evidence.js";
import {
  continuedTryStarted,
  recordedSessionMemory,
  runExecutionFacts,
  uncoveredAttempts,
} from "./continuation-facts.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

let seq = 0;
const row = (type: string, payload: Record<string, unknown>): RunEvent =>
  ({ seq: seq++, ts: "t", run_id: "r", task_id: "k", type, payload }) as RunEvent;
const started = (attempt: string, session: string, native?: string) =>
  row("harness.event", {
    attempt_id: attempt,
    session_id: session,
    type: "started",
    ...(native ? { payload: { native_session_id: native } } : {}),
  });
const receipt = (
  attempt: string,
  session: string,
  over: Partial<RunContinuityReceipt> = {},
): RunEvent =>
  row("run.continuity", {
    attempt_id: attempt,
    session_id: session,
    receipt: {
      tryIndex: 0,
      attemptId: attempt,
      carrier: "native",
      cause: "transport",
      from: { runId: "p", attemptId: "a01", profileId: null },
      to: { profileId: null },
      workspace: "same_root",
      memory: "full",
      instructions: "as_sent",
      reingestedTokens: null,
      observedModel: null,
      modelMismatch: null,
      identityCheck: "matched_before_effects",
      inputDelivery: "confirmed",
      ...over,
    },
  });

describe("recorded execution facts", () => {
  it("joins a receipt to its own start by attempt, process session and order", () => {
    const facts = runExecutionFacts([
      started("a01", "s0", "sid-A"),
      receipt("a01", "s0", { identityCheck: "mismatch_before_effects" }),
      started("a01", "s1", "sid-B"),
      receipt("a01", "s1", { tryIndex: 1, carrier: "packet", memory: "partial" }),
      // A later start of the same attempt cannot claim an earlier receipt.
      receipt("a02", "s2"),
      started("a02", "s2", "sid-C"),
    ]);
    expect(facts.attempts).toEqual(["a01", "a02"]);
    expect(facts.accepted.map((start) => start.nativeSessionId)).toEqual(["sid-B", "sid-C"]);
    expect(facts.receiptOf(facts.accepted[1]!)).toBeNull();
    expect(continuedTryStarted(facts)).toBe(true);
    expect(continuedTryStarted(facts, true)).toBe(false);
  });

  it("a fallback's first try proves delivery; a reviewer start without a receipt proves nothing", () => {
    const fallback = runExecutionFacts([
      receipt("a01", "s0"),
      started("a01-fb", "s1", "sid-FB"),
      receipt("a01-fb", "s1", { carrier: "packet", memory: "partial" }),
    ]);
    expect(continuedTryStarted(fallback, true)).toBe(true);
    const reviewer = runExecutionFacts([started("rev1", "r0"), receipt("a01", "s0")]);
    expect(continuedTryStarted(reviewer)).toBe(false);
  });

  it("history quality follows the chosen session's own record and never guesses", () => {
    const facts = runExecutionFacts([
      started("a01", "s0", "sid-A"),
      started("a01", "s1", "sid-P"),
      receipt("a01", "s1", { tryIndex: 1, carrier: "packet", memory: "partial" }),
      started("a01-fb", "s2", "sid-FB"),
    ]);
    const held = (attemptId: string, nativeSessionId: string) => ({ attemptId, nativeSessionId });
    expect(recordedSessionMemory(facts, held("a01", "sid-A"), false)).toBe("full");
    expect(recordedSessionMemory(facts, held("a01", "sid-A"), true)).toBe("unknown");
    expect(recordedSessionMemory(facts, held("a01", "sid-P"), false)).toBe("partial");
    // A later attempt's own session without a receipt has no recorded origin.
    expect(recordedSessionMemory(facts, held("a01-fb", "sid-FB"), false)).toBe("unknown");
    expect(recordedSessionMemory(facts, held("a09", "sid-missing"), false)).toBe("unknown");
    // A seeded native first try that never started keeps its receipt's recorded memory.
    const seeded = runExecutionFacts([receipt("a01", "s0", { memory: "partial" })]);
    expect(recordedSessionMemory(seeded, held("a01", "sid-seeded"), true)).toBe("partial");
  });
});

describe("the work a held session never received", () => {
  const work = (attempt: string, session: string) =>
    row("harness.event", { attempt_id: attempt, session_id: session, type: "tool_call" });

  it("is every other attempt, whatever the event order: timing is not lineage", () => {
    const interleaved = runExecutionFacts([
      started("a01", "s1", "sid-1"),
      started("a02", "s2", "sid-2"),
      work("a02", "s2"),
      work("a01", "s1"),
    ]);
    const delayed = runExecutionFacts([
      started("a01", "s1", "sid-1"),
      work("a01", "s1"),
      started("a02", "s2", "sid-2"),
      work("a02", "s2"),
    ]);
    for (const facts of [interleaved, delayed]) {
      expect(uncoveredAttempts(facts, "a01")).toEqual(["a02"]);
      expect(uncoveredAttempts(facts, "a02")).toEqual(["a01"]);
    }
    expect(uncoveredAttempts(delayed, "a09")).toEqual([]);
  });

  it("excludes only what a packet of this run briefed it with (a successor's later attempt)", () => {
    const facts = runExecutionFacts([
      started("a01", "s0", "sid-A"),
      work("a01", "s0"),
      started("a01-fb", "s1", "sid-FB"),
      receipt("a01-fb", "s1", { carrier: "packet", memory: "partial" }),
      started("a02", "s2", "sid-2"),
    ]);
    expect(uncoveredAttempts(facts, "a01-fb")).toEqual(["a02"]);
    // The first attempt was briefed with nothing of this run: everything later is new to it.
    expect(uncoveredAttempts(facts, "a01")).toEqual(["a01-fb", "a02"]);
  });
});

describe("the carrying session of a predecessor", () => {
  function runDir(events: RunEvent[], capsules: Record<string, [string, number]>) {
    const dir = mkdtempSync(join(tmpdir(), "cx-carrier-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    for (const [attempt, [sid, mtimeMs]] of Object.entries(capsules)) {
      mkdirSync(join(dir, "attempts", attempt), { recursive: true });
      writeFileSync(
        join(dir, "attempts", attempt, "session-capsule.json"),
        JSON.stringify({
          harness: "fake",
          nativeSessionId: sid,
          holderProfileId: "a",
          file: null,
          mtimeMs,
          sidecars: [],
          cwd: "/w",
          requestedModel: null,
        }),
      );
    }
    return dir;
  }

  it("is the last accepted start's capsule, whatever the capsule mtimes or directory order", () => {
    const dir = runDir([started("a01", "s0", "sid-A"), started("a01-fb", "s1", "sid-FB")], {
      a01: ["sid-A", 9_999],
      "a01-fb": ["sid-FB", 1],
    });
    const evidence = readContinuationEvidence(dir);
    expect(evidence.held?.attemptId).toBe("a01-fb");
    expect(evidence.attempts).toEqual(["a01", "a01-fb"]);
    expect(evidence.sessionMemory).toBe("unknown");
  });

  it("a later attempt that started but did nothing cannot evict the attempt that holds the work", () => {
    const dir = runDir(
      [
        started("a01", "s0", "sid-A"),
        row("harness.event", { attempt_id: "a01", session_id: "s0", type: "tool_call" }),
        started("a01-fb", "s1", "sid-FB"),
        // Narration of a crashed try is evidence, not progress.
        row("harness.event", {
          attempt_id: "a01-fb",
          session_id: "s1",
          type: "message",
          text: "looking around",
        }),
      ],
      { a01: ["sid-A", 1], "a01-fb": ["sid-FB", 2] },
    );
    expect(readContinuationEvidence(dir).held?.attemptId).toBe("a01");
  });

  it("a fallback that never started cannot evict the earlier carrier", () => {
    const dir = runDir(
      [started("a01", "s0", "sid-A"), row("harness.started", { attempt_id: "a01-fb" })],
      {
        a01: ["sid-A", 1],
      },
    );
    expect(readContinuationEvidence(dir).held?.capsule.nativeSessionId).toBe("sid-A");
  });

  it("a start refused by its own handshake carries nothing; a started attempt without a capsule has no native carrier", () => {
    const mismatched = runDir(
      [
        started("a01", "s0", "sid-A"),
        started("a01-fb", "s1", "sid-X"),
        receipt("a01-fb", "s1", { identityCheck: "mismatch_before_effects" }),
      ],
      { a01: ["sid-A", 1], "a01-fb": ["sid-X", 2] },
    );
    expect(readContinuationEvidence(mismatched).held?.attemptId).toBe("a01");
    const capsuleless = runDir([started("a01", "s0", "sid-A"), started("a02", "s1")], {
      a01: ["sid-A", 1],
    });
    expect(readContinuationEvidence(capsuleless).held).toBeNull();
    expect(readContinuationEvidence(capsuleless).attemptId).toBe("a02");
  });

  it("without any start or receipt, the run's only capsule carries; several stay unchosen", () => {
    const only = runDir([], { a01: ["sid-A", null as unknown as number] });
    expect(readContinuationEvidence(only).held?.capsule.nativeSessionId).toBe("sid-A");
    expect(readContinuationEvidence(only).sessionMemory).toBe("unknown");
    const several = runDir([], { a01: ["sid-A", 1], a02: ["sid-B", 9_999] });
    expect(readContinuationEvidence(several).held).toBeNull();
  });

  it("without any start, the seeded native first try's capsule carries", () => {
    const dir = runDir([receipt("a01", "s0", { carrier: "native_moved" })], {
      a01: ["sid-A", 1],
      a02: ["sid-other", 5],
    });
    expect(readContinuationEvidence(dir).held?.attemptId).toBe("a01");
  });
});

/*
 * Astra r1 review repro, verbatim assertions (`chain-review/concurrent-source.repro.test.ts`;
 * the baseline differential it also ran is recorded in its log). Imports adapted.
 */
it("keeps a concurrent predecessor terminal source when a later independent candidate also progressed", () => {
  expect(
    continuationRefusal({ mode: "agent", n: 1, continueFrom: "run-P" }, [
      { id: "job-P", runId: "run-P", state: "failed", params: { mode: "agent", n: 2 } },
    ]),
  ).toBeNull();
  const root = mkdtempSync(join(tmpdir(), "cx-concurrent-source-"));
  try {
    mkdirSync(join(root, "final"));
    const block = RunResumable.parse({
      cause: "transport",
      resetsAt: null,
      limitWindow: null,
      limitEvidence: null,
      carriers: ["native", "native_moved", "packet"],
      limitCode: null,
      session: { harness: "fake", nativeSessionId: "sid-first", holderProfileId: "a" },
      workspace: { kind: "none", root: null },
    });
    writeFileSync(join(root, "final", "resumable.yaml"), JSON.stringify(block));
    const events: unknown[] = [];
    let seq = 0;
    for (const [attempt, native] of [
      ["a01", "sid-first"],
      ["a02", "sid-later"],
    ]) {
      const dir = join(root, "attempts", attempt!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "session-capsule.json"),
        JSON.stringify({
          harness: "fake",
          nativeSessionId: native,
          holderProfileId: "a",
          file: null,
          mtimeMs: null,
          sidecars: [],
          cwd: root,
          requestedModel: null,
        }),
      );
      for (const [type, payload] of [
        ["started", { native_session_id: native }],
        ["tool_call", {}],
      ] as const)
        events.push({
          seq: ++seq,
          ts: new Date().toISOString(),
          run_id: "run-P",
          task_id: "task-P",
          type: "harness.event",
          payload: {
            type,
            harness_id: "fake",
            attempt_id: attempt,
            session_id: `process-${attempt}`,
            payload,
          },
        });
    }
    writeFileSync(
      join(root, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    expect(readContinuationEvidence(root).held?.capsule.nativeSessionId).toBe("sid-first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the declared terminal source speaks for a predecessor", () => {
  const capsules = (dir: string, entries: Record<string, string>) => {
    for (const [attempt, sid] of Object.entries(entries)) {
      mkdirSync(join(dir, "attempts", attempt), { recursive: true });
      writeFileSync(
        join(dir, "attempts", attempt, "session-capsule.json"),
        JSON.stringify({
          harness: "fake",
          nativeSessionId: sid,
          holderProfileId: "a",
          file: null,
          mtimeMs: null,
          sidecars: [],
          cwd: "/w",
          requestedModel: null,
        }),
      );
    }
  };
  const progressed = (attempt: string, session: string) =>
    row("harness.event", { attempt_id: attempt, session_id: session, type: "tool_call" });

  it("a block that names no session leaves no native carrier, whatever progressed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-declared-"));
    roots.push(dir);
    mkdirSync(join(dir, "final"));
    capsules(dir, { a01: "sid-A" });
    writeFileSync(
      join(dir, "events.jsonl"),
      [started("a01", "s0", "sid-A"), progressed("a01", "s0")]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    writeFileSync(
      join(dir, "final", "resumable.yaml"),
      JSON.stringify({
        cause: "transport",
        resetsAt: null,
        limitWindow: null,
        limitEvidence: null,
        carriers: ["packet"],
        limitCode: null,
        session: null,
        workspace: { kind: "none", root: null },
      }),
    );
    expect(readContinuationEvidence(dir).held).toBeNull();
  });

  it("a completed concurrent run continues its final attempt, not the newest that progressed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-declared-"));
    roots.push(dir);
    mkdirSync(join(dir, "final"));
    capsules(dir, { a01: "sid-win", a02: "sid-lost" });
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        started("a01", "s0", "sid-win"),
        started("a02", "s1", "sid-lost"),
        progressed("a01", "s0"),
        progressed("a02", "s1"),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    const web = {
      required: false,
      policy: "auto",
      effective_mode: "auto",
      attempted: false,
      satisfied: false,
      status: "none",
      tool: null,
      target: null,
      error_summary: null,
    };
    writeFileSync(
      join(dir, "final", "telemetry.yaml"),
      JSON.stringify(
        RunTelemetry.parse({
          schema_version: SCHEMA_VERSION,
          run_id: "run-w",
          task_id: "task-w",
          mode: "agent",
          requested_access: "workspace_write",
          effective_access: "workspace_write",
          external_context_policy: "auto",
          effective_web_mode: "auto",
          web,
          final_attempt_id: "a01",
          attempts: [],
          generated_at: "2026-10-29T00:00:00.000Z",
        }),
      ),
    );
    expect(readContinuationEvidence(dir).held?.capsule.nativeSessionId).toBe("sid-win");
  });
});
