import { z } from "zod";

import type { AccountBalance } from "../quota-windows.ts";
import { isOk, NumberLike, requestJson } from "./shared.ts";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

const OpenRouterCreditsSchema = z.object({
  data: z.object({ total_credits: NumberLike, total_usage: NumberLike }),
});

/** /api/v1/credits body → USD balance (remaining = total_credits − total_usage). */
export const parseOpenRouterCredits = (body: unknown): AccountBalance | undefined => {
  const parsed = OpenRouterCreditsSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const total = parsed.data.data.total_credits;
  const used = parsed.data.data.total_usage;
  return { currency: "USD", remaining: Math.round((total - used) * 1e6) / 1e6, total, used };
};

/** Best-effort: a rejected credits request leaves the balance unknown, never zero. */
export const fetchOpenRouterCredits = async (input: { key: string; fetcher: typeof fetch }): Promise<AccountBalance | undefined> => {
  const response = await requestJson({
    fetcher: input.fetcher,
    url: OPENROUTER_CREDITS_URL,
    init: { headers: { authorization: `Bearer ${input.key}`, accept: "application/json" } },
  });
  return isOk(response) ? parseOpenRouterCredits(response.body) : undefined;
};
