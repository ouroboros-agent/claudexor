import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  type CredentialProfile,
  type KnownModelEntry,
  type ProviderFamily,
} from "@claudexor/schema";
import { resolveAutoReviewerPanel, resolveExplicitReviewerPanel } from "./reviewerPanel.js";

/**
 * The reviewer effort gate. `reviewerEfforts` and `reviewerPanel[].effort` are
 * OPEN slugs on the wire (a level only means something per harness+model), so the
 * boundary can only refuse a malformed shape. These pin the layer that refuses an
 * unsupported LEVEL: without it an unadvertised effort is dropped by the adapter's
 * normalizer while the review artifact still records it as requested.
 */
function reviewerAdapter(
  id: string,
  family: ProviderFamily,
  effortLevels: readonly string[],
  extras: {
    modelEffortLevels?: Record<string, { levels: string[]; default: string | null }>;
    knownModels?: string[];
    knownModelEntries?: KnownModelEntry[];
  } = {},
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        access_profiles_supported: ["readonly", "workspace_write"],
        capabilities: {
          review: true,
          effort_levels: [...effortLevels],
          ...(extras.modelEffortLevels ? { model_effort_levels: extras.modelEffortLevels } : {}),
          ...(extras.knownModelEntries
            ? { known_models: extras.knownModelEntries }
            : extras.knownModels
              ? { known_models: extras.knownModels }
              : {}),
        },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    // eslint-disable-next-line require-yield
    async *run() {
      throw new Error("not used in panel resolution");
    },
  };
}

const deps = (adapters: HarnessAdapter[]) => ({
  cwd: mkdtempSync(join(tmpdir(), "clawdexor-panel-")),
  registry: new Map(adapters.map((a) => [a.id, a])),
  harnessSettings: {},
  authPreferenceFor: () => "auto" as const,
});

describe("reviewer effort gate", () => {
  const claude = () => reviewerAdapter("claude", "anthropic", ["low", "medium", "high", "max"]);
  const cursor = () => reviewerAdapter("cursor", "cursor", ["low", "medium", "high"]);

  it("DROPS-AND-DISCLOSES a legacy reviewerEfforts level the auto reviewer does not advertise", async () => {
    // The per-family `reviewerEfforts` map also rides stored replay surfaces
    // (Exact Retry params, ControlRunAgainDraft.request), and a replay is not
    // distinguishable from a fresh request at this layer — so an unadvertised
    // level is dropped WITH disclosure instead of a typed refusal killing a
    // replay that used to run. The panel still reviews, at the reviewer's
    // default effort; the review artifact no longer records the level as
    // requested (requestedEffort is nulled), so nothing reads as honored.
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      { ...deps([claude()]), onIgnoredSetting: (d) => ignored.push(d) },
      { reviewerEfforts: { anthropic: "banana" } },
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBeNull();
    expect(ignored).toEqual([
      expect.stringMatching(
        /reviewer effort dropped:.*does not support requested effort 'banana'.*low, medium, high, max/,
      ),
    ]);
  });

  it("drops (not forwards) a well-known vendor level this reviewer's ladder does not advertise", async () => {
    // `ultra` is real elsewhere (codex sol models), just not on this reviewer's
    // advertised ladder. It must not travel inward to die natively — and the
    // drop must still resolve a working panel even with NO disclosure sink wired.
    const specs = await resolveAutoReviewerPanel(deps([claude()]), {
      reviewerEfforts: { anthropic: "ultra" },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBeNull();
  });

  it("accepts a legacy reviewer effort the reviewer advertises", async () => {
    const specs = await resolveAutoReviewerPanel(deps([claude()]), {
      reviewerEfforts: { anthropic: "max" },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBe("max");
  });

  it("leaves the reviewer effort unset when no override was given", async () => {
    const specs = await resolveAutoReviewerPanel(deps([claude()]), {});
    expect(specs[0]?.requestedEffort).toBeNull();
  });

  it("discloses an unknown model inventory and continues to the next family", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["high"]);
    cursor.models = async () => {
      throw new Error("provider transport failed");
    };
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([cursor, claude()]),
        harnessSettings: { cursor: { default_model: "grok-4.6" } },
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]?.adapter.id).toBe("claude");
    expect(ignored).toEqual([
      expect.stringMatching(/reviewer family 'cursor' skipped: inventory unavailable/),
    ]);
  });

  it("does not turn an empty fail-soft inventory into a model mismatch", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["high"]);
    cursor.models = async () => [];
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([cursor]),
        harnessSettings: { cursor: { default_model: "grok-4.6" } },
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toEqual([]);
    expect(ignored).toEqual(["reviewer family 'cursor' skipped: inventory unavailable"]);
  });

  it("discloses an automatic model mismatch instead of failing the run", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["high"]);
    cursor.models = async () => [
      { id: "other-model", label: null, context_window: null, routes: null },
    ];
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([cursor]),
        harnessSettings: { cursor: { default_model: "grok-4.6" } },
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toEqual([]);
    expect(ignored).toEqual([expect.stringMatching(/requested model 'grok-4.6' is unavailable/)]);
  });

  it("refuses an explicit reviewerPanel effort the reviewer does not advertise", async () => {
    // Explicit panel entries are precise owner statements — they keep the
    // HARD typed refusal (only the auto map above dropped to disclosure).
    await expect(
      resolveExplicitReviewerPanel(deps([cursor()]), [{ harness: "cursor", effort: "turbo" }]),
    ).rejects.toThrow(HarnessUnavailableError);
    await expect(
      resolveExplicitReviewerPanel(deps([cursor()]), [{ harness: "cursor", effort: "turbo" }]),
    ).rejects.toThrow(
      /does not support requested effort 'turbo'.*harness-wide advertised ladder.*low, medium, high/,
    );
  });

  it("accepts an explicit reviewerPanel effort the reviewer advertises", async () => {
    const specs = await resolveExplicitReviewerPanel(deps([cursor()]), [
      { harness: "cursor", effort: "high" },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBe("high");
  });

  it("refuses any reviewer effort when the harness declares no effort controls", async () => {
    const bare = reviewerAdapter("bare", "openai", []);
    await expect(
      resolveExplicitReviewerPanel(deps([bare]), [{ harness: "bare", effort: "high" }]),
    ).rejects.toThrow(/harness declares no effort controls/);
  });

  it("validates a MODEL-naming entry against THAT model's advertised ladder, not the union", async () => {
    // The union carries `ultra` (a sibling model advertises it); the named
    // reviewer model stops at `high`. The gate must speak for the model that
    // will actually review.
    const codexish = () =>
      reviewerAdapter("codexish", "openai", ["low", "medium", "high", "ultra"], {
        knownModels: ["m-small", "m-big"],
        modelEffortLevels: {
          "m-small": { levels: ["low", "medium", "high"], default: "medium" },
          "m-big": { levels: ["low", "medium", "high", "ultra"], default: "low" },
        },
      });
    await expect(
      resolveExplicitReviewerPanel(deps([codexish()]), [
        { harness: "codexish", model: "m-small", effort: "ultra" },
      ]),
    ).rejects.toThrow(
      /does not support requested effort 'ultra'.*model 'm-small' advertises: low, medium, high/,
    );
    // The SAME level on the model that advertises it passes.
    const specs = await resolveExplicitReviewerPanel(deps([codexish()]), [
      { harness: "codexish", model: "m-big", effort: "ultra" },
    ]);
    expect(specs[0]?.requestedEffort).toBe("ultra");
  });

  it("falls back to the harness ladder (and says so) for a model with no recorded ladder", async () => {
    const codexish = () =>
      reviewerAdapter("codexish", "openai", ["low", "medium", "high"], {
        knownModels: ["m-new"],
      });
    await expect(
      resolveExplicitReviewerPanel(deps([codexish()]), [
        { harness: "codexish", model: "m-new", effort: "ultra" },
      ]),
    ).rejects.toThrow(/harness-wide advertised ladder — no per-model ladder recorded for 'm-new'/);
  });

  it("carries an explicit credential profile through model inventory into the reviewer spec", async () => {
    const profile: CredentialProfile = {
      profile_id: "review-a",
      harness_id: "cursor",
      display_name: "Review A",
      credential_kind: "config_dir_login",
      isolation_locator: "/tmp/cursor-review-a",
      secret_ref: null,
      enabled: true,
      created_at: null,
    };
    let seen: CredentialProfile | null | undefined;
    const adapter = reviewerAdapter("cursor", "cursor", ["low", "high"], {
      knownModels: ["grok-4.6"],
    });
    adapter.models = async (spec) => {
      seen = spec?.credentialProfile;
      return [{ id: "grok-4.6", label: null, context_window: null, routes: null }];
    };
    const specs = await resolveExplicitReviewerPanel(
      {
        ...deps([adapter]),
        resolveReviewerProfile: async () => profile,
      },
      [{ harness: "cursor", model: "grok-4.6", credentialProfileId: "review-a" }],
    );
    expect(seen?.profile_id).toBe("review-a");
    expect(specs[0]?.credentialProfile?.profile_id).toBe("review-a");
  });

  it("continues the canonical pool when an unpinned selected profile lacks the model", async () => {
    const first: CredentialProfile = {
      profile_id: "review-first",
      harness_id: "cursor",
      display_name: "Review first",
      credential_kind: "config_dir_login",
      isolation_locator: "/tmp/cursor-review-first",
      secret_ref: null,
      enabled: true,
      created_at: null,
    };
    const second: CredentialProfile = {
      ...first,
      profile_id: "review-second",
      display_name: "Review second",
      isolation_locator: "/tmp/cursor-review-second",
    };
    const adapter = reviewerAdapter("cursor", "cursor", ["low"], {
      knownModels: ["target-model"],
    });
    const inventoryCalls: string[] = [];
    adapter.models = async (spec) => {
      const id = spec?.credentialProfile?.profile_id ?? "default";
      inventoryCalls.push(id);
      return id === first.profile_id
        ? [{ id: "other-model", label: null, context_window: null, routes: null }]
        : [{ id: "target-model", label: null, context_window: null, routes: null }];
    };
    const resolverCalls: ReadonlySet<string>[] = [];
    const specs = await resolveExplicitReviewerPanel(
      {
        ...deps([adapter]),
        resolveReviewerProfile: async (input) => {
          resolverCalls.push(input.excludedProfileIds ?? new Set());
          return input.excludedProfileIds?.has(first.profile_id) ? second : first;
        },
      },
      [{ harness: "cursor", model: "target-model" }],
    );
    expect(specs[0]?.credentialProfile?.profile_id).toBe(second.profile_id);
    expect(inventoryCalls).toEqual([first.profile_id, second.profile_id]);
    expect([...(resolverCalls[1] ?? [])]).toEqual([first.profile_id]);
  });

  it("uses the local-session manifest route for OAuth profiles", async () => {
    const oauth: CredentialProfile = {
      profile_id: "claude-oauth",
      harness_id: "claude",
      display_name: "Claude OAuth",
      credential_kind: "oauth_token",
      isolation_locator: "/tmp/claude-oauth",
      secret_ref: "claude:oauth",
      enabled: true,
      created_at: null,
    };
    const adapter = reviewerAdapter("claude", "anthropic", ["high"], {
      knownModelEntries: [{ id: "subscription-model", routes: ["local_session"] }],
    });
    const specs = await resolveExplicitReviewerPanel(
      {
        ...deps([adapter]),
        resolveReviewerProfile: async () => oauth,
      },
      [{ harness: "claude", model: "subscription-model" }],
    );
    expect(specs[0]?.credentialProfile?.credential_kind).toBe("oauth_token");
  });

  it("fails an explicit pin loudly and discloses an unavailable auto family", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["low"]);
    const error = new HarnessUnavailableError("profile unavailable");
    await expect(
      resolveExplicitReviewerPanel(
        { ...deps([cursor]), resolveReviewerProfile: async () => Promise.reject(error) },
        [{ harness: "cursor", credentialProfileId: "missing" }],
      ),
    ).rejects.toBe(error);
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([cursor]),
        resolveReviewerProfile: async () => Promise.reject(error),
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toEqual([]);
    expect(ignored).toEqual(["reviewer family 'cursor' skipped: profile unavailable"]);
  });

  it("does not silently drop an explicit pin when the account-pool owner is not wired", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["low"]);
    await expect(
      resolveExplicitReviewerPanel(deps([cursor]), [
        { harness: "cursor", credentialProfileId: "missing" },
      ]),
    ).rejects.toThrow(/account-pool owner is unavailable/);
  });

  it("refuses an explicit pin when the account-pool owner returns no identity", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["low"]);
    await expect(
      resolveExplicitReviewerPanel(
        { ...deps([cursor]), resolveReviewerProfile: async () => null },
        [{ harness: "cursor", credentialProfileId: "missing" }],
      ),
    ).rejects.toThrow(/could not be resolved/);
  });
});
