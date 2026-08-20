import { z } from "zod/v3";

export const RunExecution = z
  .object({
    isolation: z
      .enum(["envelope", "live"])
      .default("envelope")
      .describe(
        "Run isolation: envelope (isolated worktree in the external per-project runtime namespace, the default) or live (the project tree itself).",
      ),
    delegated: z
      .boolean()
      .default(false)
      .describe(
        "Marks a run driven by an EXTERNAL orchestrator that owns the workspace, not by the operator at a surface. Such a run uses a scoped harness HOME even under isolation='live' (an in-place delegated attempt therefore cannot resume a native vendor session stored under the real HOME). Unrelated to the `delegate` belt flag and to `delegatedFromRunId` (belt-child provenance).",
      ),
    workspaceRoot: z
      .string()
      .optional()
      .describe(
        "Absolute existing execution workspace for a project-scoped delegated agent live run. The stable project identity remains scope.root.",
      ),
  })
  .strict()
  .describe("Execution isolation and delegation settings for a run.");
export type RunExecution = z.infer<typeof RunExecution>;
