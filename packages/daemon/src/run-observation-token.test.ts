import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestPendingIdentities } from "./interactions.js";
import { readRunObservations } from "./run-observation.js";

/** Tokens this fixture's policy flags on top of the shared secret scan. */
const flagged = vi.hoisted(() => new Set<string>());
vi.mock("@claudexor/util", async (importOriginal) => {
  const real = await importOriginal<typeof import("@claudexor/util")>();
  return {
    ...real,
    containsSecretLikeToken: (text: string) =>
      flagged.has(text) || real.containsSecretLikeToken(text),
  };
});

const STORE = "11111111-1111-4111-8111-111111111111";
const record = {
  jobId: "job-a",
  runId: "run-a",
  state: "running",
  partition: "global",
  epoch: "e".repeat(32),
  createdAt: "2026-10-22T00:00:00.000Z",
} as const;
const pending = digestPendingIdentities(["question-a"]);
const facts = [
  "claudexor.run-observation",
  1,
  STORE,
  record.partition,
  record.epoch,
  record.jobId,
  record.runId,
  record.state,
  pending.digest,
];
const attempt = (n: number) =>
  createHash("sha256")
    .update(JSON.stringify(n === 0 ? facts : [...facts, n]))
    .digest("base64url");

async function token() {
  const [row] = await readRunObservations(
    { observationRecords: () => [record] },
    { snapshotPendingIdentities: async (ids) => new Map(ids.map((id) => [id, pending])) },
    STORE,
    ["job-a"],
  );
  return row!.token;
}

afterEach(() => flagged.clear());

describe("observation tokens a caller can echo", () => {
  it("keeps the earlier bytes when the secret scan accepts the digest", async () => {
    expect(await token()).toBe(attempt(0));
  });

  it("re-derives a flagged digest from the same facts, stably, until the scan accepts it", async () => {
    flagged.add(attempt(0));
    expect(await token()).toBe(attempt(1));
    expect(await token()).toBe(attempt(1));
    flagged.add(attempt(1));
    expect(await token()).toBe(attempt(2));
  });

  it("stops after eight re-derivations", async () => {
    for (let n = 0; n <= 8; n++) flagged.add(attempt(n));
    expect(await token()).toBe(attempt(8));
  });
});
