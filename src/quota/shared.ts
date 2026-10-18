import os from "node:os";

import { z } from "zod";

import type { EventCache } from "../cache.ts";
import type { PolledWindow } from "../poll.ts";
import type { QuotaAccountMeta } from "../quota-windows.ts";

export type PollEnv = Record<string, string | undefined>;

export interface QuotaPollContext {
  fetcher: typeof fetch;
  cache: EventCache | undefined;
  now: number;
  env: PollEnv;
}

export interface JsonResponse {
  status: number;
  body: unknown;
  retryAfter: string | null;
  error?: string;
}

export const homeDir = (env: PollEnv): string => env.HOME ?? os.homedir();

export const envValue = (input: { env: PollEnv; names: string[] }): string | undefined =>
  input.names.map((name) => input.env[name]?.trim()).find((value) => value !== undefined && value.length > 0);

export const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

/** ISO string, epoch seconds, or epoch milliseconds → epoch seconds (0 when unknown). */
export const toEpochSeconds = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value > 1e12 ? value / 1000 : value);
  }
  if (typeof value !== "string" || value.trim().length === 0) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return toEpochSeconds(Number(value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : 0;
};

/** Numbers that providers sometimes send as strings. */
export const NumberLike = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (typeof value === "string" && value.trim().length === 0) {
    ctx.addIssue({ code: "custom", message: "empty number" });
    return z.NEVER;
  }
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: "custom", message: "not a number" });
    return z.NEVER;
  }
  return parsed;
});

export const requestJson = async (input: { fetcher: typeof fetch; url: string; init?: RequestInit }): Promise<JsonResponse> => {
  try {
    const res = await input.fetcher(input.url, input.init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body: the status carries the signal
    }
    return { status: res.status, body, retryAfter: res.headers.get("retry-after") };
  } catch (error) {
    return { status: 0, body: null, retryAfter: null, error: String(error) };
  }
};

export const isOk = (response: JsonResponse): boolean => response.status >= 200 && response.status < 300;

/** Failure reason; 429s carry "(retry after Ns)" so nextPollState honours Retry-After. */
export const httpFailure = (input: { label: string; response: JsonResponse }): string => {
  const response = input.response;
  if (response.status === 0) return `${input.label} request failed (network): ${response.error ?? "unknown error"}`;
  if (response.status === 429) {
    const seconds = Number(response.retryAfter);
    return `${input.label} returned HTTP 429${Number.isFinite(seconds) && seconds > 0 ? ` (retry after ${Math.round(seconds)}s)` : ""}`;
  }
  return `${input.label} returned HTTP ${response.status}`;
};

export const decodeJwtClaims = (jwt: string): Record<string, unknown> | undefined => {
  const payload = jwt.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const BALANCE_ACCOUNTS_KEY = "quota-balance-accounts";

const BalanceAccountsSchema = z.array(z.object({ provider: z.string(), accountKey: z.string() }));

export type BalanceAccount = z.infer<typeof BalanceAccountsSchema>[number];

/** Accounts whose poller reported a balance; balance-only accounts have no snapshot rows to discover them by. */
export const balanceAccounts = (cache: EventCache): BalanceAccount[] => {
  const raw = cache.metaValue(BALANCE_ACCOUNTS_KEY);
  if (raw === undefined) return [];
  try {
    const parsed = BalanceAccountsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

export const storeAccountMeta = (input: {
  cache: EventCache | undefined;
  provider: string;
  accountKey: string;
  meta: QuotaAccountMeta;
}): void => {
  const cache = input.cache;
  if (cache === undefined) return;
  cache.setQuotaAccountMeta(input.provider, input.accountKey, input.meta);
  if (input.meta.balance === undefined) return;
  const known = balanceAccounts(cache);
  if (known.some((entry) => entry.provider === input.provider && entry.accountKey === input.accountKey)) return;
  cache.setMetaValue(BALANCE_ACCOUNTS_KEY, JSON.stringify([...known, { provider: input.provider, accountKey: input.accountKey }]));
};

/** Persist account meta and windows for one polled account; returns inserted snapshot rows. */
export const storePolledAccount = (input: {
  ctx: QuotaPollContext;
  provider: string;
  accountKey: string;
  windows: PolledWindow[];
  meta: QuotaAccountMeta;
}): number => {
  storeAccountMeta({ cache: input.ctx.cache, provider: input.provider, accountKey: input.accountKey, meta: input.meta });
  if (input.ctx.cache === undefined || input.windows.length === 0) return 0;
  const capturedAtIso = new Date(input.ctx.now).toISOString();
  return input.ctx.cache.insertPolledSnapshots({
    provider: input.provider,
    accountKey: input.accountKey,
    windows: input.windows,
    capturedAtIso,
    eventId: `poll:${capturedAtIso}:${input.provider}`,
  });
};
