import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessRunSpec, type CredentialProfile } from "@claudexor/schema";
import {
  assertRouteModelsAllowed,
  runModelGovernedRoute,
  type ModelGovernedRoute,
} from "./modelGovernance.js";

describe("runModelGovernedRoute", () => {
  it("uses the exact spawn profile/state and refuses before adapter.run", async () => {
    const profile: CredentialProfile = {
      profile_id: "rotated",
      harness_id: "cursor",
      display_name: "Rotated",
      credential_kind: "api_key",
      isolation_locator: null,
      secret_ref: "cursor:rotated",
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const models = vi.fn(async () => []);
    const run = vi.fn((_spec: HarnessRunSpec) =>
      (async function* () {
        yield* [];
      })(),
    );
    const adapter = { id: "cursor", models, run } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: null },
      settings: null,
    };
    const spec = HarnessRunSpec.parse({
      session_id: "ses-model-governance",
      intent: "audit",
      prompt: "review",
      cwd: "/repo/attempt",
      env: { HOME: "/state/attempt" },
      auth_preference: "api_key",
      credential_profile: profile,
      model_hint: "profile-only-model",
    });

    const consume = async (): Promise<void> => {
      for await (const _event of runModelGovernedRoute(routed, spec)) {
        // Rejection occurs before any event can be emitted.
      }
    };
    await expect(consume()).rejects.toThrow(
      /profile 'rotated'.*verify or re-authenticate that profile/,
    );
    expect(models).toHaveBeenCalledWith({
      cwd: "/repo/attempt",
      env: { HOME: "/state/attempt" },
      authPreference: "api_key",
      credentialProfile: profile,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("assertRouteModelsAllowed", () => {
  it("uses the exact scoped env and invents no auth preference without a named profile", async () => {
    const seen: unknown[] = [];
    const adapter = {
      id: "cursor",
      models: async (spec: unknown) => {
        seen.push(spec);
        return [{ id: "profile-less-model", label: "Profile-less model" }];
      },
    } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: null },
      settings: { defaultModel: "profile-less-model", fallbackModel: null },
    };
    const env = { HOME: "/tmp/scoped-model-home" };

    await assertRouteModelsAllowed([routed], undefined, "/repo", () => env);

    // The admission route is NOT replayed as an auth preference here: the spawn
    // will resolve `auto` itself, and a preflight that asked a different
    // question than the run would be answering about a different account.
    expect(seen).toEqual([{ cwd: "/repo", env }]);
  });

  it("defers a fallback model until its own profile/state reaches the spawn guard", async () => {
    const primaryProfile: CredentialProfile = {
      profile_id: "primary",
      harness_id: "cursor",
      display_name: "Primary",
      credential_kind: "config_dir_login",
      isolation_locator: "/profiles/primary",
      secret_ref: null,
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const fallbackProfile: CredentialProfile = {
      ...primaryProfile,
      profile_id: "fallback",
      display_name: "Fallback",
      isolation_locator: "/profiles/fallback",
    };
    const run = vi.fn((_spec: HarnessRunSpec) =>
      (async function* () {
        yield* [];
      })(),
    );
    const models = vi.fn(async (spec?: { credentialProfile?: CredentialProfile | null }) => {
      return spec?.credentialProfile?.profile_id === "fallback"
        ? [{ id: "fallback-model", label: "Fallback" }]
        : [{ id: "primary-model", label: "Primary" }];
    });
    const adapter = { id: "cursor", models, run } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: primaryProfile },
      settings: { defaultModel: "primary-model", fallbackModel: "fallback-model" },
    };

    await assertRouteModelsAllowed([routed], undefined, "/repo", () => ({
      HOME: "/primary-state",
    }));

    const fallbackSpec = HarnessRunSpec.parse({
      session_id: "ses-fallback-model-governance",
      intent: "audit",
      prompt: "review",
      cwd: "/repo/fallback-attempt",
      env: { HOME: "/fallback-state" },
      auth_preference: "subscription",
      credential_profile: fallbackProfile,
      model_hint: "fallback-model",
    });
    for await (const _event of runModelGovernedRoute(routed, fallbackSpec)) {
      // The profile-specific inventory admits the fallback before run.
    }

    expect(models).toHaveBeenNthCalledWith(1, {
      cwd: "/repo",
      env: { HOME: "/primary-state" },
      credentialProfile: primaryProfile,
    });
    expect(models).toHaveBeenNthCalledWith(2, {
      cwd: "/repo/fallback-attempt",
      env: { HOME: "/fallback-state" },
      authPreference: "subscription",
      credentialProfile: fallbackProfile,
    });
    expect(run).toHaveBeenCalledWith(fallbackSpec);
  });
});

describe("profile-less auto is answered as auto, never rewritten", () => {
  const autoAdapter = (
    id: string,
    modelSpecs: unknown[],
    runSpecs: HarnessRunSpec[],
  ): HarnessAdapter =>
    ({
      id,
      models: async (spec: unknown) => {
        modelSpecs.push(spec);
        return [{ id: "bound-model", label: "Bound" }];
      },
      run: (spec: HarnessRunSpec) =>
        (async function* () {
          runSpecs.push(spec);
          yield* [];
        })(),
    }) as unknown as HarnessAdapter;

  // Sol wave-4 P1/P2 counterexamples: the gate used to concretize the admitted
  // route into `subscription`/`api_key`. For a non-Cursor adapter that queried
  // a different inventory than its own spawn would use, and for Cursor it
  // silenced the `auth_switched/readiness_preferred` disclosure, which the
  // adapter emits ONLY while the received preference is still `auto`.
  it.each(["cursor", "generic"])(
    "%s: the inventory is asked with auto and the spawned spec is byte-identical",
    async (id) => {
      const modelSpecs: unknown[] = [];
      const runSpecs: HarnessRunSpec[] = [];
      const routed: ModelGovernedRoute = {
        adapter: autoAdapter(id, modelSpecs, runSpecs),
        knownModels: [],
        authRouteEstimate: id === "cursor" ? "local_session" : null,
        quotaAdmission: { profile: null },
        settings: null,
      };
      const spec = HarnessRunSpec.parse({
        session_id: `ses-auto-${id}`,
        intent: "audit",
        prompt: "review",
        cwd: "/repo",
        env: { HOME: "/state" },
        auth_preference: "auto",
        model_hint: "bound-model",
      });

      for await (const _event of runModelGovernedRoute(routed, spec)) {
        // The adapter emits no events in this contract test.
      }

      expect(modelSpecs).toEqual([
        { cwd: "/repo", env: { HOME: "/state" }, authPreference: "auto" },
      ]);
      expect(runSpecs).toEqual([spec]);
      expect(runSpecs[0]?.auth_preference).toBe("auto");
    },
  );

  it("an undecidable admission route no longer refuses a profile-less auto run", async () => {
    const modelSpecs: unknown[] = [];
    const runSpecs: HarnessRunSpec[] = [];
    const routed: ModelGovernedRoute = {
      adapter: autoAdapter("cursor", modelSpecs, runSpecs),
      knownModels: [],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: null,
    };
    const spec = HarnessRunSpec.parse({
      session_id: "ses-undecidable-route",
      intent: "audit",
      prompt: "review",
      cwd: "/repo",
      auth_preference: "auto",
      model_hint: "bound-model",
    });

    for await (const _event of runModelGovernedRoute(routed, spec)) {
      // The vendor, not this gate, is the authority on an `auto` route.
    }

    expect(runSpecs).toEqual([spec]);
  });

  it("the early gate leaves a non-Cursor automatic route alone as well", async () => {
    const seen: unknown[] = [];
    const routed: ModelGovernedRoute = {
      adapter: {
        id: "generic",
        models: async (spec: unknown) => {
          seen.push(spec);
          return [{ id: "generic-model", label: "Generic" }];
        },
      } as unknown as HarnessAdapter,
      knownModels: [],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: { defaultModel: "generic-model", fallbackModel: null },
    };

    await assertRouteModelsAllowed([routed], undefined, "/repo");

    expect(seen).toEqual([{ cwd: "/repo" }]);
  });
});
