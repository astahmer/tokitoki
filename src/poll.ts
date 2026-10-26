import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { Database } from "bun:sqlite";
import { z } from "zod";

import { claudeOauthAccount, nativeCodexIdentity } from "./accounts.ts";
import { codexHomes } from "./codex-homes.ts";
import { readNativeCodexAccount, type NativeRateLimits } from "./codex-rpc.ts";
import type { EventCache } from "./cache.ts";
import { cursorIdeDir } from "./providers/cursor.ts";
import { syncCursorDashboardUsage } from "./providers/cursor-dashboard.ts";
import { deepseekApiKey, pollDeepSeekQuotas } from "./quota/deepseek.ts";
import { geminiCredsPath, loadGeminiCreds, pollGeminiQuotas } from "./quota/gemini.ts";
import { kimiCredential, pollKimiQuotas } from "./quota/kimi.ts";
import { fetchOpenRouterCredits } from "./quota/openrouter-credits.ts";
import { storeAccountMeta, type QuotaPollContext } from "./quota/shared.ts";
import { pollZaiQuotas, zaiApiKey, type ZaiRegion } from "./quota/zai.ts";
import type { AccountBalance, AccountExtraUsage } from "./quota-windows.ts";
import { dataDir } from "./store.ts";

/** Opt-in provider quota polling. Codex account reads use the native harness;
 * credentials and refresh remain owned by that harness. No model calls occur. */

/** OpenRouter key metadata: limit/limit_remaining when a credit limit is set. */
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
/** OpenCode Go plan meters — provider-reported percent + reset per window. */
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** Claude Code OAuth usage endpoint + refresh config (openusage ClaudeAuthStore). */
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** GitHub Copilot internal usage endpoint — `token` scheme, not Bearer. */
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
/** Cursor dashboard Connect endpoints. */
const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
/** Command Code billing/usage API (the CLI's own live /usage data source). */
const COMMANDCODE_API_URL = "https://api.commandcode.ai";
const USER_AGENT = "tokitoki";

export interface PolledWindow {
  /** minutes; mirrors quota_snapshots.window_minutes */
  windowMinutes: number;
  usedPct: number;
  resetsAtEpoch: number;
  /** Distinguishes same-duration windows on one account (e.g. Cursor's "Cursor Models" vs "Other Models"). */
  label?: string;
  /** Real USD spend for open-ended windows (e.g. Cursor's On-Demand) — displayed instead of usedPct when present. */
  amountUsd?: number;
  /** Model family for per-model limits (Claude's weekly Opus/Sonnet caps). */
  model?: string;
  bucketId?: string;
  windowId?: string;
  scope?: "session" | "daily" | "weekly" | "monthly" | "model" | "other";
  windowStart?: string;
  windowEnd?: string;
  observedAt?: string;
}

export interface PollAccountResult {
  accountKey: string;
  /** Stable provider account identity; reset timestamps are not identity. */
  accountId?: string;
  /** Harnesses sharing this polled account (opencode-go spans pi+opencode). */
  harnesses?: string[];
  email?: string;
  planType?: string;
  windows: PolledWindow[];
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string; expiresAt?: string };
  bankedResets?: number;
  bankedExpiresAt?: string;
  extraUsage?: AccountExtraUsage;
  /** Prepaid credit balance (DeepSeek, OpenRouter). Balance-only accounts carry no windows. */
  balance?: AccountBalance;
  inserted: number;
  error?: string;
  /** Set when this result was served from stored snapshots instead of a live request (backoff / min interval). */
  deferredUntil?: string;
}

export interface PollResult {
  ok: boolean;
  reason?: string;
  accounts: PollAccountResult[];
  /** Providers whose local credentials need login or re-authentication. */
  authRequiredProviders?: string[];
  /** Actionable provider credential state, keyed by visible card provider id. */
  providerAuthStates?: Record<string, "login-required" | "api-key-required" | "temporarily-unavailable">;
}

/**
 * Convert an upstream poller's provider id into the provider ids used by
 * visible quota cards. Shared credentials can appear under harness ids.
 */
function authRequiredCardProviders(provider: string): string[] {
  switch (provider) {
    case "openrouter": return ["openrouter", "pi"];
    case "opencode-go": return ["opencode-go", "opencode", "pi"];
    default: return [provider];
  }
}

/** Provider auth failures should be visible even when the exact API wording varies. */
function isAuthRequiredReason(reason: string): boolean {
  return /not logged in|auth(?:entication)? (?:not found|required)|oauth[_ -]?token|unauthorized|token refresh failed|token expired|refresh token|\b(?:401|403)\b/i.test(reason);
}

function authStateFor(provider: string, reason: string): "login-required" | "api-key-required" | "temporarily-unavailable" | undefined {
  const keyProvider = provider === "openrouter" || provider === "opencode-go" || provider === "zai" || provider === "deepseek" ||
    (provider === "kimi" && !/\bkimi CLI\b/i.test(reason));
  if (keyProvider && (/no key|api[_ -]?key|oauth[_ -]?token|\b(?:401|403)\b|unauthorized/i.test(reason))) {
    return "api-key-required";
  }
  if (isAuthRequiredReason(reason)) return "login-required";
  if (/\b(?:http )?5\d\d\b|network|timeout|fetch|temporarily/i.test(reason)) return "temporarily-unavailable";
  return undefined;
}

function authStatePriority(state: "login-required" | "api-key-required" | "temporarily-unavailable"): number {
  return state === "temporarily-unavailable" ? 1 : 2;
}

export interface PollOptions {
  /** Limit the run to one upstream provider (used by card-level refresh). */
  providers?: string[];
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Absolute path to a codex auth.json fixture (tests). */
  authPath?: string;
  /** Explicit native homes; overrides config and environment discovery. */
  codexHomes?: string[];
  /** Complete app-server argv (tests). Default: ["codex", "app-server"]. */
  codexCommand?: string[];
  /** Absolute path to a pi auth.json fixture (tests). Default ~/.pi/agent/auth.json. */
  piAuthPath?: string;
  /** Absolute path to a claude .credentials.json fixture (tests). Default ~/.claude/.credentials.json; keychain fallback when absent. */
  claudeCredentialsPath?: string;
  /** Absolute path to a .claude.json fixture holding oauthAccount (tests). Default ~/.claude.json. */
  claudeAccountPath?: string;
  /** Absolute path to a github-copilot apps.json/hosts.json fixture (tests). Default ~/.config/github-copilot/{apps,hosts}.json. */
  copilotAuthPath?: string;
  /** Absolute path to a cursor cli-auth.json fixture (tests). Default ~/.cursor/cli-auth.json. */
  cursorAuthPath?: string;
  /** Absolute path to a cursor state.vscdb fixture (tests). Default platform IDE data dir. */
  cursorStateVscdbPath?: string;
  /** Absolute path to an opencode auth.json fixture (tests). Default ~/.local/share/opencode/auth.json. */
  opencodeAuthPath?: string;
  /** Absolute path to Command Code auth.json (tests). Default ~/.commandcode/auth.json. */
  commandcodeAuthPath?: string;
  /** Manually registered provider keys polled as synthetic accounts. */
  manualKeys?: Array<{ id: string; provider: "opencode-go" | "openrouter"; key: string }>;
  /** API keys from config.poll.extraKeys for single-account key providers (first key per provider wins). */
  providerKeys?: Partial<Record<"zai" | "kimi" | "deepseek", string>>;
  /** z.ai API host: global api.z.ai (default) or open.bigmodel.cn. */
  zaiRegion?: ZaiRegion;
  /** Absolute path to a gemini oauth_creds.json fixture (tests). Default ~/.gemini/oauth_creds.json. */
  geminiCredsPath?: string;
  /** Kimi Code CLI home (tests). Default $KIMI_CODE_HOME, else ~/.kimi-code then ~/.kimi. */
  kimiHome?: string;
  /** Environment for credential discovery (tests). Default process.env. */
  env?: Record<string, string | undefined>;
  /** EventCache instance (tests use a temp db). Default: open the real one. */
  cache?: EventCache;
  now?: number;
}

/** Read pi's auth store (~/.pi/agent/auth.json) → {provider: raw api key}. */
export function piCredentials(
  path: string = `${process.env.PI_DIR ?? `${process.env.HOME ?? "~"}/.pi`}/agent/auth.json`,
): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, { type?: string; key?: string }>;
    const out: Record<string, string> = {};
    for (const [provider, entry] of Object.entries(parsed)) {
      if (entry !== null && typeof entry === "object" && typeof entry.key === "string") {
        out[provider] = entry.key;
      }
    }
    return out;
  } catch {
    return {};
  }
}

interface OpenRouterKeyResponse {
  data?: { limit?: number | null; limit_remaining?: number | null; limit_reset?: string | null };
}

/** OpenRouter /key → one window when a credit limit is configured, plus the /credits balance. */
async function pollOpenRouter(key: string, fetcher: typeof fetch): Promise<{ windows: PolledWindow[]; balance?: AccountBalance; skip?: string; error?: string }> {
  let body: OpenRouterKeyResponse;
  try {
    const res = await fetcher(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
    if (!res.ok) return { windows: [], error: `HTTP ${res.status}` };
    body = (await res.json()) as OpenRouterKeyResponse;
  } catch (e) {
    return { windows: [], error: String(e) };
  }
  const balance = await fetchOpenRouterCredits({ key, fetcher });
  const d = body.data ?? {};
  if (typeof d.limit !== "number" || d.limit <= 0 || typeof d.limit_remaining !== "number") {
    return balance !== undefined ? { windows: [], balance } : { windows: [], skip: "no credit limit configured on the key" };
  }
  const used = Math.max(0, d.limit - Math.max(0, d.limit_remaining));
  const pct = Math.min(100, (used / d.limit) * 100);
  const scope = d.limit_reset === "daily" ? "daily" : d.limit_reset === "weekly" ? "weekly" : d.limit_reset === "monthly" ? "monthly" : "other";
  const minutes = scope === "daily" ? 1440 : scope === "weekly" ? 10_080 : 0;
  return { windows: [{ windowMinutes: minutes, usedPct: pct, resetsAtEpoch: 0, bucketId: "key-credit-limit", windowId: "limit", scope, label: "Key credit limit" }], ...(balance !== undefined ? { balance } : {}) };
}

interface OpencodeUsageResponse {
  usage?: Record<string, { percent?: number; resetsAt?: string }>;
}

/** OpenCode zen/go usage → rolling(5h)/weekly/monthly percent meters. */
async function pollOpencodeGo(key: string, fetcher: typeof fetch): Promise<{ windows: PolledWindow[]; error?: string }> {
  let body: OpencodeUsageResponse;
  try {
    const res = await fetcher(OPENCODE_USAGE_URL, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
    if (!res.ok) return { windows: [], error: `HTTP ${res.status}` };
    body = (await res.json()) as OpencodeUsageResponse;
  } catch (e) {
    return { windows: [], error: String(e) };
  }
  const u = body.usage ?? {};
  const spec: Array<[string, number]> = [
    ["rolling", 300],
    ["weekly", 10_080],
    ["monthly", 43_200],
  ];
  const windows: PolledWindow[] = [];
  for (const [name, minutes] of spec) {
    const w = u[name];
    if (w === undefined || typeof w.percent !== "number") continue;
    const resets = typeof w.resetsAt === "string" ? Date.parse(w.resetsAt) : NaN;
    windows.push({
      windowMinutes: minutes,
      usedPct: Math.max(0, Math.min(100, w.percent)),
      resetsAtEpoch: Number.isFinite(resets) ? Math.round(resets / 1000) : 0,
    });
  }
  if (windows.length === 0) return { windows: [], error: "no usable windows in response" };
  return { windows };
}

/**
 * Claude Code OAuth credentials: ~/.claude/.credentials.json first, then the
 * macOS Keychain generic password "Claude Code-credentials" (same JSON).
 * An explicit opts.claudeCredentialsPath (fixture/tests) disables the
 * Keychain fallback so behavior stays deterministic.
 */
const ClaudeCredentialsFileSchema = z.object({
  claudeAiOauth: z.looseObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().optional(),
    subscriptionType: z.string().optional(),
    rateLimitTier: z.string().optional(),
  }),
});

type ClaudeCredentials = z.infer<typeof ClaudeCredentialsFileSchema>["claudeAiOauth"];

export function loadClaudeCredentials(opts: PollOptions): ClaudeCredentials | null {
  const explicit = opts.claudeCredentialsPath !== undefined;
  const path = opts.claudeCredentialsPath ?? `${process.env.HOME ?? "~"}/.claude/.credentials.json`;
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    // File absent — fall through to the Keychain (macOS only; skip elsewhere)
    // unless a fixture path was given.
    if (explicit || process.platform !== "darwin") return null;
    try {
      raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
    } catch {
      return null;
    }
  }
  try {
    const parsed = ClaudeCredentialsFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.claudeAiOauth : null;
  } catch {
    return null;
  }
}

/**
 * Write a rotated access/refresh token back to wherever it was read from —
 * merging into the existing claudeAiOauth object (never dropping sibling
 * fields like scopes/subscriptionType, or the unrelated top-level mcpOAuth
 * key) so Claude Code's own next read still sees a valid, current session.
 * Best-effort and silent: a failed persist here must never fail the poll
 * itself, since the freshly-fetched quota data is already in hand either way.
 */
function persistClaudeCredentials(
  opts: PollOptions,
  updated: { accessToken: string; refreshToken?: string; expiresAt?: number },
): void {
  if (updated.refreshToken === undefined) return; // nothing rotated — nothing to persist
  const mergeOauth = (parsed: Record<string, unknown>): Record<string, unknown> => {
    const oauth = (parsed.claudeAiOauth ?? {}) as Record<string, unknown>;
    return {
      ...parsed,
      claudeAiOauth: {
        ...oauth,
        accessToken: updated.accessToken,
        refreshToken: updated.refreshToken,
        ...(updated.expiresAt !== undefined ? { expiresAt: updated.expiresAt } : {}),
      },
    };
  };

  const explicit = opts.claudeCredentialsPath !== undefined;
  const path = opts.claudeCredentialsPath ?? `${process.env.HOME ?? "~"}/.claude/.credentials.json`;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
    const tmp = `${path}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(mergeOauth(parsed), null, 2));
    fs.renameSync(tmp, path); // same filesystem — atomic, no partial-write window
    return;
  } catch {
    // File absent or unreadable — fall through to the Keychain, unless a
    // fixture path was given (tests must never touch the real Keychain).
  }
  if (explicit || process.platform !== "darwin") return;
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const account = execFileSync("whoami", []).toString().trim();
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", "Claude Code-credentials", "-a", account, "-w", JSON.stringify(mergeOauth(parsed))],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  } catch {
    // best-effort — see doc comment above
  }
}

async function refreshClaudeToken(
  refreshToken: string,
  fetcher: typeof fetch,
): Promise<{ ok: boolean; accessToken?: string; refreshToken?: string; expiresAt?: number; error?: string }> {
  try {
    const res = await fetcher(CLAUDE_REFRESH_URL, {
      method: "POST",
      // Claude Code's token endpoint expects a JSON OAuth payload. Form-encoded
      // requests are rejected, which leaves the last good quota snapshot stale
      // even though the local refresh token is still valid.
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID }),
    });
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok) {
      const detail = json.error_description ?? json.error;
      return { ok: false, ...(detail !== undefined ? { error: detail } : {}) };
    }
    if (json.access_token === undefined || json.access_token.length === 0) return { ok: false };
    return {
      ok: true,
      accessToken: json.access_token,
      // Anthropic's refresh tokens are single-use and rotate on every
      // refresh (confirmed: github.com/anthropics/claude-code#54443,
      // steipete/CodexBar#1161 — a tool that refreshes without persisting
      // the rotation silently invalidates Claude Code's own stored session,
      // forcing re-login there or on any other device sharing the account).
      ...(json.refresh_token !== undefined && json.refresh_token.length > 0
        ? { refreshToken: json.refresh_token }
        : {}),
      ...(typeof json.expires_in === "number" ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    };
  } catch {
    return { ok: false };
  }
}

const ClaudeUsageWindowSchema = z.object({
  utilization: z.number().finite(),
  resets_at: z.string().nullish(),
}).nullish();

const ClaudeUsageSchema = z.object({
  five_hour: ClaudeUsageWindowSchema,
  seven_day: ClaudeUsageWindowSchema,
  seven_day_opus: ClaudeUsageWindowSchema,
  seven_day_sonnet: ClaudeUsageWindowSchema,
  extra_usage: z.object({
    is_enabled: z.boolean().nullish(),
    /** Minor currency units (cents). */
    monthly_limit: z.number().nullish(),
    used_credits: z.number().nullish(),
    utilization: z.number().nullish(),
  }).nullish(),
});

const ClaudeProfileSchema = z.object({
  account: z.object({
    uuid: z.string().optional(),
    email_address: z.string().optional(),
    email: z.string().optional(),
  }).optional(),
  organization: z.object({
    uuid: z.string().optional(),
    name: z.string().optional(),
    organization_type: z.string().optional(),
    rate_limit_tier: z.string().optional(),
  }).optional(),
});

/** Human plan name from Claude's subscription type and rate-limit tier ("max" + "default_claude_max_20x" → "Max 20x"). */
export const claudePlanLabel = (input: { subscriptionType?: string; rateLimitTier?: string }): string | undefined => {
  const base = input.subscriptionType?.trim().toLowerCase().replace(/^claude_/, "");
  const multiplier = input.rateLimitTier?.toLowerCase().match(/max_(\d+)x/)?.[1];
  if (multiplier !== undefined && (base === undefined || base === "max")) return `Max ${multiplier}x`;
  if (base === undefined || base.length === 0) return undefined;
  return base.charAt(0).toUpperCase() + base.slice(1);
};

/** /api/oauth/usage body → session, weekly, and per-model weekly windows plus extra usage. */
export const parseClaudeUsage = (body: unknown): { windows: PolledWindow[]; extraUsage?: AccountExtraUsage } | undefined => {
  const parsed = ClaudeUsageSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const usage = parsed.data;
  if (![usage.five_hour, usage.seven_day, usage.seven_day_opus, usage.seven_day_sonnet].some((window) => window !== undefined)) return undefined;
  const spec: Array<{ window: z.infer<typeof ClaudeUsageWindowSchema>; minutes: number; windowId: string; scope: "session" | "weekly" | "model"; model?: string }> = [
    { window: usage.five_hour, minutes: 300, windowId: "five_hour", scope: "session" },
    { window: usage.seven_day, minutes: 10_080, windowId: "seven_day", scope: "weekly" },
    { window: usage.seven_day_opus, minutes: 10_080, windowId: "seven_day", scope: "model", model: "opus" },
    { window: usage.seven_day_sonnet, minutes: 10_080, windowId: "seven_day", scope: "model", model: "sonnet" },
  ];
  const windows: PolledWindow[] = [];
  for (const entry of spec) {
    const utilization = entry.window?.utilization;
    if (typeof utilization !== "number") continue;
    const resets = typeof entry.window?.resets_at === "string" ? Date.parse(entry.window.resets_at) : NaN;
    windows.push({
      windowMinutes: entry.minutes,
      usedPct: Math.max(0, Math.min(100, utilization)),
      resetsAtEpoch: Number.isFinite(resets) ? Math.round(resets / 1000) : 0,
      bucketId: entry.model ?? "claude",
      windowId: entry.windowId,
      scope: entry.scope,
      ...(Number.isFinite(resets) ? { windowEnd: new Date(resets).toISOString() } : {}),
      ...(entry.model !== undefined
        ? { model: entry.model, label: `${entry.model.charAt(0).toUpperCase()}${entry.model.slice(1)} weekly` }
        : {}),
    });
  }
  const extra = usage.extra_usage;
  if (extra === null || extra === undefined || typeof extra.is_enabled !== "boolean") return { windows };
  const usedUsd = typeof extra.used_credits === "number" ? extra.used_credits / 100 : undefined;
  const limitUsd = typeof extra.monthly_limit === "number" ? extra.monthly_limit / 100 : undefined;
  const usedPercent = typeof extra.utilization === "number"
    ? extra.utilization
    : usedUsd !== undefined && limitUsd !== undefined && limitUsd > 0 ? (usedUsd / limitUsd) * 100 : undefined;
  return {
    windows,
    extraUsage: {
      enabled: extra.is_enabled,
      ...(usedUsd !== undefined ? { usedUsd } : {}),
      ...(limitUsd !== undefined ? { limitUsd } : {}),
      ...(usedPercent !== undefined ? { usedPercent: Math.max(0, Math.min(100, usedPercent)) } : {}),
    },
  };
};

export interface ClaudeIdentity {
  email?: string;
  accountId?: string;
  organization?: string;
  plan?: string;
}

/** /api/oauth/profile body → stable account identity and plan. */
export const parseClaudeProfile = (body: unknown): ClaudeIdentity => {
  const parsed = ClaudeProfileSchema.safeParse(body);
  if (!parsed.success) return {};
  const account = parsed.data.account;
  const organization = parsed.data.organization;
  const email = account?.email_address ?? account?.email;
  const plan = claudePlanLabel({
    subscriptionType: organization?.organization_type,
    rateLimitTier: organization?.rate_limit_tier,
  });
  return {
    ...(email !== undefined && email.includes("@") ? { email } : {}),
    ...(account?.uuid !== undefined ? { accountId: account.uuid } : {}),
    ...(organization?.name !== undefined ? { organization: organization.name } : {}),
    ...(plan !== undefined ? { plan } : {}),
  };
};

const claudeHeaders = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
  accept: "application/json",
  "anthropic-beta": "oauth-2025-04-20",
  "user-agent": "claude-code/2.1.69",
});

/**
 * Who is logged in: Claude Code's own .claude.json and credential metadata
 * first (no network), then the OAuth profile endpoint only for what is
 * missing. Identity failures never fail the quota poll.
 */
async function resolveClaudeIdentity(
  opts: PollOptions,
  creds: ClaudeCredentials,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<ClaudeIdentity> {
  const local = claudeOauthAccount(opts.claudeAccountPath);
  const localPlan = claudePlanLabel({ subscriptionType: creds.subscriptionType, rateLimitTier: creds.rateLimitTier });
  const identity: ClaudeIdentity = {
    ...(local?.email !== undefined ? { email: local.email } : {}),
    ...(local?.accountUuid !== undefined ? { accountId: local.accountUuid } : {}),
    ...(local?.organizationName !== undefined ? { organization: local.organizationName } : {}),
    ...(localPlan !== undefined ? { plan: localPlan } : {}),
  };
  if (identity.email !== undefined && identity.accountId !== undefined && identity.plan !== undefined) return identity;
  try {
    const res = await fetcher(CLAUDE_PROFILE_URL, { headers: claudeHeaders(accessToken) });
    if (!res.ok) return identity;
    const remote = parseClaudeProfile(await res.json());
    return { ...remote, ...identity };
  } catch {
    return identity;
  }
}

/**
 * claude-code OAuth usage → session, weekly, and per-model weekly meters.
 * Cards stay keyed by "default" because claude-code's local events (and
 * their stable synced event ids) use that key; the real login is carried as
 * accountId/email/plan instead.
 */
async function pollClaudeQuotas(opts: PollOptions, fetcher: typeof fetch): Promise<PollAccountResult | string> {
  const creds = loadClaudeCredentials(opts);
  if (creds === null || creds.accessToken === undefined || creds.accessToken.length === 0) {
    return "not logged in (~/.claude/.credentials.json and keychain both empty)";
  }

  const fetchOnce = async (accessToken: string) => {
    try {
      const res = await fetcher(CLAUDE_USAGE_URL, { headers: claudeHeaders(accessToken) });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // non-JSON error body
      }
      return { status: res.status, body, retryAfter: res.headers.get("retry-after") };
    } catch {
      return { status: 0, body: null, retryAfter: null };
    }
  };

  let accessToken = creds.accessToken;
  let res = await fetchOnce(accessToken);
  if (res.status === 401 || res.status === 403) {
    if (creds.refreshToken === undefined || creds.refreshToken.length === 0) {
      return `unauthorized (${res.status}) and no refresh token available`;
    }
    const renewed = await refreshClaudeToken(creds.refreshToken, fetcher);
    if (!renewed.ok || renewed.accessToken === undefined) {
      return `unauthorized (${res.status}) and token refresh failed${renewed.error !== undefined ? `: ${renewed.error}` : ""}`;
    }
    persistClaudeCredentials(opts, { accessToken: renewed.accessToken, refreshToken: renewed.refreshToken, expiresAt: renewed.expiresAt });
    accessToken = renewed.accessToken;
    res = await fetchOnce(accessToken);
  }
  if (res.status === 429) {
    const seconds = Number(res.retryAfter);
    return `usage endpoint returned HTTP 429${Number.isFinite(seconds) && seconds > 0 ? ` (retry after ${Math.round(seconds)}s)` : ""}`;
  }
  if (res.status < 200 || res.status >= 300 || res.body === null) {
    return `usage endpoint returned HTTP ${res.status}`;
  }
  const usage = parseClaudeUsage(res.body);
  if (usage === undefined) return "usage response shape unrecognized";
  const capturedAtIso = new Date(opts.now ?? Date.now()).toISOString();
  for (const window of usage.windows) window.observedAt = capturedAtIso;
  const identity = await resolveClaudeIdentity(opts, creds, accessToken, fetcher);
  const accountKey = "default";
  const result: PollAccountResult = {
    accountKey,
    ...(identity.accountId !== undefined ? { accountId: identity.accountId } : {}),
    harnesses: ["claude-code"],
    ...(identity.email !== undefined ? { email: identity.email } : {}),
    ...(identity.plan !== undefined ? { planType: identity.plan } : {}),
    ...(usage.extraUsage !== undefined ? { extraUsage: usage.extraUsage } : {}),
    windows: usage.windows,
    inserted: 0,
  };
  opts.cache?.setQuotaAccountMeta("claude-code", accountKey, {
    ...(identity.plan !== undefined ? { plan: identity.plan } : {}),
    ...(identity.email !== undefined ? { email: identity.email } : {}),
    ...(identity.organization !== undefined ? { organization: identity.organization } : {}),
    ...(usage.extraUsage !== undefined ? { extraUsage: usage.extraUsage } : {}),
  });
  result.inserted = opts.cache?.insertPolledSnapshots({
    provider: "claude-code",
    accountKey,
    ...(identity.accountId !== undefined ? { accountId: identity.accountId } : {}),
    windows: usage.windows,
    capturedAtIso,
    eventId: `poll:${capturedAtIso}:claude`,
  }) ?? 0;
  return result;
}

/** github.com oauth_token from ~/.config/github-copilot/apps.json (newer) or hosts.json. */
export function copilotToken(path?: string): string | null {
  const base = `${process.env.HOME ?? "~"}/.config/github-copilot`;
  const candidates = path !== undefined ? [path] : [`${base}/apps.json`, `${base}/hosts.json`];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { oauth_token?: string }>;
      const entry = parsed["github.com"] ?? Object.entries(parsed).find(([host]) => host.startsWith("github.com"))?.[1];
      if (entry !== undefined && typeof entry.oauth_token === "string" && entry.oauth_token.length > 0) {
        return entry.oauth_token;
      }
    } catch {
      // try next candidate
    }
  }
  // Explicit fixture paths are hermetic and must not fall through to the
  // machine's Keychain.
  if (path !== undefined) return null;
  // GitHub CLI stores the same credential in Keychain on macOS when its
  // hosts.yml deliberately omits oauth_token. OpenUsage uses this fallback.
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "gh:github.com", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const prefix = "go-keyring-base64:";
    if (raw.startsWith(prefix)) {
      const decoded = Buffer.from(raw.slice(prefix.length), "base64").toString("utf8").trim();
      if (decoded.length > 0) return decoded;
    }
    if (raw.length > 0) {
      try {
        const wrapped = JSON.parse(raw) as { oauth_token?: string; token?: string };
        if (typeof wrapped.oauth_token === "string") return wrapped.oauth_token;
        if (typeof wrapped.token === "string") return wrapped.token;
      } catch {
        return raw;
      }
    }
  } catch {
    // no Keychain credential or non-macOS
  }
  return null;
}

interface CopilotUserResponse {
  quota_reset_date?: string;
  quota_reset_date_utc?: string;
  limited_user_reset_date?: string;
  token_based_billing?: boolean;
  monthly_quotas?: Record<string, number>;
  limited_user_quotas?: Record<string, number>;
  quota_snapshots?: Record<string, Record<string, unknown>>;
}

interface CommandCodeAuth {
  apiKey?: string;
}

function commandcodeAuthPath(opts: PollOptions): string {
  return opts.commandcodeAuthPath ?? `${process.env.HOME ?? "~"}/.commandcode/auth.json`;
}

function loadCommandCodeKey(opts: PollOptions): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(commandcodeAuthPath(opts), "utf8")) as CommandCodeAuth;
    return typeof parsed.apiKey === "string" && parsed.apiKey.length > 0 ? parsed.apiKey : null;
  } catch {
    return null;
  }
}

interface CommandCodeCredits {
  credits?: {
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
  };
  windowLimits?: {
    limited?: boolean;
    fiveHour?: { used?: number; cap?: number; resetAt?: number };
    weekly?: { used?: number; cap?: number; resetAt?: number };
  };
}

interface CommandCodeSummary {
  totalCost?: number;
  totalMonthlyCredits?: number;
}

interface CommandCodeSubscription {
  data?: { currentPeriodStart?: string; currentPeriodEnd?: string };
}

/** Command Code's own billing API powers the same meters shown by `/usage`. */
async function pollCommandCodeQuotas(
  opts: PollOptions,
  fetcher: typeof fetch,
  now: number,
): Promise<PollAccountResult | string> {
  const key = loadCommandCodeKey(opts);
  if (key === null) return "not logged in (no ~/.commandcode/auth.json apiKey)";
  const headers = { authorization: `Bearer ${key}`, accept: "application/json" };
  const get = async (path: string): Promise<Record<string, unknown> | string> => {
    try {
      const res = await fetcher(`${COMMANDCODE_API_URL}${path}`, { headers });
      if (!res.ok) return `HTTP ${res.status}`;
      const body = await res.json();
      return body !== null && typeof body === "object" ? body as Record<string, unknown> : "invalid JSON response";
    } catch (e) {
      return String(e);
    }
  };

  const whoami = await get("/alpha/whoami");
  if (typeof whoami === "string") return `whoami: ${whoami}`;
  const creditsRaw = await get("/alpha/billing/credits");
  if (typeof creditsRaw === "string") return `credits: ${creditsRaw}`;
  const who = whoami.user as { email?: string } | undefined;
  const credits = creditsRaw as unknown as CommandCodeCredits;
  const org = whoami.org as { id?: string } | null | undefined;
  const query = org?.id ? `?orgId=${encodeURIComponent(org.id)}` : "";
  const [subscriptionRaw, summaryRaw] = await Promise.all([
    get(`/alpha/billing/subscriptions${query}`),
    get(`/alpha/usage/summary${query}`),
  ]);
  if (typeof subscriptionRaw === "string") return `subscription: ${subscriptionRaw}`;
  if (typeof summaryRaw === "string") return `summary: ${summaryRaw}`;
  const limits = credits.windowLimits;
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const windows: PolledWindow[] = [];
  const addWindow = (value: { used?: number; cap?: number; resetAt?: number } | undefined, minutes: number): void => {
    const used = number(value?.used);
    const cap = number(value?.cap);
    if (used === undefined || cap === undefined || cap <= 0) return;
    const reset = number(value?.resetAt);
    windows.push({
      windowMinutes: minutes,
      bucketId: "included",
      windowId: minutes === 300 ? "fiveHour" : "weekly",
      scope: minutes === 300 ? "session" : "weekly",
      observedAt: new Date(now).toISOString(),
      usedPct: Math.max(0, Math.min(100, (used / cap) * 100)),
      resetsAtEpoch: reset !== undefined && reset > 0 ? Math.round(reset) : 0,
    });
  };
  addWindow(limits?.fiveHour, 300);
  addWindow(limits?.weekly, 10_080);

  const summary = summaryRaw as unknown as CommandCodeSummary;
  const remaining = number(credits.credits?.monthlyCredits) ?? 0;
  const spent = number(summary.totalMonthlyCredits) ?? number(summary.totalCost) ?? 0;
  const monthCap = remaining + spent;
  if (monthCap > 0) {
    const periodEnd = (subscriptionRaw as unknown as CommandCodeSubscription).data?.currentPeriodEnd;
    const resetMs = typeof periodEnd === "string" ? Date.parse(periodEnd) : NaN;
    const periodStart = (subscriptionRaw as unknown as CommandCodeSubscription).data?.currentPeriodStart;
    const startMs = typeof periodStart === "string" ? Date.parse(periodStart) : NaN;
    const hasBounds = Number.isFinite(startMs) && Number.isFinite(resetMs) && resetMs > startMs;
    windows.push({
      windowMinutes: hasBounds ? (resetMs - startMs) / 60_000 : 0,
      bucketId: "monthly-credits",
      windowId: "billing-cycle",
      scope: "monthly",
      observedAt: new Date(now).toISOString(),
      ...(hasBounds ? { windowStart: new Date(startMs).toISOString() } : {}),
      ...(Number.isFinite(resetMs) ? { windowEnd: new Date(resetMs).toISOString() } : {}),
      usedPct: Math.max(0, Math.min(100, (spent / monthCap) * 100)),
      resetsAtEpoch: Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : 0,
    });
  }
  const capturedAtIso = new Date(now).toISOString();
  const inserted = opts.cache?.insertPolledSnapshots({
    provider: "commandcode",
    accountKey: "default",
    complete: windows.length > 0,
    windows,
    capturedAtIso,
    eventId: `poll:${capturedAtIso}:commandcode`,
  }) ?? 0;
  return {
    accountKey: "default",
    ...(typeof who?.email === "string" ? { email: who.email } : {}),
    planType: typeof (subscriptionRaw as unknown as CommandCodeSubscription).data === "object" ? "commandcode" : undefined,
    windows,
    inserted,
    ...(windows.length === 0 ? { error: "no usable usage windows in response" } : {}),
  };
}

/** Copilot internal/user → one window per real quota_snapshots bucket. */
async function pollCopilotQuotas(opts: PollOptions, fetcher: typeof fetch, now: number): Promise<PollAccountResult | string> {
  const token = copilotToken(opts.copilotAuthPath);
  if (token === null) return "not logged in (no GitHub oauth_token in ~/.config/github-copilot/{apps,hosts}.json)";

  let body: CopilotUserResponse;
  try {
    const res = await fetcher(COPILOT_USAGE_URL, {
      headers: {
        authorization: `token ${token}`, // `token` scheme is what this endpoint accepts
        accept: "application/vnd.github+json",
        "editor-version": "vscode/1.96.2",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "x-github-api-version": "2025-04-01",
        "user-agent": "GitHubCopilotChat/0.26.7",
      },
    });
    if (!res.ok) return `HTTP ${res.status}`;
    body = (await res.json()) as CopilotUserResponse;
  } catch (e) {
    return String(e);
  }

  const resetDate = body.quota_reset_date_utc ?? body.quota_reset_date ?? body.limited_user_reset_date;
  const accountResetMs = typeof resetDate === "string" ? Date.parse(resetDate) : NaN;
  const snapshots = { ...body.quota_snapshots };
  for (const bucket of ["chat", "completions"]) {
    if (snapshots[bucket] !== undefined) continue;
    const entitlement = body.monthly_quotas?.[bucket];
    const remaining = body.limited_user_quotas?.[bucket];
    if (entitlement !== undefined && remaining !== undefined) snapshots[bucket] = { entitlement, quota_remaining: remaining };
  }
  const windows: PolledWindow[] = [];
  const numberLike = z.union([z.number(), z.string().trim().min(1).transform(Number)]).pipe(z.number().finite());
  const num = (value: unknown): number | null => {
    const parsed = numberLike.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  for (const [bucket, snapshot] of Object.entries(snapshots)) {
    if (snapshot === null || typeof snapshot !== "object") continue;
    const entitlement = num(snapshot["entitlement"]);
    const remaining = num(snapshot["quota_remaining"] ?? snapshot["remaining"]);
    const percentRemaining = num(snapshot["percent_remaining"]);
    // Unlimited (-1 sentinels / explicit flag) or zero entitlement = no real meter.
    if (snapshot["unlimited"] === true || entitlement === -1 || remaining === -1 || entitlement === 0) continue;
    let usedPct: number | null = null;
    if (percentRemaining !== null) usedPct = Math.max(0, Math.min(100, 100 - percentRemaining));
    else if (entitlement !== null && entitlement > 0 && remaining !== null) {
      usedPct = Math.max(0, Math.min(100, 100 - (remaining / entitlement) * 100));
    }
    if (usedPct === null) continue;
    const bucketReset = num(snapshot["quota_reset_at"]);
    const resetMs = bucketReset !== null && bucketReset > 0 ? bucketReset * 1000 : accountResetMs;
    const end = new Date(resetMs);
    const calendarReset = Number.isFinite(resetMs) && end.getUTCDate() === 1 &&
      end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0 && end.getUTCMilliseconds() === 0;
    const startMs = calendarReset ? Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1) : NaN;
    const label = bucket === "premium_interactions"
      ? body.token_based_billing === true ? "AI Credits" : "Premium requests"
      : bucket === "chat" ? "Chat" : bucket === "completions" ? "Completions" : bucket;
    windows.push({
      windowMinutes: calendarReset ? (resetMs - startMs) / 60_000 : 0,
      usedPct,
      resetsAtEpoch: Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : 0,
      bucketId: bucket,
      windowId: "monthly",
      scope: "monthly",
      label,
      observedAt: new Date(now).toISOString(),
      ...(calendarReset ? { windowStart: new Date(startMs).toISOString() } : {}),
      ...(Number.isFinite(resetMs) ? { windowEnd: end.toISOString() } : {}),
    });
  }
  const capturedAtIso = new Date(now).toISOString();
  const inserted = opts.cache?.insertPolledSnapshots({
    provider: "copilot",
    accountKey: "default",
    complete: windows.length > 0,
    windows,
    capturedAtIso,
    eventId: `poll:${capturedAtIso}:copilot`,
  }) ?? 0;
  return { accountKey: "default", harnesses: ["copilot"], windows, inserted, ...(windows.length === 0 ? { error: "no bounded quota buckets in response" } : {}) };
}

/** cursor-agent CLI's login file — present when the user ran `cursor-agent login`. */
function cursorCliAuthToken(opts: PollOptions): string | null {
  const authPath = opts.cursorAuthPath ?? `${process.env.HOME ?? "~"}/.cursor/cli-auth.json`;
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as { accessToken?: string; api_key?: string };
    const t = parsed.accessToken ?? parsed.api_key;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * Cursor IDE's own login token, read from state.vscdb's `cursorAuth/accessToken`
 * ItemTable row — same store the cursor provider reads for session data. Falls
 * back here when there's no cursor-agent CLI login (common for IDE-only /
 * T3-Code-driven usage, since T3 Code just launches the CLI using this same
 * account under the hood).
 */
function cursorIdeAuthToken(opts: PollOptions): string | null {
  const dbPath = opts.cursorStateVscdbPath ?? path.join(cursorIdeDir(), "User", "globalStorage", "state.vscdb");
  if (!fs.existsSync(dbPath)) return null;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    try {
      db = new Database(`file:${encodeURI(dbPath)}?immutable=1`, { readonly: true });
    } catch {
      return null;
    }
  }
  try {
    const row = db.query<{ value: string }, []>("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get();
    const t = row?.value;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Best-effort cursor access token: cursor-agent CLI login, else the IDE's own login. */
function cursorAccessToken(opts: PollOptions): string | null {
  return cursorCliAuthToken(opts) ?? cursorIdeAuthToken(opts);
}

/**
 * Cursor dashboard Connect POST → three included-usage buckets, verified
 * against a real account's live response 2026-09-01 (this is what
 * GetCurrentPeriodUsage actually returns — an earlier guessed shape
 * {billingPeriodInfo:{usagePercent,...}} never matched any real account
 * and always fell through to "response shape unrecognized"):
 *
 *   {"billingCycleStart":"<epoch ms>","billingCycleEnd":"<epoch ms>",
 *    "planUsage":{"autoPercentUsed":38.5,"apiPercentUsed":0,
 *                 "totalPercentUsed":32.4,...},
 *    "spendLimitUsage":{"pooledUsed":34770,"pooledLimit":300000,
 *                        "limitType":"team"},...}
 *
 * autoPercentUsed is Cursor's own bundled/auto model bucket (grok/composer/
 * vega — see autoBucketModels); apiPercentUsed is explicitly-named models
 * outside that bucket. Confirmed against the human-readable
 * autoModelSelectedDisplayMessage/namedModelSelectedDisplayMessage strings
 * the same response carries. spendLimitUsage is the pooled on-demand/overage
 * tracker beyond the included plan — absent entirely on accounts with no
 * team pool or on-demand spending enabled, so it's optional here too.
 */
async function pollCursorQuotas(opts: PollOptions, fetcher: typeof fetch, now: number): Promise<PollAccountResult | string> {
  const token = cursorAccessToken(opts);
  if (token === null) return "cursor auth not found (no cursor-agent CLI login and no Cursor IDE login)";

  // Account events cover the IDE and T3 once. A dashboard failure must not
  // drop the quota windows this function already knows how to read.
  try {
    await syncCursorDashboardUsage({ accessToken: token, fetcher, cache: opts.cache, now });
  } catch (error) {
    console.error(`cursor dashboard usage: ${error instanceof Error ? error.message : String(error)}`);
  }

  let body: unknown;
  try {
    const res = await fetcher(CURSOR_USAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "connect-protocol-version": "1",
        accept: "application/json",
      },
      body: "{}",
    });
    if (!res.ok) return `HTTP ${res.status}`;
    body = await res.json();
  } catch (e) {
    return String(e);
  }

  const parsed = z.object({
    billingCycleStart: z.string().or(z.number()).optional(),
    billingCycleEnd: z.string().or(z.number()).optional(),
    planUsage: z.object({ autoPercentUsed: z.number().optional(), apiPercentUsed: z.number().optional() }).optional(),
    spendLimitUsage: z.object({ pooledUsed: z.number().optional(), pooledLimit: z.number().optional() }).optional(),
  }).safeParse(body);
  if (!parsed.success) return "cursor quota unavailable: unsupported response; current weekly plan schema is unverified";
  const root = parsed.data;
  if (root.planUsage !== undefined && root.planUsage.autoPercentUsed === undefined && root.planUsage.apiPercentUsed === undefined) {
    return "cursor quota unavailable: unsupported response; current weekly plan schema is unverified";
  }
  const startMs = root.billingCycleStart === undefined || root.billingCycleStart === "" ? NaN : Number(root.billingCycleStart);
  const endMs = root.billingCycleEnd === undefined || root.billingCycleEnd === "" ? NaN : Number(root.billingCycleEnd);
  const hasCycle = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const resetsAtEpoch = Number.isFinite(endMs) && endMs > 0 ? Math.round(endMs / 1000) : 0;
  const windowMinutes = hasCycle ? (endMs - startMs) / 60_000 : 0;
  const cycle: Pick<PolledWindow, "scope" | "windowId" | "observedAt" | "windowStart" | "windowEnd"> = {
    scope: "monthly",
    windowId: "billing-cycle",
    observedAt: new Date(now).toISOString(),
    ...(hasCycle ? { windowStart: new Date(startMs).toISOString() } : {}),
    ...(resetsAtEpoch > 0 ? { windowEnd: new Date(endMs).toISOString() } : {}),
  };

  const windows: PolledWindow[] = [];
  const pushPct = (label: string, pct: number | undefined): void => {
    if (typeof pct !== "number" || !Number.isFinite(pct)) return;
    windows.push({ windowMinutes, usedPct: Math.max(0, Math.min(100, pct)), resetsAtEpoch, label, bucketId: label === "Cursor Models" ? "cursor-models" : "other-models", ...cycle });
  };
  pushPct("Cursor Models", root.planUsage?.autoPercentUsed);
  pushPct("Other Models", root.planUsage?.apiPercentUsed);
  const { pooledUsed, pooledLimit } = root.spendLimitUsage ?? {};
  if (typeof pooledUsed === "number" && Number.isFinite(pooledUsed)) {
    // Cursor's own dashboard shows this as a dollar amount, not a percent
    // (confirmed against a real account's settings page) — open-ended
    // on-demand spend isn't bounded the way the two model buckets are.
    // usedPct still drives the bar fill when a real pooled cap exists.
    const hasPooledCap = typeof pooledLimit === "number" && pooledLimit > 0;
    windows.push({
      windowMinutes,
      usedPct: hasPooledCap ? Math.max(0, Math.min(100, (pooledUsed / pooledLimit) * 100)) : 0,
      resetsAtEpoch,
      label: "On-Demand",
      amountUsd: pooledUsed / 100,
      bucketId: "on-demand",
      ...cycle,
    });
  }
  if (windows.length === 0) return "cursor quota unavailable: unsupported response; current weekly plan schema is unverified";

  const capturedAtIso = new Date(now).toISOString();
  const inserted = opts.cache?.insertPolledSnapshots({
    provider: "cursor",
    accountKey: "default",
    windows,
    capturedAtIso,
    eventId: `poll:${capturedAtIso}:cursor`,
  }) ?? 0;
  return { accountKey: "default", harnesses: ["cursor"], windows, inserted };
}

export function redactCredential(secret: string): string {
  if (secret.length <= 12) return "…";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** Read ~/.local/share/opencode/auth.json → {accountKey: redacted key}. */
export function opencodeCredentials(
  path: string = `${process.env.OPENCODE_HOME ?? `${process.env.HOME ?? "~"}/.local/share/opencode`}/auth.json`,
): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, { type?: string; key?: string }>;
    const out: Record<string, string> = {};
    for (const [accountKey, entry] of Object.entries(parsed)) {
      if (entry !== null && typeof entry === "object" && typeof entry.key === "string") {
        out[accountKey] = redactCredential(entry.key);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Poll provider-reported quotas for every locally-authenticated account and
 * persist them into quota_snapshots so computeLimits() picks them up exactly
 * like scan-embedded ones. Opt-in only (`tokitoki poll`).
 */
const pollsInFlight = new Map<string | EventCache, Promise<PollResult>>();

const POLL_LOCK_MAX_AGE_MS = 15 * 60_000;

/**
 * Polling is commonly started by the menubar, a web request, and a manual CLI
 * command at the same time. SQLite's busy timeout protects the database, but
 * it does not stop duplicate upstream requests or last-writer-wins snapshots.
 * A small process lock gives all callers one serialized poll, while the
 * in-process promise coalesces concurrent callers to the same result.
 */
function acquirePollLock(file: string): { fd: number; file: string } | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return { fd, file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age > POLL_LOCK_MAX_AGE_MS) {
          fs.unlinkSync(file);
          continue;
        }
      } catch {
        // Another poll may have released the lock between stat/unlink.
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Hold after an HTTP 429 (Claude's usage endpoint rate-limits hard). */
const RATE_LIMIT_HOLD_MS = 5 * 60_000;
/** Floor between live requests for endpoints that rate-limit frequent pollers. */
const MIN_POLL_INTERVAL_MS: Partial<Record<string, number>> = { "claude-code": 5 * 60_000 };

const ProviderPollStateSchema = z.object({
  lastAttemptAt: z.number().optional(),
  holdUntil: z.number().optional(),
});

export type ProviderPollState = z.infer<typeof ProviderPollStateSchema>;

type PollGate = { allowed: true } | { allowed: false; until: number; reason: string };

/** Whether a provider may be polled live now, given its persisted backoff state. */
export const pollGate = (input: { provider: string; state: ProviderPollState | undefined; now: number }): PollGate => {
  const holdUntil = input.state?.holdUntil;
  if (holdUntil !== undefined && holdUntil > input.now) {
    return { allowed: false, until: holdUntil, reason: `rate limited (HTTP 429); holding until ${new Date(holdUntil).toISOString()}` };
  }
  const minInterval = MIN_POLL_INTERVAL_MS[input.provider];
  const last = input.state?.lastAttemptAt;
  if (minInterval !== undefined && last !== undefined && input.now - last < minInterval) {
    return {
      allowed: false,
      until: last + minInterval,
      reason: `polled ${Math.round((input.now - last) / 1000)}s ago; minimum interval ${minInterval / 1000}s`,
    };
  }
  return { allowed: true };
};

/**
 * Backoff state after a live attempt. Only answered requests count toward
 * the minimum interval, so a login fix is never throttled; a 429 holds for
 * at least RATE_LIMIT_HOLD_MS or the server's Retry-After, whichever is longer.
 */
export const nextPollState = (input: { outcome: PollAccountResult | string; now: number }): ProviderPollState | undefined => {
  if (typeof input.outcome !== "string") return { lastAttemptAt: input.now };
  if (!/\b429\b/.test(input.outcome)) return undefined;
  const retryAfterSeconds = Number(input.outcome.match(/retry after (\d+)s/)?.[1] ?? 0);
  return { lastAttemptAt: input.now, holdUntil: input.now + Math.max(RATE_LIMIT_HOLD_MS, retryAfterSeconds * 1000) };
};

const readPollState = (cache: EventCache, provider: string): ProviderPollState | undefined => {
  const raw = cache.metaValue(`poll-state:${provider}`);
  if (raw === undefined) return undefined;
  try {
    const parsed = ProviderPollStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Run a single-account poller behind the persisted backoff gate. A deferred
 * provider answers from its stored snapshots so card refreshes stay quiet.
 */
async function pollWithBackoff(input: {
  provider: string;
  cache: EventCache | undefined;
  now: number;
  poll: () => Promise<PollAccountResult | string>;
}): Promise<PollAccountResult | string> {
  const cache = input.cache;
  if (cache === undefined) return input.poll();
  const gate = pollGate({ provider: input.provider, state: readPollState(cache, input.provider), now: input.now });
  if (!gate.allowed) {
    const windows: PolledWindow[] = cache.latestQuotaSnapshots(input.provider, "default").map((snapshot) => ({
      windowMinutes: snapshot.windowMinutes,
      usedPct: snapshot.usedPct,
      resetsAtEpoch: snapshot.resetsAt,
      ...(snapshot.label.length > 0 ? { label: snapshot.label } : {}),
      ...(snapshot.amountUsd !== null ? { amountUsd: snapshot.amountUsd } : {}),
      ...(snapshot.model !== null ? { model: snapshot.model } : {}),
    }));
    const balance = cache.quotaAccountMeta(input.provider, "default")?.balance;
    if (windows.length === 0 && balance === undefined) return `temporarily deferred: ${gate.reason}`;
    return {
      accountKey: "default",
      harnesses: [input.provider],
      windows,
      ...(balance !== undefined ? { balance } : {}),
      inserted: 0,
      deferredUntil: new Date(gate.until).toISOString(),
    };
  }
  const outcome = await input.poll();
  const next = nextPollState({ outcome, now: input.now });
  if (next !== undefined) cache.setMetaValue(`poll-state:${input.provider}`, JSON.stringify(next));
  if (typeof outcome === "string" && next?.holdUntil !== undefined) {
    return `${outcome}; temporarily holding until ${new Date(next.holdUntil).toISOString()}`;
  }
  if (typeof outcome !== "string" && outcome.error !== undefined) return outcome.error;
  return outcome;
}

function releasePollLock(lock: { fd: number; file: string }): void {
  try { fs.closeSync(lock.fd); } catch { /* already closed */ }
  try { fs.unlinkSync(lock.file); } catch { /* another process cleaned it */ }
}

export function pollQuotas(opts: PollOptions = {}): Promise<PollResult> {
  const filename = opts.cache?.database.filename;
  const inMemory = filename === ":memory:" || filename === "";
  const key = inMemory && opts.cache !== undefined ? opts.cache
    : path.resolve(filename ?? opts.env?.TOKITOKI_POLL_LOCK ?? path.join(dataDir(), "cache.db"));
  const current = pollsInFlight.get(key);
  if (current !== undefined) return current;
  // Temporary/alternate caches must not contend with a running desktop poll.
  const lockPath = inMemory ? null : opts.cache !== undefined
    ? path.join(path.dirname(path.resolve(filename!)), "poll.lock")
    : opts.env?.TOKITOKI_POLL_LOCK ?? process.env.TOKITOKI_POLL_LOCK ?? path.join(dataDir(), "poll.lock");
  const pending = pollQuotasUnlocked(opts, lockPath).finally(() => pollsInFlight.delete(key));
  pollsInFlight.set(key, pending);
  return pending;
}

async function pollQuotasUnlocked(opts: PollOptions, lockPath: string | null): Promise<PollResult> {
  if (lockPath === null) return pollQuotasLocked(opts);
  const lock = acquirePollLock(lockPath);
  if (lock === undefined) {
    return { ok: false, reason: "another quota poll is already running", accounts: [] };
  }
  try {
    return await pollQuotasLocked(opts);
  } finally {
    releasePollLock(lock);
  }
}

interface NativeHomeBinding { accountKey: string; accountId: string; capturedAt: string }

/** Identity associations outlive quota freshness, but are valid only while an
 * active native poll and its home metadata agree. Never used to bind new usage. */
function nativeHomeBindings(cache: EventCache | undefined, home: string): NativeHomeBinding[] {
  if (cache === undefined) return [];
  const rows = cache.database.query<NativeHomeBinding, []>(`
    SELECT account_key AS accountKey, account_id AS accountId, MAX(captured_at) AS capturedAt FROM (
      SELECT * FROM active_quota_observations
      WHERE provider = 'codex' AND event_id LIKE 'poll:%' AND account_id IS NOT NULL
    ) GROUP BY account_key, account_id`).all();
  return rows.filter(row => {
    if (cache.quotaAccountMeta("codex", row.accountKey)?.codexHome !== home) return false;
    const ids = cache.quotaAccountIds("codex", row.accountKey);
    return ids.size === 1 && ids.has(row.accountId);
  });
}

function cachedNativeHomeId(cache: EventCache | undefined, home: string, now: number): string | undefined {
  const bindings = nativeHomeBindings(cache, home)
    .filter(row => Number.isFinite(Date.parse(row.capturedAt)) && Date.parse(row.capturedAt) <= now)
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const latest = bindings[0];
  if (latest === undefined) return undefined;
  const ids = new Set(bindings.filter(row => row.capturedAt === latest.capturedAt).map(row => row.accountId));
  return ids.size === 1 ? latest.accountId : undefined;
}

function clearNativeHomeBindings(cache: EventCache | undefined, home: string, keepId?: string, preserveLoginTarget = false): void {
  if (cache === undefined) return;
  for (const binding of nativeHomeBindings(cache, home)) {
    if (binding.accountId === keepId) continue;
    const meta = cache.quotaAccountMeta("codex", binding.accountKey);
    if (meta === undefined) continue;
    const { codexHome: _home, ...rest } = meta;
    cache.setQuotaAccountMeta("codex", binding.accountKey, { ...rest, ...(preserveLoginTarget ? { reauthHome: home } : {}) });
  }
}

async function pollQuotasLocked(opts: PollOptions = {}): Promise<PollResult> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const accounts: PollAccountResult[] = [];
  const reasons: string[] = [];
  const authRequiredProviders = new Set<string>();
  const providerAuthStates = new Map<string, "login-required" | "api-key-required" | "temporarily-unavailable">();
  const addReason = (provider: string, reason: string, identity?: { accountId?: string; pairs?: Array<[string, string]> }): void => {
    reasons.push(`${provider}: ${reason}`);
    const pairs = identity?.pairs ?? (provider === "codex" ? []
      : provider === "openrouter" ? [["pi", "openrouter"]]
      : provider === "opencode-go" ? [["pi", "opencode-go"], ["opencode", "opencode-go"]]
      : [[provider, "default"]]);
    const keys = provider === "codex"
      ? [`quota-poll-error:codex${identity?.accountId !== undefined ? `@${identity.accountId}` : ""}`]
      : pairs.map(([persistedProvider, accountKey]) => `quota-poll-error:${persistedProvider}@${accountKey}`);
    for (const key of keys) {
      opts.cache?.setMetaValue(key, JSON.stringify({ at: opts.now ?? Date.now(), reason }));
    }
    const state = authStateFor(provider, reason);
    if (state !== undefined) {
      for (const cardProvider of authRequiredCardProviders(provider)) {
        const previous = providerAuthStates.get(cardProvider);
        if (previous === undefined || authStatePriority(state) >= authStatePriority(previous)) {
          providerAuthStates.set(cardProvider, state);
        }
        if (state === "login-required") authRequiredProviders.add(cardProvider);
      }
    }
  };
  const capturedAtIso = new Date(opts.now ?? Date.now()).toISOString();
  const cache = opts.cache;
  let now = opts.now ?? Date.now();
  const selectedProviders = new Set(opts.providers ?? []);
  const providerEnabled = (provider: string): boolean =>
    selectedProviders.size === 0 || selectedProviders.has(provider);

  // Each native home owns its login and credential refresh store.
  if (providerEnabled("codex")) {
    const homes = opts.authPath !== undefined ? [path.dirname(opts.authPath)]
      : opts.codexHomes ?? codexHomes({ env: opts.env });
    const seen = new Set<string>();
    for (const home of [...new Set(homes.map(home => path.resolve(home.replace(/^~(?=\/|$)/, opts.env?.HOME ?? process.env.HOME ?? "~"))))]) {
      const identity = nativeCodexIdentity(home, opts.authPath);
      if (identity?.accountId !== undefined) clearNativeHomeBindings(cache, home, identity.accountId);
      const errorAccountId = identity?.accountId ?? cachedNativeHomeId(cache, home, now);
      if (identity?.accountId !== undefined && seen.has(identity.accountId)) continue;
      // An explicit missing auth fixture disables all native/keychain discovery.
      if (opts.authPath !== undefined && !fs.existsSync(opts.authPath)) {
        addReason("codex", "not logged in (no codex auth.json)", { accountId: errorAccountId }); continue;
      }
      try {
        const codex = await pollCodexQuotas({ ...opts, nativeHome: home, seenIds: seen });
        if (codex === undefined) continue;
        if (typeof codex === "string") addReason("codex", codex, { accountId: errorAccountId });
        else if (codex.accountId === undefined || !seen.has(codex.accountId)) {
          if (codex.accountId !== undefined) seen.add(codex.accountId);
          accounts.push(codex);
        }
      } catch {
        addReason("codex", "native Codex account read failed; temporarily unavailable", { accountId: errorAccountId });
      }
    }
  }

  // --- openrouter + opencode-go (pi auth store keys) ---------------------
  // opencode-go's key is shared by pi AND the opencode harness — one upstream
  // account, so its windows persist under every harness/account pair.
  const piKeys = piCredentials(opts.piAuthPath);
  const persistWindows = (windows: PolledWindow[], pairs: Array<[string, string]>, harnesses: string[]): number => {
    let inserted = 0;
    if (cache !== undefined) {
      for (const [provider, accountKey] of pairs) {
        inserted += cache.insertPolledSnapshots({
          provider,
          accountKey,
          windows,
          capturedAtIso,
          eventId: `poll:${capturedAtIso}:${provider}`,
        });
      }
    }
    void harnesses;
    return inserted;
  };

  if (providerEnabled("openrouter")) {
    const orKey = piKeys["openrouter"];
    if (orKey === undefined || orKey.length === 0) {
      addReason("openrouter", "no key in pi auth store");
    } else {
      const r = await pollOpenRouter(orKey, fetcher);
      if (r.error !== undefined) {
        addReason("openrouter", r.error);
      } else if (r.skip !== undefined) {
        addReason("openrouter", r.skip);
      } else {
        const windows = r.windows;
        if (r.balance !== undefined) storeAccountMeta({ cache, provider: "pi", accountKey: "openrouter", meta: { balance: r.balance } });
        accounts.push({
          accountKey: "openrouter",
          harnesses: ["pi"],
          windows,
          ...(r.balance !== undefined ? { balance: r.balance } : {}),
          inserted: persistWindows(windows, [["pi", "openrouter"]], ["pi"]),
        });
      }
    }
  }

  if (providerEnabled("opencode-go")) {
    const ocKey = piKeys["opencode-go"] ?? Object.values(opencodeCredentials(opts.opencodeAuthPath))[0] ?? "";
    if (ocKey === undefined || ocKey.length === 0) {
      addReason("opencode-go", "no key in pi/opencode auth stores");
    } else {
      const r = await pollOpencodeGo(ocKey, fetcher);
      if (r.error !== undefined) {
        addReason("opencode-go", r.error);
      } else {
        accounts.push({
          accountKey: "opencode-go",
          harnesses: ["pi", "opencode"],
          windows: r.windows,
          inserted: persistWindows(r.windows, [
            ["pi", "opencode-go"],
            ["opencode", "opencode-go"],
          ], ["pi", "opencode"]),
        });
      }
    }
  }

  // --- claude / copilot / cursor (each independent) ---------------------
  if (providerEnabled("claude-code")) {
    try {
      const claude = await pollWithBackoff({ provider: "claude-code", cache, now, poll: () => pollClaudeQuotas(opts, fetcher) });
      if (typeof claude === "string") addReason("claude-code", claude);
      else accounts.push(claude);
    } catch (e) {
      addReason("claude-code", String(e));
    }
  }

  if (providerEnabled("copilot")) {
    try {
      const copilot = await pollWithBackoff({ provider: "copilot", cache, now, poll: () => pollCopilotQuotas(opts, fetcher, now) });
      if (typeof copilot === "string") addReason("copilot", copilot);
      else accounts.push(copilot);
    } catch (e) {
      addReason("copilot", String(e));
    }
  }

  if (providerEnabled("cursor")) {
    try {
      const cursor = await pollWithBackoff({ provider: "cursor", cache, now, poll: () => pollCursorQuotas(opts, fetcher, now) });
      if (typeof cursor === "string") addReason("cursor", cursor);
      else accounts.push(cursor);
    } catch (e) {
      addReason("cursor", String(e));
    }
  }

  if (providerEnabled("commandcode")) {
    try {
      const commandcode = await pollWithBackoff({ provider: "commandcode", cache, now, poll: () => pollCommandCodeQuotas(opts, fetcher, now) });
      if (typeof commandcode === "string") addReason("commandcode", commandcode);
      else accounts.push(commandcode);
    } catch (e) {
      addReason("commandcode", String(e));
    }
  }

  // --- gemini / z.ai / kimi / deepseek: only when local credentials exist --
  const quotaContext: QuotaPollContext = { fetcher, cache, now, env: opts.env ?? process.env };
  const pollIfCredentialed = async (provider: string, poll: (() => Promise<PollAccountResult | string>) | undefined): Promise<void> => {
    if (!providerEnabled(provider) || poll === undefined) return;
    try {
      const outcome = await pollWithBackoff({ provider, cache, now, poll });
      if (typeof outcome === "string") addReason(provider, outcome);
      else accounts.push(outcome);
    } catch (e) {
      addReason(provider, String(e));
    }
  };
  const geminiPath = geminiCredsPath({ env: quotaContext.env, override: opts.geminiCredsPath });
  const geminiCreds = loadGeminiCreds(geminiPath);
  await pollIfCredentialed("gemini-cli", geminiCreds === undefined
    ? undefined
    : () => pollGeminiQuotas({ ctx: quotaContext, credsPath: geminiPath, creds: geminiCreds }));
  const zaiRegion = opts.zaiRegion ?? "global";
  const zaiKey = zaiApiKey({ ctx: quotaContext, region: zaiRegion, configKey: opts.providerKeys?.zai });
  await pollIfCredentialed("zai", zaiKey === undefined
    ? undefined
    : () => pollZaiQuotas({ ctx: quotaContext, key: zaiKey, region: zaiRegion }));
  const kimi = kimiCredential({ ctx: quotaContext, configKey: opts.providerKeys?.kimi, kimiHome: opts.kimiHome });
  await pollIfCredentialed("kimi", kimi === undefined ? undefined : () => pollKimiQuotas({ ctx: quotaContext, credential: kimi }));
  const deepseekKey = deepseekApiKey({ ctx: quotaContext, configKey: opts.providerKeys?.deepseek });
  await pollIfCredentialed("deepseek", deepseekKey === undefined
    ? undefined
    : () => pollDeepSeekQuotas({ ctx: quotaContext, key: deepseekKey }));

  // --- manual gateway keys (config.poll.extraKeys) -----------------------
  for (const mk of opts.manualKeys ?? []) {
    if (!providerEnabled(mk.provider)) continue;
    if (mk.provider === "openrouter") {
      const r = await pollOpenRouter(mk.key, fetcher);
      if (r.error !== undefined) {
        addReason(mk.provider, `${mk.id}: ${r.error}`, { pairs: [["openrouter", mk.id]] });
      } else if (r.skip !== undefined) {
        addReason(mk.provider, `${mk.id}: ${r.skip}`, { pairs: [["openrouter", mk.id]] });
      } else {
        if (r.balance !== undefined) storeAccountMeta({ cache, provider: "openrouter", accountKey: mk.id, meta: { balance: r.balance } });
        accounts.push({
          accountKey: mk.id,
          harnesses: ["pi"],
          windows: r.windows,
          ...(r.balance !== undefined ? { balance: r.balance } : {}),
          inserted: persistWindows(r.windows, [["openrouter", mk.id]], ["pi"]),
        });
      }
      continue;
    }
    const r = await pollOpencodeGo(mk.key, fetcher);
    if (r.error !== undefined) {
      addReason(mk.provider, `${mk.id}: ${r.error}`, { pairs: [["pi", mk.id], ["opencode", mk.id]] });
      continue;
    }
    accounts.push({
      accountKey: mk.id,
      harnesses: ["pi", "opencode"],
      windows: r.windows,
      inserted: persistWindows(r.windows, [
        ["pi", mk.id],
        ["opencode", mk.id],
      ], ["pi", "opencode"]),
    });
  }

  const ok = accounts.some((a) => (a.error === undefined && a.deferredUntil === undefined) || a.windows.length > 0 || a.balance !== undefined);
  return {
    ok,
    reason: ok ? undefined : reasons.join("; ") || "no provider returned quota data",
    accounts,
    ...(authRequiredProviders.size > 0 ? { authRequiredProviders: [...authRequiredProviders].sort() } : {}),
    ...(providerAuthStates.size > 0 ? { providerAuthStates: Object.fromEntries([...providerAuthStates.entries()].sort(([a], [b]) => a.localeCompare(b))) } : {}),
  };
}


const codexWindowScope = (minutes: number): PolledWindow["scope"] => {
  if (minutes === 300) return "session";
  if (minutes === 1440) return "daily";
  if (minutes === 10080) return "weekly";
  if (minutes >= 28 * 1440 && minutes <= 31 * 1440) return "monthly";
  return "other";
};

function nativeWindows(body: NativeRateLimits, observedAt: string): { windows: PolledWindow[]; complete: boolean; retiredWindows: Array<{ bucketId: string; windowId: string }> } {
  const buckets = new Map(Object.entries(body.rateLimitsByLimitId ?? {}));
  const defaultId = body.rateLimits.limitId ?? "codex";
  if (!buckets.has(defaultId)) buckets.set(defaultId, body.rateLimits);
  const windows: PolledWindow[] = [];
  const retiredWindows: Array<{ bucketId: string; windowId: string }> = [];
  let complete = true;
  for (const [key, bucket] of buckets) {
    const bucketId = bucket.limitId ?? key;
    // Omitted slots are unknown; explicit null retires the old slot.
    if (bucket.primary === undefined || bucket.secondary === undefined) complete = false;
    for (const windowId of ["primary", "secondary"] as const) {
      const window = bucket[windowId];
      if (window === null) retiredWindows.push({ bucketId, windowId });
      if (window == null) continue;
      const minutes = window.windowDurationMins != null && window.windowDurationMins > 0 ? window.windowDurationMins : 0;
      const reset = window.resetsAt != null && window.resetsAt > 0 && window.resetsAt < 8.64e12 ? window.resetsAt : 0;
      windows.push({
        bucketId, windowId, observedAt, windowMinutes: minutes,
        scope: codexWindowScope(minutes), usedPct: Math.min(100, Math.max(0, window.usedPercent)), resetsAtEpoch: reset,
        ...(bucket.limitName != null ? { label: bucket.limitName } : {}),
        ...(reset > 0 ? { windowEnd: new Date(reset * 1000).toISOString() } : {}),
      });
    }
  }
  return { windows, complete, retiredWindows };
}

async function pollCodexQuotas(opts: PollOptions & { nativeHome: string; seenIds: ReadonlySet<string> }): Promise<PollAccountResult | string | undefined> {
  const identity = nativeCodexIdentity(opts.nativeHome, opts.authPath);
  let response;
  try { response = await readNativeCodexAccount({ home: opts.nativeHome, command: opts.codexCommand, env: opts.env }); }
  catch (error) { return error instanceof Error ? error.message : "native Codex account read failed"; }
  const account = response.account.account;
  if (account == null || account.type !== "chatgpt") {
    clearNativeHomeBindings(opts.cache, opts.nativeHome, undefined, account == null);
    return account == null ? "not logged in (native Codex account unavailable)" : "native Codex account has no ChatGPT subscription quota";
  }
  if (response.limits === undefined) return "native Codex subscription quota unavailable";
  const body = response.limits;
  if (body.accountId != null && identity?.accountId !== undefined && body.accountId !== identity.accountId) {
    return "native quota response account identity does not match credential";
  }
  const accountId = body.accountId ?? identity?.accountId;
  // Email is display metadata, never proof that two logins share an account.
  if (accountId === undefined || accountId.length === 0) return "native Codex quota account identity unavailable";
  if (opts.seenIds.has(accountId)) return undefined;
  const accountKey = `openai:${accountId}`;
  const capturedAtIso = new Date(opts.now ?? Date.now()).toISOString();
  const { windows, complete, retiredWindows } = nativeWindows(body, capturedAtIso);
  const nativeCredits = body.rateLimits.credits;
  const credits = nativeCredits == null ? undefined : {
    hasCredits: nativeCredits.hasCredits, unlimited: nativeCredits.unlimited, balance: nativeCredits.balance ?? "0",
  };
  const rawBalance = nativeCredits?.balance;
  const balance = nativeCredits?.hasCredits === true && typeof rawBalance === "string" && rawBalance.trim() !== "" && Number.isFinite(Number(rawBalance))
    ? { currency: "credits", remaining: Number(rawBalance), available: nativeCredits.hasCredits } : undefined;
  const bankedResets = body.rateLimitResetCredits?.availableCount;
  const expiry = body.rateLimitResetCredits?.credits?.filter(credit => credit.status === "available")
    .map(credit => credit.expiresAt).filter((value): value is number => value != null && value > 0 && value < 8.64e12).sort((a, b) => a - b)[0];
  const bankedExpiresAt = bankedResets !== undefined && bankedResets > 0 && expiry !== undefined ? new Date(expiry * 1000).toISOString() : undefined;
  const email = account.email ?? identity?.email;
  const planType = body.rateLimits.planType ?? account.planType;
  const result: PollAccountResult = {
    accountKey, accountId, harnesses: ["codex"], windows, inserted: 0, planType,
    ...(email !== undefined ? { email } : {}), ...(credits !== undefined ? { credits } : {}),
    ...(balance !== undefined ? { balance } : {}),
    ...(bankedResets !== undefined ? { bankedResets } : {}), ...(bankedExpiresAt !== undefined ? { bankedExpiresAt } : {}),
  };
  if (opts.cache !== undefined) {
    clearNativeHomeBindings(opts.cache, opts.nativeHome, accountId);
    storeAccountMeta({ cache: opts.cache, provider: "codex", accountKey, meta: {
      codexHome: opts.nativeHome,
      ...(nativeCredits != null ? { credits: nativeCredits } : {}),
      ...(balance !== undefined ? { balance } : {}),
      ...(email !== undefined ? { email } : {}), plan: planType,
      ...(bankedResets !== undefined ? { bankedResets } : {}),
      ...(bankedExpiresAt !== undefined ? { bankedExpiresAt } : {}),
    } });
    result.inserted = opts.cache.insertPolledSnapshots({ provider: "codex", accountKey, accountId,
      complete, windows, retiredWindows, credits, capturedAtIso, eventId: `poll:${capturedAtIso}:codex` });
    if (!complete) opts.cache.setMetaValue(`quota-poll-error:codex@${accountId}`, JSON.stringify({
      at: Date.parse(capturedAtIso), reason: "partial quota response; omitted windows are unknown",
    }));
  }
  return result;
}
