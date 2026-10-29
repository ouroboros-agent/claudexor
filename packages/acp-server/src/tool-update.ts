import { commandOutcomeLabel, commandOutcomeUnconfirmed } from "@claudexor/schema";

/**
 * The ACP `tool_call_update` for one normalized tool result. ACP v1 has two
 * terminal tool statuses: `completed` ("completed successfully") and `failed`.
 * A command still running in a background shell, timed out, or in an unknown
 * state did not complete successfully, and no later frame will arrive for its
 * call, so it closes as `failed`, with the typed state as the call's text
 * content and `_meta.claudexor.commandOutcome` (#450). `in_progress` would
 * leave the client waiting for an update that never comes.
 */
export function toolResultUpdate(toolCallId: string, tool: Record<string, unknown>) {
  const outcome = tool["command_outcome"];
  const label = commandOutcomeLabel(outcome);
  return {
    sessionUpdate: "tool_call_update" as const,
    toolCallId,
    status:
      tool["status"] === "error" || commandOutcomeUnconfirmed(outcome)
        ? ("failed" as const)
        : ("completed" as const),
    ...(label
      ? {
          content: [{ type: "content" as const, content: { type: "text" as const, text: label } }],
          _meta: { claudexor: { commandOutcome: outcome } },
        }
      : {}),
  };
}
