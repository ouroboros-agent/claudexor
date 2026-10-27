import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_REPLAY_BYTES,
  readEventReplayBatch,
  type EventReplayCursor,
  type EventReplayFrame,
} from "./event-replay-batch.js";
import { redactedSseLine, streamLineIdentity } from "./sse-shared.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function log(text: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-replay-"));
  dirs.push(dir);
  const path = join(dir, "events.jsonl");
  writeFileSync(path, text);
  return path;
}
function collect(path: string, lastEventId: number, initial?: EventReplayCursor) {
  const frames: EventReplayFrame[] = [];
  let cursor = initial;
  let batches = 0;
  for (;;) {
    const batch = readEventReplayBatch({ path, lastEventId, cursor });
    frames.push(...batch.frames);
    cursor = batch.cursor;
    batches += 1;
    if (!batch.progressed) return { frames, cursor, batches };
    if (batches > 10_000) throw new Error("replay did not finish");
  }
}
function oldReplay(text: string, lastEventId: number): EventReplayFrame[] {
  return text
    .slice(0, text.lastIndexOf("\n"))
    .split("\n")
    .filter(Boolean)
    .map((raw, index) => {
      const { seq, type } = streamLineIdentity(raw, index + 1);
      return {
        seq,
        type,
        data: redactedSseLine(raw),
        terminal: ["run.completed", "run.failed", "run.blocked"].includes(type),
      };
    })
    .filter((frame) => frame.seq > lastEventId);
}

describe("finite event replay", () => {
  it("resumes a large durable log from its tail without parsing its prefix", () => {
    const text =
      Array.from({ length: 4_000 }, (_, i) =>
        JSON.stringify({
          seq: i + 1,
          type: "text",
          text: `${i}:` + "x".repeat(256),
        }),
      ).join("\n") + "\n";
    const path = log(text);
    const parse = vi.spyOn(JSON, "parse");
    const actual = collect(path, 3_995);
    expect(actual.frames.map((frame) => frame.seq)).toEqual([3_996, 3_997, 3_998, 3_999, 4_000]);
    expect(actual.batches).toBeLessThanOrEqual(3);
    expect(parse.mock.calls.length).toBeLessThan(30);
    expect(parse.mock.calls.some(([raw]) => String(raw).includes('"text":"0:'))).toBe(false);
  });

  it("counts legacy positions and conservatively scans for a durable fence", () => {
    const text =
      Array.from({ length: 2_000 }, (_, i) =>
        JSON.stringify({
          type: "text",
          text: `${i}:` + "x".repeat(80),
        }),
      ).join("\n\n") + "\n";
    const path = log(text);
    const actual = collect(path, 1_995);
    expect(actual.frames.map((frame) => frame.seq)).toEqual([1_996, 1_997, 1_998, 1_999, 2_000]);
  });

  it.each([0, 1, 2, 5, 6, 7, 10])(
    "matches the original replay for mixed legacy rows at cursor %i",
    (last) => {
      const text = [
        JSON.stringify({ type: "run.started" }),
        "",
        "malformed",
        " ",
        JSON.stringify({ type: "text", seq: 5, text: "hello" }),
        JSON.stringify({ type: "text", seq: 6, text: "world" }),
        JSON.stringify({ type: "run.completed", seq: 7 }),
        "",
        "torn",
      ].join("\n");
      expect(collect(log(text), last).frames).toEqual(oldReplay(text, last));
    },
  );

  it("uses absolute legacy identity when a no-seq row is appended after a durable resume", () => {
    const text =
      `${JSON.stringify({ type: "text", seq: 1 })}\n` +
      `${JSON.stringify({ type: "text", seq: 10 })}\n`;
    const path = log(text);
    const first = collect(path, 1);
    appendFileSync(path, `${JSON.stringify({ type: "text", text: "legacy" })}\n`);
    const next = collect(path, 1, first.cursor);
    expect(next.frames.map((frame) => frame.seq)).toEqual([3]);
  });

  it("does not let a low legacy fallback hide an earlier durable seq after a gap", () => {
    const text = '{"type":"text","seq":100}\nmalformed\n';
    expect(collect(log(text), 50).frames).toEqual(oldReplay(text, 50));
  });

  it("recognizes escaped seq keys in mixed legacy logs", () => {
    const text = '{"type":"text","\\u0073eq":100}\nmalformed\n';
    expect(collect(log(text), 50).frames).toEqual(oldReplay(text, 50));
  });

  it("preserves UTF-8 carry and redacts a complete event across byte batches", () => {
    const secret = "sk-proj-" + "a".repeat(48);
    const prefix = '{"type":"text","seq":1,"text":"';
    const text =
      prefix + "x".repeat(EVENT_REPLAY_BYTES - Buffer.byteLength(prefix) - 1) + `😀 ${secret}"}\n`;
    const path = log(text);
    const actual = collect(path, 0);
    expect(actual.frames).toEqual(oldReplay(text, 0));
    expect(actual.frames[0]!.data).toContain("😀");
    expect(actual.frames[0]!.data).not.toContain(secret);
    expect(actual.batches).toBeGreaterThan(2);
  });

  it("keeps an unfinished final event until appended bytes complete it", () => {
    const path = log('{"type":"text","seq":1,"text":"😀');
    const before = collect(path, 0);
    expect(before.frames).toEqual([]);
    appendFileSync(path, ' done"}\n');
    expect(collect(path, 0, before.cursor).frames[0]!.data).toContain("😀 done");
  });

  it("discards carry after truncation, and an absent file remains a wait", () => {
    const path = log('{"type":"text","seq":1,"text":"unfinished');
    const before = collect(path, 0);
    writeFileSync(path, '{"type":"text","seq":2}\n');
    expect(collect(path, 0, before.cursor).frames.map((frame) => frame.seq)).toEqual([2]);
    rmSync(path);
    expect(readEventReplayBatch({ path, lastEventId: 0 }).missing).toBe(true);
  });

  it("does not stamp newly appended terminal bytes with a resume cursor captured earlier", () => {
    const path = log('{"type":"run.started","seq":1}\n');
    const seek = readEventReplayBatch({ path, lastEventId: 1 });
    appendFileSync(path, '{"type":"run.completed","seq":2}\n');
    expect(collect(path, 1, seek.cursor).frames.map((frame) => frame.seq)).toEqual([2]);
  });
});
