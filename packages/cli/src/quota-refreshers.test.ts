import { describe, expect, it } from "vitest";
import { quotaSourceTraits, quotaSourcesProducedByRefreshers } from "@claudexor/schema";
import { QUOTA_REFRESHER_REGISTRATIONS, quotaRefreshers } from "./quota-refreshers.js";

describe("quota refresher composition", () => {
  it("matches every schema source declared as produced by a refresher", () => {
    expect(QUOTA_REFRESHER_REGISTRATIONS.map(({ source }) => source).sort()).toEqual(
      quotaSourcesProducedByRefreshers().sort(),
    );
    expect(quotaRefreshers()).toHaveLength(QUOTA_REFRESHER_REGISTRATIONS.length);
  });

  it("pins each registration's pacing lane to its schema demand harness", () => {
    // The vendor lane is a declaration at the composition site; the schema
    // trait registry is its SSOT wherever one exists. claude_statusline's
    // demand harness is deliberately null (spool source), so only its lane
    // membership (claude evidence -> claude lane) is asserted directly.
    for (const { source, vendor } of QUOTA_REFRESHER_REGISTRATIONS) {
      const demandHarness = quotaSourceTraits(source).refreshDemandHarness;
      if (demandHarness !== null) expect(vendor).toBe(demandHarness);
    }
    expect(
      QUOTA_REFRESHER_REGISTRATIONS.find(({ source }) => source === "claude_statusline")?.vendor,
    ).toBe("claude");
  });
});
