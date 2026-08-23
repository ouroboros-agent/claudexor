import { formatRunResult } from "./run-result-format.js";
import type { McpTool, RunnerFn } from "./index.js";

export function accountsTool(runner: RunnerFn, outputSchema: Record<string, unknown>): McpTool {
  return {
    name: "claudexor_accounts",
    description:
      "Return the read-only atomic Accounts snapshot: registered profiles, readiness, quota freshness, next-up routing identity, and profile-safe model/account evidence. This tool never starts login or changes account state.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema,
    annotations: { readOnlyHint: true },
    handler: async () => {
      const result = await runner({ mode: "__accounts" });
      return {
        text: formatRunResult(result),
        structured: (result && typeof result === "object" ? result : {}) as Record<string, unknown>,
      };
    },
  };
}
