import { z } from "zod";

import type { PollAccountResult, PolledWindow } from "../poll.ts";
import {
  clampPercent,
  envValue,
  httpFailure,
  isOk,
  requestJson,
  storePolledAccount,
  toEpochSeconds,
  type QuotaPollContext,
} from "./shared.ts";

export type ZaiRegion = "global" | "bigmodel-cn";

const ZAI_HOSTS: Record<ZaiRegion, string> = {
  global: "https://api.z.ai",
  "bigmodel-cn": "https://open.bigmodel.cn",
};

/** z.ai unit codes → minutes per unit (1 day, 3 hour, 5 minute, 6 week). */
const UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10_080 };

const ZaiLimitSchema = z.object({
  type: z.enum(["TOKENS_LIMIT", "TIME_LIMIT", "CREDIT_LIMIT"]),
  unit: z.number().int(),
  number: z.number().int(),
  percentage: z.number(),
  usage: z.number().nullish(),
  currentValue: z.number().nullish(),
  remaining: z.number().nullish(),
  nextResetTime: z.number().nullish(),
});

const ZaiQuotaSchema = z.object({
  success: z.boolean(),
  code: z.number(),
  msg: z.string().nullish(),
  data: z.object({
    limits: z.array(z.unknown()),
    planName: z.unknown().optional(),
    plan: z.unknown().optional(),
    plan_type: z.unknown().optional(),
    packageName: z.unknown().optional(),
    level: z.unknown().optional(),
  }).nullish(),
});

const usedPercent = (limit: z.infer<typeof ZaiLimitSchema>): number => {
  const usage = limit.usage ?? undefined;
  if (usage === undefined || usage <= 0) return clampPercent(limit.percentage);
  const current = limit.currentValue ?? undefined;
  const remaining = limit.remaining ?? undefined;
  const used = remaining !== undefined
    ? Math.max(usage - remaining, current ?? usage - remaining)
    : current;
  if (used === undefined) return clampPercent(limit.percentage);
  return clampPercent((Math.max(0, Math.min(usage, used)) / usage) * 100);
};

const toWindow = (input: { limit: z.infer<typeof ZaiLimitSchema>; now: number }): PolledWindow | undefined => {
  const limit = input.limit;
  const perUnit = UNIT_MINUTES[limit.unit];
  const minutes = limit.number > 0 && perUnit !== undefined ? limit.number * perUnit : undefined;
  const isMcp = limit.type === "TIME_LIMIT";
  // TIME_LIMIT with unit 5 / number 1 is z.ai's monthly MCP marker, not a one-minute window.
  const windowMinutes = isMcp && ((limit.unit === 5 && limit.number === 1) || minutes === undefined) ? 43_200 : minutes;
  if (windowMinutes === undefined) return undefined;
  const reset = limit.nextResetTime ?? undefined;
  // A five-hour reset cannot be further away than five hours; never guess a timezone correction.
  const plausible = isMcp || windowMinutes !== 300 || reset === undefined || reset <= input.now + (5 * 3600 + 60) * 1000;
  return {
    windowMinutes,
    usedPct: usedPercent(limit),
    resetsAtEpoch: reset !== undefined && plausible ? toEpochSeconds(reset) : 0,
    ...(isMcp ? { label: "MCP" } : {}),
  };
};

export interface ZaiQuota {
  windows: PolledWindow[];
  plan?: string;
}

/** /api/monitor/usage/quota/limit body → token/credit windows plus the MCP window. */
export const parseZaiQuota = (body: unknown, now: number = Date.now()): ZaiQuota | string => {
  const parsed = ZaiQuotaSchema.safeParse(body);
  if (!parsed.success) return "quota response shape unrecognized";
  const root = parsed.data;
  if (!root.success || root.code !== 200) return `quota API error ${root.code}${root.msg ? `: ${root.msg}` : ""}`;
  if (root.data === null || root.data === undefined) return "quota response has no data";
  const windows = root.data.limits
    .map((raw) => ZaiLimitSchema.safeParse(raw))
    .flatMap((result) => (result.success ? [toWindow({ limit: result.data, now })] : []))
    .filter((window) => window !== undefined)
    .sort((a, b) => a.windowMinutes - b.windowMinutes);
  const data = root.data;
  const plan = [data.planName, data.plan, data.plan_type, data.packageName, data.level]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  return { windows, ...(plan !== undefined ? { plan } : {}) };
};

export const zaiApiKey = (input: { ctx: QuotaPollContext; region: ZaiRegion; configKey?: string }): string | undefined => {
  if (input.configKey !== undefined) return input.configKey;
  const names = input.region === "bigmodel-cn"
    ? ["Z_AI_API_KEY", "ZAI_API_KEY", "BIGMODEL_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"]
    : ["Z_AI_API_KEY", "ZAI_API_KEY"];
  return envValue({ env: input.ctx.env, names });
};

export const pollZaiQuotas = async (input: {
  ctx: QuotaPollContext;
  key: string;
  region: ZaiRegion;
}): Promise<PollAccountResult | string> => {
  const response = await requestJson({
    fetcher: input.ctx.fetcher,
    url: `${ZAI_HOSTS[input.region]}/api/monitor/usage/quota/limit`,
    init: { headers: { authorization: `Bearer ${input.key}`, accept: "application/json" } },
  });
  if (!isOk(response)) return httpFailure({ label: "quota endpoint", response });
  const quota = parseZaiQuota(response.body, input.ctx.now);
  if (typeof quota === "string") return quota;
  const result: PollAccountResult = {
    accountKey: "default",
    harnesses: ["zai"],
    ...(quota.plan !== undefined ? { planType: quota.plan } : {}),
    windows: quota.windows,
    inserted: 0,
  };
  if (quota.windows.length === 0) return { ...result, error: "no usable windows in response" };
  result.inserted = storePolledAccount({
    ctx: input.ctx,
    provider: "zai",
    accountKey: "default",
    windows: quota.windows,
    meta: quota.plan !== undefined ? { plan: quota.plan } : {},
  });
  return result;
};
