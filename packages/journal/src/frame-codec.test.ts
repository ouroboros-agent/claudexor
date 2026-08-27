import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { COMPACTED_SNAPSHOT, encodeFrame, replayFrames, ZERO_HASH } from "./frame-codec.js";

function compactedFrame(records: unknown[], encodedRecords = JSON.stringify(records)): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      count: records.length,
      encoding: "gzip-base64",
      data: gzipSync(Buffer.from(encodedRecords)).toString("base64"),
    }),
  );
  return encodeFrame(
    {
      partition: "global",
      epoch: "epoch-test",
      seq: 1,
      previousFrameHash: ZERO_HASH,
      time: "2026-01-01T00:00:00.000Z",
      type: COMPACTED_SNAPSHOT,
      logicalSpan: records.length,
    },
    payload,
  );
}

describe("compacted journal frames", () => {
  it("replays nested records with escaped delimiters and Unicode payloads", () => {
    const records = [
      {
        time: "2026-01-01T00:00:00.000Z",
        type: "probe.saved",
        payload: {
          text: 'braces { } and brackets [ ] and comma, quote " and slash \\',
          nested: [{ value: "Привет 🌍" }],
        },
      },
      {
        time: "2026-01-01T00:00:01.000Z",
        type: "probe.finished",
        payload: { ok: true },
      },
    ];

    const result = replayFrames(compactedFrame(records), "global");

    expect(result.error).toBeNull();
    expect(result.incompleteOffset).toBeNull();
    expect(result.records.map(({ time, type, payload }) => ({ time, type, payload }))).toEqual(
      records,
    );
  });

  it("rejects trailing JSON after the declared compacted array", () => {
    const records = [
      { time: "2026-01-01T00:00:00.000Z", type: "probe.saved", payload: { value: 1 } },
    ];

    const result = replayFrames(
      compactedFrame(records, `${JSON.stringify(records)} trailing`),
      "global",
    );

    expect(result.records).toEqual([]);
    expect(result.error?.reason).toContain("compacted snapshot is invalid");
  });

  it("replays a multi-megabyte logical snapshot without a whole-array parse", () => {
    const records = Array.from({ length: 40_000 }, (_, index) => ({
      time: "2026-01-01T00:00:00.000Z",
      type: "grown.history",
      payload: { index, repeated: "same-value".repeat(40) },
    }));
    const frame = compactedFrame(records);
    // Keep the physical frame small so the guard below only catches the old
    // whole-decompressed-buffer conversion, not ordinary frame decoding.
    expect(frame.length).toBeLessThan(1024 * 1024);
    const originalToString = Buffer.prototype.toString;
    Buffer.prototype.toString = function (
      encoding?: BufferEncoding,
      start?: number,
      end?: number,
    ): string {
      if (this.length > 1024 * 1024) throw new Error("whole snapshot conversion");
      return originalToString.call(this, encoding, start, end);
    };

    const result = (() => {
      try {
        return replayFrames(frame, "global");
      } finally {
        Buffer.prototype.toString = originalToString;
      }
    })();

    expect(result.error).toBeNull();
    expect(result.records).toHaveLength(records.length);
    expect(result.records.at(-1)?.payload).toEqual(records.at(-1)?.payload);
  });
});
