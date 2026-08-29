import { QUOTA_GAP_ABSENCE_REASONS } from "@claudexor/schema";
import type { QuotaAbsence, QuotaSnapshot, QuotaSubject } from "@claudexor/schema";
import { QuotaPollPacer, type QuotaPacerStateStore } from "./quota-poll-pacer.js";
import { quotaSubjectIdentity, remainingQuotaRefreshDemand } from "./quota-refresh-demand.js";

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

export interface LaneCycleSelection {
  readonly running: ReadonlyArray<{ lane: PacingLane; refresh: QuotaRefresher }>;
  readonly skipped: Array<{ vendor: string; not_before: string }>;
}

/** Select which refreshers one cycle runs. A full (foreground) cycle honors
 * each vendor lane's rate-limit floor: a vendor that just said 429 is not
 * re-fanned-out by an explicit refresh — its skip is returned for additive
 * disclosure. A poll-scoped cycle was already gated by the sweep. Anonymous
 * lanes never carry a floor and always run. */
export function selectCycleEntries(
  refresherLanes: RefresherLanes,
  scope: PacingLane | null,
  nowMs: number,
): LaneCycleSelection {
  const skipped =
    scope === null
      ? refresherLanes.lanes.flatMap((lane) => {
          const until = lane.vendor === null ? null : lane.pacer.rateLimitCooldownUntil(nowMs);
          return until === null
            ? []
            : [{ vendor: lane.vendor as string, not_before: new Date(until).toISOString() }];
        })
      : [];
  const skippedVendors = new Set(skipped.map((row) => row.vendor));
  const running = refresherLanes.entries.filter((entry) =>
    scope === null
      ? entry.lane.vendor === null || !skippedVendors.has(entry.lane.vendor)
      : entry.lane === scope,
  );
  return { running, skipped };
}

/** Absence recomputation covers exactly the lanes that RAN: an anonymous
 * lane's coverage is unknowable, so its cycle keeps the full rebuild. */
export function recomputeScopeFor(
  running: LaneCycleSelection["running"],
): ReadonlySet<string> | null {
  const ranLanes = [...new Set(running.map((entry) => entry.lane))];
  return ranLanes.some((lane) => lane.vendor === null)
    ? null
    : new Set(ranLanes.map((lane) => lane.vendor as string));
}

/** Derived `poll_paced` gap rows: while a vendor lane's rate-limit floor is
 * active, every universe subject of that vendor lacking FRESH snapshot cover
 * and lacking a stored absence row is stated as paused — a live projection
 * (never journaled), stable per floor so the projection signature does not
 * churn markers on every read. Keeps a suppressed vendor's subjects from
 * falling silent (daemon restarts with a store-loaded floor included) and
 * downstream exhaustion readers fail-open. */
export function derivePollPacedRows(
  lanes: readonly PacingLane[],
  subjects: readonly QuotaSubject[],
  existingRows: readonly QuotaAbsence[],
  freshCovered: ReadonlySet<string>,
  now: number,
): QuotaAbsence[] {
  const present = new Set(existingRows.map((row) => quotaSubjectIdentity(row.subject)));
  const rows: QuotaAbsence[] = [];
  for (const lane of lanes) {
    if (lane.vendor === null) continue;
    const until = lane.pacer.rateLimitCooldownUntil(now);
    if (until === null) continue;
    for (const subject of subjects) {
      if (subject.harness !== lane.vendor) continue;
      const key = quotaSubjectIdentity(subject);
      if (freshCovered.has(key) || present.has(key)) continue;
      present.add(key);
      rows.push({
        subject,
        reason: "poll_paced",
        detail: `vendor poll paused by rate-limit cooldown until ${new Date(until).toISOString()}`,
        observed_at: new Date(lane.pacer.rateLimitObservedAt(now)).toISOString(),
      });
    }
  }
  return rows;
}

/** Subject-identity cover sets over one active-snapshot view. Gap rows are
 * silenced only by the FRESH set; every other reason by any active snapshot. */
export function subjectCoverSets(active: readonly QuotaSnapshot[]): {
  covered: ReadonlySet<string>;
  freshCovered: ReadonlySet<string>;
} {
  return {
    covered: new Set(active.map((snapshot) => quotaSubjectIdentity(snapshot.subject))),
    freshCovered: new Set(
      active
        .filter((snapshot) => snapshot.freshness === "fresh")
        .map((snapshot) => quotaSubjectIdentity(snapshot.subject)),
    ),
  };
}

/** Pure absence fold for one cycle (V11a semantics): preserved out-of-scope
 * rows first, then first-claim-wins claims, then `no_source` for uncovered
 * in-scope universe subjects. Gap-representation claims ("deliberately not
 * asked": rate_limited and its skip siblings) are silenced only by a FRESH
 * snapshot — a stale one is exactly the state the gap row explains, and
 * dropping the row there would let a stale spent window read as exhausted
 * downstream. */
export function foldAbsenceClaims(input: {
  claims: readonly QuotaAbsence[];
  prior: readonly QuotaAbsence[];
  rebuilt: (harness: string) => boolean;
  covered: ReadonlySet<string>;
  freshCovered: ReadonlySet<string>;
  subjects: readonly QuotaSubject[];
  now: number;
}): QuotaAbsence[] {
  const preserved = input.prior.filter((absence) => !input.rebuilt(absence.subject.harness));
  const result: QuotaAbsence[] = [];
  const claimed = new Set<string>(preserved.map((item) => quotaSubjectIdentity(item.subject)));
  for (const claim of input.claims) {
    const key = quotaSubjectIdentity(claim.subject);
    const cover = QUOTA_GAP_ABSENCE_REASONS.has(claim.reason)
      ? input.freshCovered
      : input.covered;
    if (cover.has(key) || claimed.has(key)) continue;
    claimed.add(key);
    result.push(claim);
  }
  for (const subject of input.subjects) {
    if (!input.rebuilt(subject.harness)) continue;
    const key = quotaSubjectIdentity(subject);
    if (input.covered.has(key) || claimed.has(key)) continue;
    claimed.add(key);
    result.push({
      subject,
      reason: "no_source",
      detail: null,
      observed_at: new Date(input.now).toISOString(),
    });
  }
  return [...preserved, ...result];
}
