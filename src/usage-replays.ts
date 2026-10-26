import { z } from "zod";

export const usageReplaySchema = z.object({
  type: z.literal("usage-replay"),
  eventId: z.string().startsWith("codex:"),
  at: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type UsageReplayDecision = z.infer<typeof usageReplaySchema>;
