import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import type { PollAccountResult, PolledWindow } from "../poll.ts";
import {
  clampPercent,
  envValue,
  homeDir,
  httpFailure,
  isOk,
  NumberLike,
  requestJson,
  storePolledAccount,
  toEpochSeconds,
  type QuotaPollContext,
} from "./shared.ts";

const KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
/** Treat CLI tokens as stale a minute early, like the CLI itself. */
const TOKEN_SAFETY_MS = 60_000;

const PLAN_NAMES: Record<string, string> = {
  LEVEL_FREE: "Adagio",
  LEVEL_TRIAL: "Andante",
  LEVEL_BASIC: "Moderato",
  LEVEL_INTERMEDIATE: "Allegretto",
  LEVEL_ADVANCED: "Allegro",
};

const RatioPoolSchema = z.object({
  used_ratio: z.number().nullish(),
  reset_time: z.string().nullish(),
}).nullish();

const CountDetailSchema = z.object({
  limit: NumberLike,
  used: NumberLike.nullish(),
  remaining: NumberLike.nullish(),
  resetTime: z.union([z.string(), z.number()]).nullish(),
  resetAt: z.union([z.string(), z.number()]).nullish(),
  reset_time: z.union([z.string(), z.number()]).nullish(),
  reset_at: z.union([z.string(), z.number()]).nullish(),
});

const TIME_UNIT_MINUTES: Record<string, number> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 1440,
};

const KimiUsageSchema = z.object({
  usages: z.object({
    limit_5h: RatioPoolSchema,
    limit_7d: RatioPoolSchema,
    limit_month_total: RatioPoolSchema,
  }).nullish(),
  usage: CountDetailSchema.nullish().catch(undefined),
  limits: z.array(z.object({
    window: z.object({ duration: NumberLike, timeUnit: z.string() }),
    detail: CountDetailSchema,
  }).optional().catch(undefined)).nullish(),
  user: z.object({ membership: z.object({ level: z.string().nullish() }).nullish() }).nullish().catch(undefined),
});

const ratioWindow = (input: { pool: z.infer<typeof RatioPoolSchema>; minutes: number }): PolledWindow | undefined => {
  const ratio = input.pool?.used_ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) return undefined;
  return {
    windowMinutes: input.minutes,
    usedPct: clampPercent(Math.min(1, ratio) * 100),
    resetsAtEpoch: toEpochSeconds(input.pool?.reset_time),
  };
};

const countWindow = (input: { detail: z.infer<typeof CountDetailSchema> | null | undefined; minutes: number }): PolledWindow | undefined => {
  const detail = input.detail;
  if (detail === null || detail === undefined || detail.limit <= 0) return undefined;
  const remaining = detail.remaining ?? undefined;
  const used = detail.used !== null && detail.used !== undefined && detail.used >= 0
    ? detail.used
    : remaining !== undefined && remaining >= 0 && remaining <= detail.limit ? detail.limit - remaining : undefined;
  if (used === undefined) return undefined;
  return {
    windowMinutes: input.minutes,
    usedPct: clampPercent((used / detail.limit) * 100),
    resetsAtEpoch: toEpochSeconds(detail.resetTime ?? detail.resetAt ?? detail.reset_time ?? detail.reset_at),
  };
};

export interface KimiUsage {
  windows: PolledWindow[];
  plan?: string;
}

/** /coding/v1/usages body → 5h, weekly, and monthly windows (ratio pools first, legacy counts as fallback). */
export const parseKimiUsage = (body: unknown): KimiUsage | undefined => {
  const parsed = KimiUsageSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const usage = parsed.data;
  const rateLimit = (usage.limits ?? []).find((entry) => entry !== undefined);
  const rateLimitMinutes = rateLimit !== undefined
    ? (TIME_UNIT_MINUTES[rateLimit.window.timeUnit] ?? 0) * rateLimit.window.duration
    : 0;
  const session = ratioWindow({ pool: usage.usages?.limit_5h, minutes: 300 })
    ?? countWindow({ detail: rateLimit?.detail, minutes: rateLimitMinutes > 0 ? rateLimitMinutes : 300 });
  const weekly = ratioWindow({ pool: usage.usages?.limit_7d, minutes: 10_080 })
    ?? countWindow({ detail: usage.usage, minutes: 10_080 });
  const monthly = ratioWindow({ pool: usage.usages?.limit_month_total, minutes: 43_200 });
  const level = usage.user?.membership?.level?.trim();
  const plan = level === undefined || level.length === 0 || level === "LEVEL_UNSPECIFIED"
    ? undefined
    : PLAN_NAMES[level] ?? level;
  return {
    windows: [session, weekly, monthly].filter((window) => window !== undefined),
    ...(plan !== undefined ? { plan } : {}),
  };
};

const KimiCliCredentialSchema = z.object({
  access_token: z.string().min(1),
  expires_at: NumberLike.nullish(),
});

export type KimiCredential =
  | { kind: "api-key"; key: string }
  | { kind: "cli"; accessToken: string; expiresAtMs?: number; home: string };

const kimiHomes = (input: { ctx: QuotaPollContext; kimiHome?: string }): string[] => {
  if (input.kimiHome !== undefined) return [input.kimiHome];
  const override = envValue({ env: input.ctx.env, names: ["KIMI_CODE_HOME"] });
  const home = homeDir(input.ctx.env);
  return override !== undefined ? [override] : [path.join(home, ".kimi-code"), path.join(home, ".kimi")];
};

/** API key first, then the Kimi Code CLI's own login (read-only; never refreshed here). */
export const kimiCredential = (input: { ctx: QuotaPollContext; configKey?: string; kimiHome?: string }): KimiCredential | undefined => {
  const key = input.configKey ?? envValue({ env: input.ctx.env, names: ["KIMI_CODE_API_KEY"] });
  if (key !== undefined) return { kind: "api-key", key };
  for (const home of kimiHomes(input)) {
    try {
      const parsed = KimiCliCredentialSchema.safeParse(
        JSON.parse(fs.readFileSync(path.join(home, "credentials", "kimi-code.json"), "utf8")),
      );
      if (!parsed.success) continue;
      const expiresAt = parsed.data.expires_at ?? undefined;
      return {
        kind: "cli",
        accessToken: parsed.data.access_token,
        home,
        ...(expiresAt !== undefined ? { expiresAtMs: expiresAt > 1e12 ? expiresAt : expiresAt * 1000 } : {}),
      };
    } catch {
      // try the next CLI home
    }
  }
  return undefined;
};

const asciiHeader = (value: string): string => {
  const ascii = value.replace(/[^\x20-\x7e]/g, "").trim();
  return ascii.length > 0 ? ascii : "unknown";
};

/** Identity headers the Kimi Code CLI sends; the device id is reused only when the CLI already created it. */
const cliHeaders = (home: string): Record<string, string> => {
  let deviceId: string | undefined;
  try {
    deviceId = fs.readFileSync(path.join(home, "device_id"), "utf8").trim() || undefined;
  } catch {
    deviceId = undefined;
  }
  const osName = process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform;
  return {
    "x-msh-platform": "kimi_code_cli",
    "x-msh-version": "tokitoki",
    "x-msh-device-name": asciiHeader(os.hostname()),
    "x-msh-device-model": asciiHeader(`${osName} ${os.release()} ${os.arch()}`),
    "x-msh-os-version": asciiHeader(os.release()),
    ...(deviceId !== undefined ? { "x-msh-device-id": asciiHeader(deviceId) } : {}),
  };
};

export const pollKimiQuotas = async (input: { ctx: QuotaPollContext; credential: KimiCredential }): Promise<PollAccountResult | string> => {
  const credential = input.credential;
  if (credential.kind === "cli" && credential.expiresAtMs !== undefined && credential.expiresAtMs <= input.ctx.now + TOKEN_SAFETY_MS) {
    return "kimi CLI token expired; run kimi to renew";
  }
  const token = credential.kind === "api-key" ? credential.key : credential.accessToken;
  const response = await requestJson({
    fetcher: input.ctx.fetcher,
    url: KIMI_USAGES_URL,
    init: {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": "tokitoki",
        ...(credential.kind === "cli" ? cliHeaders(credential.home) : {}),
      },
    },
  });
  if (!isOk(response)) {
    const reason = httpFailure({ label: "usages endpoint", response });
    return credential.kind === "cli" && (response.status === 401 || response.status === 403)
      ? `kimi CLI token rejected (${reason}); run kimi to renew`
      : reason;
  }
  const usage = parseKimiUsage(response.body);
  if (usage === undefined) return "usages response shape unrecognized";
  const result: PollAccountResult = {
    accountKey: "default",
    harnesses: ["kimi"],
    ...(usage.plan !== undefined ? { planType: usage.plan } : {}),
    windows: usage.windows,
    inserted: 0,
  };
  if (usage.windows.length === 0) return { ...result, error: "no usable windows in response" };
  result.inserted = storePolledAccount({
    ctx: input.ctx,
    provider: "kimi",
    accountKey: "default",
    windows: usage.windows,
    meta: usage.plan !== undefined ? { plan: usage.plan } : {},
  });
  return result;
};
