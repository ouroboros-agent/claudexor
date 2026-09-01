import { describe, expect, it } from "vitest";
import type { QuotaSnapshot, QuotaSubject } from "@claudexor/schema";
import { remainingQuotaRefreshDemand } from "./quota-refresh-demand.js";
import { staleAt } from "./quota-registry-support.js";

const subject = (harness: string, subjectId: string | null): QuotaSubject => ({
  harness,
  credential_route: "vendor_native",
  plan_label: null,
  subject_id: subjectId,
});

const snapshot = (owner: QuotaSubject, source: QuotaSnapshot["source"]): QuotaSnapshot => ({
  subject: owner,
  constraints: [],
  source,
  observed_at: "2026-08-09T00:00:00.000Z",
  freshness: "fresh",
});

describe("remainingQuotaRefreshDemand", () => {
  it("ignores subjects without a refresh-capable primary harness", () => {
    expect(remainingQuotaRefreshDemand([], [subject("cursor", "work")])).toEqual(new Set());
  });

  it("requires matching primary evidence rather than reactive evidence", () => {
    const owner = subject("codex", "work");
    expect(remainingQuotaRefreshDemand([snapshot(owner, "codex_rollout")], [owner])).toEqual(
      new Set(["codex\0work"]),
    );
    expect(remainingQuotaRefreshDemand([snapshot(owner, "codex_app_server")], [owner])).toEqual(
      new Set(),
    );
  });

  it("keeps current-time staleness strict while horizon demand includes TTL equality", () => {
    const owner = subject("codex", "work");
    const primary = snapshot(owner, "codex_app_server");
    const boundary = Date.parse("2026-08-09T00:05:00.000Z");

    expect(staleAt(primary, boundary).freshness).toBe("fresh");
    expect(staleAt(primary, boundary + 1).freshness).toBe("stale");
    expect(remainingQuotaRefreshDemand([primary], [owner])).toEqual(new Set());
    expect(remainingQuotaRefreshDemand([primary], [owner], boundary - 1)).toEqual(new Set());
    expect(remainingQuotaRefreshDemand([primary], [owner], boundary)).toEqual(
      new Set(["codex\0work"]),
    );
  });

  it("treats reset boundaries at or before the horizon as demand", () => {
    const owner = subject("codex", "work");
    const deadline = Date.parse("2026-08-09T00:05:00.000Z");
    const withReset = (resetsAt: string): QuotaSnapshot => ({
      ...snapshot(owner, "codex_app_server"),
      observed_at: "2026-08-09T00:04:00.000Z",
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 0.2,
          window_seconds: 18_000,
          resets_at: resetsAt,
          cooldown_until: null,
        },
      ],
    });

    expect(
      remainingQuotaRefreshDemand([withReset("2026-08-09T00:05:00.000Z")], [owner], deadline),
    ).toEqual(new Set(["codex\0work"]));
    expect(
      remainingQuotaRefreshDemand([withReset("2026-08-09T00:04:59.999Z")], [owner], deadline),
    ).toEqual(new Set(["codex\0work"]));
    expect(
      remainingQuotaRefreshDemand([withReset("2026-08-09T00:05:00.001Z")], [owner], deadline),
    ).toEqual(new Set());
  });

  it("preserves missing and already-stale demand", () => {
    const owner = subject("codex", "work");
    expect(remainingQuotaRefreshDemand([], [owner], Date.now())).toEqual(new Set(["codex\0work"]));
    expect(
      remainingQuotaRefreshDemand(
        [{ ...snapshot(owner, "codex_app_server"), freshness: "stale" }],
        [owner],
        Date.now(),
      ),
    ).toEqual(new Set(["codex\0work"]));
  });
});
