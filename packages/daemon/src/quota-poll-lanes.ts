import type { QuotaAbsence, QuotaSnapshot, QuotaSubject } from "@claudexor/schema";
import { QuotaPollPacer, type QuotaPacerStateStore } from "./quota-poll-pacer.js";
import { remainingQuotaRefreshDemand } from "./quota-refresh-demand.js";

/** One refresh cycle's fruit: the snapshots a source observed, plus the typed
 * absences it CLAIMS for subjects it tried and could not observe. Absence is
 * stated by the source, never inferred from an empty snapshot list. */
export interface QuotaRefreshResult {
  snapshots: QuotaSnapshot[];
  absences?: QuotaAbsence[];
}

export type QuotaRefresher = () => Promise<QuotaRefreshResult>;

/** A refresher bound to its vendor pacing lane. Refreshers of one vendor
 * share ONE QuotaPollPacer, so a permanently unsatisfiable subject of one
 * vendor backs off alone instead of pinning every vendor's cadence at the
 * 15-minute ceiling. A bare QuotaRefresher (legacy embedders, tests) rides an
 * anonymous lane with the pre-existing global-demand semantics. */
export interface QuotaVendorRefresher {
  readonly vendor: string;
  readonly refresh: QuotaRefresher;
}

export interface PacingLane {
  readonly vendor: string | null;
  readonly pacer: QuotaPollPacer;
}

export interface RefresherLanes {
  /** Declaration-ordered refreshers, each bound to its pacing lane. */
  readonly entries: ReadonlyArray<{ lane: PacingLane; refresh: QuotaRefresher }>;
  /** Distinct pacing lanes in first-appearance order. */
  readonly lanes: readonly PacingLane[];
}

export function buildRefresherLanes(
  refreshers: readonly (QuotaRefresher | QuotaVendorRefresher)[],
  pacerStore?: QuotaPacerStateStore,
): RefresherLanes {
  const laneByVendor = new Map<string, PacingLane>();
  const entries = refreshers.map((registration) => {
    if (typeof registration === "function") {
      return { lane: { vendor: null, pacer: new QuotaPollPacer() }, refresh: registration };
    }
    let lane = laneByVendor.get(registration.vendor);
    if (!lane) {
      lane = {
        vendor: registration.vendor,
        pacer: new QuotaPollPacer(registration.vendor, pacerStore),
      };
      laneByVendor.set(registration.vendor, lane);
    }
    return { lane, refresh: registration.refresh };
  });
  return { entries, lanes: [...new Set(entries.map((entry) => entry.lane))] };
}

export interface PollSweepDeps {
  readonly now: () => Date;
  readonly publishClockTransition: () => void;
  readonly laneHasDemand: (vendor: string | null, now: number) => boolean;
  readonly currentGeneration: () => number;
  readonly isCurrentGeneration: (generation: number) => boolean;
  readonly runLaneCycle: (lane: PacingLane) => Promise<unknown>;
}

/** One background poll sweep: drive every vendor lane in order, running a
 * coalesced cycle for each lane that is past its pacer gates and still has
 * refresh demand, so one vendor's backoff never starves a sibling vendor's
 * freshness. Resolves true when any lane refreshed. Single-flight of the
 * sweep itself belongs to the caller. */
export async function performPollSweep(
  lanes: readonly PacingLane[],
  deps: PollSweepDeps,
): Promise<boolean> {
  deps.publishClockTransition();
  let ran = false;
  for (const lane of lanes) {
    const now = deps.now().getTime();
    if (!lane.pacer.pollEligible(now)) continue;
    if (!deps.laneHasDemand(lane.vendor, now)) continue;
    const generation = deps.currentGeneration();
    try {
      await deps.runLaneCycle(lane);
      ran = true;
      // A cycle fenced away by a credential change reports no pacing
      // outcome: the fresh-generation poll re-decides from scratch.
      if (!deps.isCurrentGeneration(generation)) continue;
      const completedAt = deps.now().getTime();
      lane.pacer.notePollSuccess(completedAt, deps.laneHasDemand(lane.vendor, completedAt));
    } catch {
      if (deps.isCurrentGeneration(generation)) {
        lane.pacer.notePollFailure(deps.now().getTime());
      }
    }
  }
  return ran;
}

/** Per-lane refresh demand: a vendor lane sees only its own subjects and
 * snapshots; an anonymous lane keeps the pre-existing global semantics. */
export function laneHasDemand(
  vendor: string | null,
  snapshots: readonly QuotaSnapshot[],
  subjects?: readonly QuotaSubject[],
): boolean {
  if (vendor === null) return remainingQuotaRefreshDemand(snapshots, subjects).size > 0;
  return (
    remainingQuotaRefreshDemand(
      snapshots.filter((snapshot) => snapshot.subject.harness === vendor),
      subjects?.filter((subject) => subject.harness === vendor),
    ).size > 0
  );
}
