/**
 * STRICT run-preflight model gate (INV-104): every route that resolved an
 * explicit model (per-run map or per-harness settings default) must pass its
 * harness's model truth source — the live `models()` inventory when the
 * adapter has one, else the manifest `known_models` list. A violation throws
 * a typed error BEFORE any vendor CLI spawns; the orchestrator surfaces it
 * through the routing-failure path, so failure.yaml names harness, model, and
 * truth source.
 *
 * Two rules keep the gate honest about WHICH account answered:
 * - The inventory is asked of the account the run will actually use. A
 *   profile-pinned route derives its auth route from that profile's credential
 *   kind, and the query carries the profile's own state HOME, so model truth
 *   can never come from the default credential store.
 * - Nothing about the spawned spec is rewritten to make the two agree. A
 *   profile-less `auto` run is enumerated with the same `auto` preference the
 *   adapter will resolve, so preflight and spawn share one resolution instead
 *   of the gate freezing a route the adapter would then be unable to disclose.
 *
 * A fallback model is checked by the authoritative per-spawn gate only after
 * its own quota/profile preflight; checking it against the primary profile
 * here would reject a valid cross-profile fallback.
 */
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, validateModel } from "@claudexor/core";
import {
  knownModelIdsForRoute,
  type CredentialProfile,
  type HarnessEvent,
  type HarnessRunSpec,
  type KnownModelEntry,
} from "@claudexor/schema";

export interface ModelGovernedRoute {
  adapter: HarnessAdapter;
  /** Manifest model truth source (used when the adapter has no live models()). */
  knownModels: readonly KnownModelEntry[];
  /** Pre-spawn credential-route estimate: route-annotated manifest models are
   * filtered by it, and stay EXCLUDED when it is null (fail-closed — a
   * route-scoped model never passes the gate on an undecidable route). */
  authRouteEstimate: "local_session" | "api_key" | null;
  /** Effective account after profile preflight/rotation. Model truth must come
   * from this same identity, never the default credential store. */
  quotaAdmission: { profile: CredentialProfile | null };
  settings: { defaultModel: string | null; fallbackModel: string | null } | null;
}

type ModelCandidate = { role: string; model: string };
type ModelTruth = {
  list: readonly string[];
  source: "api" | "manifest";
  route: "local_session" | "api_key" | null;
};

/** A pinned profile decides the route by its credential kind; without one the
 * pre-spawn estimate stands (and stays fail-closed when undecidable). */
function authRouteForProfile(
  profile: CredentialProfile | null,
  estimate: ModelGovernedRoute["authRouteEstimate"],
): ModelGovernedRoute["authRouteEstimate"] {
  if (!profile) return estimate;
  return profile.credential_kind === "api_key" ? "api_key" : "local_session";
}

async function modelTruthForRoute(
  routed: ModelGovernedRoute,
  query: {
    cwd: string;
    env?: HarnessRunSpec["env"];
    authPreference?: HarnessRunSpec["auth_preference"];
    profile: CredentialProfile | null;
  },
): Promise<ModelTruth> {
  const route = authRouteForProfile(query.profile, routed.authRouteEstimate);
  if (typeof routed.adapter.models === "function") {
    const inventory = await routed.adapter.models({
      cwd: query.cwd,
      ...(query.env ? { env: query.env } : {}),
      ...(query.authPreference ? { authPreference: query.authPreference } : {}),
      ...(query.profile ? { credentialProfile: query.profile } : {}),
    });
    return { list: inventory.map((model) => model.id), source: "api", route };
  }
  return { list: knownModelIdsForRoute(routed.knownModels, route), source: "manifest", route };
}

function assertModelsAllowed(
  routed: ModelGovernedRoute,
  candidates: readonly ModelCandidate[],
  truth: ModelTruth,
  profile: CredentialProfile | null,
): void {
  for (const { role, model } of candidates) {
    const check = validateModel(model, truth.list, truth.source);
    if (check.status === "ok") continue;
    // A pinned profile OWNS this inventory: sending the operator to the
    // profile-less `claudexor models` would print a different account's list.
    const remedy = profile
      ? `the selected credential profile '${profile.profile_id}' supplied this inventory; verify or re-authenticate that profile, then inspect its live vendor model list`
      : `run \`claudexor models --harness ${routed.adapter.id}\``;
    throw new HarnessUnavailableError(
      `harness '${routed.adapter.id}' refused ${role} '${model}' (truth source: ${truth.source}${truth.source === "manifest" ? `, route: ${truth.route ?? "undecided"}` : ""}): ${check.message}; ` +
        remedy,
    );
  }
}

export async function assertRouteModelsAllowed(
  routes: readonly ModelGovernedRoute[],
  models: Record<string, string> | undefined,
  cwd: string,
  /** The mutable state HOME the eventual spawn will receive for this harness,
   * so an account-scoped inventory is read from that same home. */
  routeStateEnvFor?: (harnessId: string) => Record<string, string> | undefined,
): Promise<void> {
  const checked = new Set<string>();
  for (const routed of routes) {
    const id = routed.adapter.id;
    if (checked.has(id)) continue;
    checked.add(id);
    const resolved = models?.[id] ?? routed.settings?.defaultModel ?? null;
    if (!resolved) continue;
    const profile = routed.quotaAdmission.profile;
    const routeStateEnv = routeStateEnvFor?.(id);
    const truth = await modelTruthForRoute(routed, {
      cwd,
      ...(routeStateEnv ? { env: routeStateEnv } : {}),
      profile,
    });
    assertModelsAllowed(routed, [{ role: "model", model: resolved }], truth, profile);
  }
}

/**
 * Authoritative per-spawn model gate. Admission validates the initially routed
 * account early; this guard rebinds the same strict truth contract to the
 * profile, auth preference, cwd, and mutable state HOME the vendor process will
 * actually receive. Every routed spawn funnels through this generator, so a
 * quota rotation or fallback-model preflight cannot reuse another account's
 * inventory. The spec is passed to the adapter byte-identical: the gate reads
 * the run's identity, it never rewrites it.
 */
export async function* runModelGovernedRoute(
  routed: ModelGovernedRoute,
  spec: HarnessRunSpec,
): AsyncIterable<HarnessEvent> {
  const model = spec.model_hint?.trim();
  if (model) {
    const profile = spec.credential_profile ?? null;
    const truth = await modelTruthForRoute(routed, {
      cwd: spec.cwd,
      env: spec.env,
      authPreference: spec.auth_preference,
      profile,
    });
    assertModelsAllowed(routed, [{ role: "model", model }], truth, profile);
  }
  yield* routed.adapter.run(spec);
}
