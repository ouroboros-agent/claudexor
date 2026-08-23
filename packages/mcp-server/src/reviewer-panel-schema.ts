import { effortJsonSchema } from "@claudexor/schema";

export const reviewerPanelEntrySchema = {
  harness: { type: "string", minLength: 1 },
  model: { type: "string", minLength: 1 },
  effort: effortJsonSchema("Effort for this reviewer entry."),
  credentialProfileId: {
    type: "string",
    minLength: 1,
    description: "Optional strict credential profile id; absent uses the canonical account pool.",
  },
};
