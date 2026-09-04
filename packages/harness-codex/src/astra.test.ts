import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateModel } from "@claudexor/core";
import { HarnessRunSpec, knownModelIdsForRoute, type HarnessEvent } from "@claudexor/schema";
import { CODEX_VENDOR_CLI_VERSION, clearCodexEffortCache, createCodexAdapter } from "./index.js";
import { readModelListEfforts } from "./effort-probe.js";

const captured = JSON.parse(
  readFileSync(new URL("../fixtures/models-0.153.3.json", import.meta.url), "utf8"),
) as { data: unknown[] };
const capturedCatalog = readModelListEfforts(captured.data);

beforeEach(() => {
  clearCodexEffortCache();
  for (const kind of ["INPUT", "OUTPUT", "CACHED"])
    vi.stubEnv(`CLAUDEXOR_CODEX_PRICE_${kind}`, undefined);
});
afterEach(() => {
  clearCodexEffortCache();
  vi.unstubAllEnvs();
});

describe("GPT-6 Astra on the pinned Codex CLI", () => {
  it.each(["live", "snapshot"] as const)(
    "admits Astra and sends ultra unchanged with the %s catalog",
    async (source) => {
      expect(CODEX_VENDOR_CLI_VERSION).toBe("0.153.3");
      expect(capturedCatalog).not.toBeNull();
      let cliArgs: string[] | undefined;
      const adapter = createCodexAdapter({
        detectVersion: async () => `codex-cli ${CODEX_VENDOR_CLI_VERSION}`,
        probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
        hasApiKey: () => false,
        probeEfforts: async () => (source === "live" ? capturedCatalog : null),
        runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
          cliArgs = options.args;
          yield* options.parseEvent?.(
            { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 10 } },
            options.spec.session_id,
          ) ?? [];
          yield {
            type: "completed",
            session_id: options.spec.session_id,
            ts: "2026-09-05T00:00:00.000Z",
          };
        },
      });
      const manifest = await adapter.discover();
      const known = knownModelIdsForRoute(manifest.capabilities.known_models, "local_session");
      expect(validateModel("gpt-6-astra", known, "manifest").status).toBe("ok");
      expect(manifest.capabilities.model_effort_levels["gpt-6-astra"]).toEqual({
        levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default: "medium",
      });
      for (const hidden of ["gpt-reserve", "codex-auto-review"])
        expect(validateModel(hidden, known, "manifest").status).toBe("rejected");

      const spec = HarnessRunSpec.parse({
        session_id: `astra-${source}`,
        intent: "explain",
        prompt: "Return the requested short answer.",
        cwd: "/repo",
        access: "readonly",
        model_hint: "gpt-6-astra",
        effort_hint: "ultra",
        auth_preference: "subscription",
      });
      const events: HarnessEvent[] = [];
      for await (const event of adapter.run(spec)) events.push(event);
      expect(cliArgs).toBeDefined();
      expect(cliArgs![cliArgs!.indexOf("-m") + 1]).toBe("gpt-6-astra");
      expect(cliArgs).toContain('model_reasoning_effort="ultra"');
      expect(events.some((event) => event.type === "error")).toBe(false);
      const usage = events.find((event) => event.type === "usage")?.usage;
      expect(usage?.input_tokens).toBe(1000);
      expect(usage?.cost_usd).toBeUndefined();
      expect(usage?.estimated).toBeUndefined();
      expect(
        events.find((event) => Array.isArray(event.payload?.["ignored_settings"])),
      ).toBeUndefined();
    },
  );
});
