import { z } from "zod";

import type { PollAccountResult } from "../poll.ts";
import type { AccountBalance } from "../quota-windows.ts";
import { envValue, httpFailure, isOk, NumberLike, requestJson, storePolledAccount, type QuotaPollContext } from "./shared.ts";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const DeepSeekBalanceSchema = z.object({
  is_available: z.boolean().optional(),
  balance_infos: z.array(z.object({
    currency: z.string(),
    total_balance: NumberLike,
    granted_balance: NumberLike.optional(),
    topped_up_balance: NumberLike.optional(),
  })),
});

/** /user/balance body → the USD balance (or the first listed currency). */
export const parseDeepSeekBalance = (body: unknown): AccountBalance | undefined => {
  const parsed = DeepSeekBalanceSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const infos = parsed.data.balance_infos;
  const info = infos.find((entry) => entry.currency.toUpperCase() === "USD") ?? infos[0];
  if (info === undefined) return undefined;
  return {
    currency: info.currency.toUpperCase(),
    remaining: info.total_balance,
    ...(info.granted_balance !== undefined ? { granted: info.granted_balance } : {}),
    ...(info.topped_up_balance !== undefined ? { paid: info.topped_up_balance } : {}),
    ...(parsed.data.is_available !== undefined ? { available: parsed.data.is_available } : {}),
  };
};

export const deepseekApiKey = (input: { ctx: QuotaPollContext; configKey?: string }): string | undefined =>
  input.configKey ?? envValue({ env: input.ctx.env, names: ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"] });

/** Balance-only account: DeepSeek exposes no rate-limit windows for API keys. */
export const pollDeepSeekQuotas = async (input: { ctx: QuotaPollContext; key: string }): Promise<PollAccountResult | string> => {
  const response = await requestJson({
    fetcher: input.ctx.fetcher,
    url: DEEPSEEK_BALANCE_URL,
    init: { headers: { authorization: `Bearer ${input.key}`, accept: "application/json" } },
  });
  if (!isOk(response)) return httpFailure({ label: "balance endpoint", response });
  const balance = parseDeepSeekBalance(response.body);
  if (balance === undefined) return "balance response shape unrecognized";
  storePolledAccount({ ctx: input.ctx, provider: "deepseek", accountKey: "default", windows: [], meta: { balance } });
  return { accountKey: "default", harnesses: ["deepseek"], windows: [], balance, inserted: 0 };
};
