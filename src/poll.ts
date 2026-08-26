import fs from "node:fs";
import { execFileSync } from "node:child_process";

import type { EventCache } from "./cache.ts";

/**
 * CodexBar-style opt-in quota polling: reuse the OAuth access token stored by
 * the codex CLI to fetch provider-reported rate-limit windows directly.
 *
 * Endpoint + shape reverse-engineered from CodexBar's OSS implementation
 * (github.com/steipete/CodexBar, CodexOAuthUsageFetcher.swift):
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization: Bearer <access_token>
 *   ChatGPT-Account-Id: <account_id>
 *   Accept: application/json
 *
 * Never automatic: only `tokitoki poll` runs this. Tokens are never logged;
 * refreshed tokens stay in-memory for the current process only.
 */

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token";
/** codex CLI's public OAuth client id (same value Codex CLI itself ships). */
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** OpenRouter key metadata: limit/limit_remaining when a credit limit is set. */
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
/** OpenCode Go plan meters — provider-reported percent + reset per window. */
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** Claude Code OAuth usage endpoint + refresh config (openusage ClaudeAuthStore). */
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** GitHub Copilot internal usage endpoint — `token` scheme, not Bearer. */
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
/** Cursor dashboard Connect endpoints. */
const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
/** Command Code billing/usage API (the CLI's own live /usage data source). */
const COMMANDCODE_API_URL = "https://api.commandcode.ai";
/** opencodex pooled-account quota cache (~/.opencodex). */
const OPENCODEX_QUOTA_CACHE = `${process.env.HOME ?? "~"}/.opencodex/codex-quota-cache.json`;
const USER_AGENT = "tokitoki";

export interface PolledWindow {
  /** minutes; mirrors quota_snapshots.window_minutes */
  windowMinutes: number;
  usedPct: number;
  resetsAtEpoch: number;
}

export interface PollAccountResult {
  accountKey: string;
  /** Harnesses sharing this polled account (opencode-go spans pi+opencode). */
  harnesses?: string[];
  email?: string;
  planType?: string;
  windows: PolledWindow[];
  inserted: number;
  error?: string;
}

export interface PollResult {
  ok: boolean;
  reason?: string;
  accounts: PollAccountResult[];
}

export interface PollOptions {
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Absolute path to a codex auth.json fixture (tests). */
  authPath?: string;
  /** Absolute path to a pi auth.json fixture (tests). Default ~/.pi/agent/auth.json. */
  piAuthPath?: string;
  /** Absolute path to a claude .credentials.json fixture (tests). Default ~/.claude/.credentials.json; keychain fallback when absent. */
  claudeCredentialsPath?: string;
  /** Absolute path to a github-copilot apps.json/hosts.json fixture (tests). Default ~/.config/github-copilot/{apps,hosts}.json. */
  copilotAuthPath?: string;
  /** Absolute path to a cursor cli-auth.json fixture (tests). Default ~/.cursor/cli-auth.json. */
  cursorAuthPath?: string;
  /** Absolute path to an opencodex codex-quota-cache.json fixture (tests). Default ~/.opencodex/codex-quota-cache.json. */
  opencodexCachePath?: string;
  /** Absolute path to an opencode auth.json fixture (tests). Default ~/.local/share/opencode/auth.json. */
  opencodeAuthPath?: string;
  /** Absolute path to Command Code auth.json (tests). Default ~/.commandcode/auth.json. */
  commandcodeAuthPath?: string;
  /** Manually registered gateway keys (config.poll.extraKeys) polled as synthetic accounts. */
  manualKeys?: Array<{ id: string; provider: "opencode-go"; key: string }>;
  /** EventCache instance (tests use a temp db). Default: open the real one. */
  cache?: EventCache;
  now?: number;
}

interface CodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

function authPath(opts: PollOptions): string {
  if (opts.authPath !== undefined) return opts.authPath;
  const home = process.env.CODEX_HOME ?? `${process.env.HOME ?? "~"}/.codex`;
  return `${home}/auth.json`;
}

function loadAuth(opts: PollOptions): CodexAuth | null {
  try {
    const raw = fs.readFileSync(authPath(opts), "utf8");
    const parsed = JSON.parse(raw) as CodexAuth;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (part === undefined) return null;
    const b64 = part.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

interface WhamWindow {
  used_percent?: number;
  reset_at?: number;
  resets_at?: number;
  limit_window_seconds?: number;
}

interface WhamUsageResponse {
  account_id?: string;
  accountId?: string;
  plan_type?: string;
  rate_limit?: { primary_window?: WhamWindow; secondary_window?: WhamWindow };
}

function parseWindows(rateLimit: WhamUsageResponse["rate_limit"]): PolledWindow[] {
  const out: PolledWindow[] = [];
  for (const w of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    // JSON null passes an undefined-check; both must be skipped.
    if (w === null || w === undefined || typeof w !== "object") continue;
    const usedPct = w.used_percent;
    // wham/usage spells it `reset_at`; other shapes use `resets_at`.
    const resetsAtEpoch = w.reset_at ?? w.resets_at;
    const seconds = w.limit_window_seconds;
    if (
      typeof usedPct !== "number" ||
      typeof resetsAtEpoch !== "number" ||
      typeof seconds !== "number" ||
      seconds <= 0
    )
      continue;
    out.push({ windowMinutes: Math.round(seconds / 60), usedPct, resetsAtEpoch });
  }
  return out;
}

async function refreshToken(
  refreshToken: string,
  fetcher: typeof fetch,
): Promise<{ ok: boolean; accessToken?: string }> {
  try {
    const res = await fetcher(TOKEN_REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as { access_token?: string };
    return json.access_token !== undefined && json.access_token.length > 0
      ? { ok: true, accessToken: json.access_token }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function fetchUsage(
  accessToken: string,
  accountId: string,
  fetcher: typeof fetch,
): Promise<{ status: number; body: WhamUsageResponse | null }> {
  const res = await fetcher(WHAM_USAGE_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });
  let body: WhamUsageResponse | null = null;
  try {
    body = (await res.json()) as WhamUsageResponse;
  } catch {
    // non-JSON error body — status code carries the signal
  }
  return { status: res.status, body };
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

/** OpenRouter /key → one window when a credit limit is configured (else skip). */
async function pollOpenRouter(key: string, fetcher: typeof fetch): Promise<{ windows: PolledWindow[]; skip?: string; error?: string }> {
  let body: OpenRouterKeyResponse;
  try {
    const res = await fetcher(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
    if (!res.ok) return { windows: [], error: `HTTP ${res.status}` };
    body = (await res.json()) as OpenRouterKeyResponse;
  } catch (e) {
    return { windows: [], error: String(e) };
  }
  const d = body.data ?? {};
  if (typeof d.limit !== "number" || d.limit <= 0 || typeof d.limit_remaining !== "number") {
    return { windows: [], skip: "no credit limit configured on the key" };
  }
  const used = Math.max(0, d.limit - Math.max(0, d.limit_remaining));
  const pct = Math.min(100, (used / d.limit) * 100);
  const minutes = d.limit_reset === "daily" ? 1440 : d.limit_reset === "weekly" ? 10_080 : 43_200;
  return { windows: [{ windowMinutes: minutes, usedPct: pct, resetsAtEpoch: 0 }] };
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
export function loadClaudeCredentials(opts: PollOptions): { accessToken?: string; refreshToken?: string } | null {
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
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string } };
    const oauth = parsed.claudeAiOauth;
    if (oauth === undefined || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) return null;
    return oauth;
  } catch {
    return null;
  }
}

async function refreshClaudeToken(refreshToken: string, fetcher: typeof fetch): Promise<{ ok: boolean; accessToken?: string }> {
  try {
    const res = await fetcher(CLAUDE_REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID }),
    });
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as { access_token?: string };
    return json.access_token !== undefined && json.access_token.length > 0
      ? { ok: true, accessToken: json.access_token }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

interface ClaudeUsageWindow {
  utilization?: number;
  resets_at?: string;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
}

/** claude-code OAuth usage → Session(300min) + Weekly(10080min) percent meters. */
async function pollClaudeQuotas(opts: PollOptions, fetcher: typeof fetch): Promise<PollAccountResult | string> {
  const creds = loadClaudeCredentials(opts);
  if (creds === null || creds.accessToken === undefined || creds.accessToken.length === 0) {
    return "not logged in (~/.claude/.credentials.json and keychain both empty)";
  }

  const fetchOnce = async (accessToken: string) => {
    try {
      const res = await fetcher(CLAUDE_USAGE_URL, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "claude-code/2.1.69",
        },
      });
      let body: ClaudeUsageResponse | null = null;
      try {
        body = (await res.json()) as ClaudeUsageResponse;
      } catch {
        // non-JSON error body
      }
      return { status: res.status, body };
    } catch {
      return { status: 0, body: null };
    }
  };

  let res = await fetchOnce(creds.accessToken);
  if (res.status === 401 || res.status === 403) {
    if (creds.refreshToken === undefined || creds.refreshToken.length === 0) {
      return `unauthorized (${res.status}) and no refresh token available`;
    }
    const renewed = await refreshClaudeToken(creds.refreshToken, fetcher);
    if (!renewed.ok || renewed.accessToken === undefined) {
      return `unauthorized (${res.status}) and token refresh failed`;
    }
    res = await fetchOnce(renewed.accessToken);
  }
  if (res.status < 200 || res.status >= 300 || res.body === null) {
    return `usage endpoint returned HTTP ${res.status}`;
  }

  // Body windows carry {utilization: 0-100, resets_at: ISO} (openusage mapper).
  const spec: Array<[ClaudeUsageWindow | undefined, number]> = [
    [res.body.five_hour, 300],
    [res.body.seven_day, 10_080],
  ];
  const windows: PolledWindow[] = [];
  for (const [w, minutes] of spec) {
    if (w === undefined || typeof w.utilization !== "number") continue;
    const resets = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    windows.push({
      windowMinutes: minutes,
      usedPct: Math.max(0, Math.min(100, w.utilization)),
      resetsAtEpoch: Number.isFinite(resets) ? Math.round(resets / 1000) : 0,
    });
  }
  if (windows.length === 0) {
    return { accountKey: "default", harnesses: ["claude-code"], windows, inserted: 0, error: "no usable windows in response" };
  }
  const capturedAtIso = new Date(opts.now ?? Date.now()).toISOString();
  const inserted = opts.cache?.insertPolledSnapshots({
    provider: "claude-code",
    accountKey: "default",
    windows,
    capturedAtIso,
    eventId: `poll:${capturedAtIso}:claude`,
  }) ?? 0;
  return { accountKey: "default", harnesses: ["claude-code"], windows, inserted };
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
  data?: { currentPeriodEnd?: string };
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
    windows.push({
      windowMinutes: 43_200,
      usedPct: Math.max(0, Math.min(100, (spent / monthCap) * 100)),
      resetsAtEpoch: Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : 0,
    });
  }
  if (windows.length === 0) return { accountKey: "default", windows, inserted: 0, error: "no usable usage windows in response" };
  const capturedAtIso = new Date(now).toISOString();
  const inserted = opts.cache?.insertPolledSnapshots({
    provider: "commandcode",
    accountKey: "default",
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
  };
}

/** Copilot internal/user → one window per real quota_snapshots bucket. */
async function pollCopilotQuotas(opts: PollOptions, fetcher: typeof fetch, now: number): Promise<PollAccountResult | string> {
  const token = copilotToken(opts.copilotAuthPath);
  if (token === null) return "no GitHub oauth_token in ~/.config/github-copilot/{apps,hosts}.json";

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

  const resetMs = typeof body.quota_reset_date === "string" ? Date.parse(body.quota_reset_date) : NaN;
  const resetsAtEpoch = Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : 0;
  // Minutes until reset clamps to a sane window length for the snapshot row.
  const windowMinutes =
    Number.isFinite(resetMs)
      ? Math.max(60, Math.min(43_200, Math.round((resetMs - now) / 60_000)))
      : 43_200;

  const windows: PolledWindow[] = [];
  for (const [label, snapshot] of Object.entries(body.quota_snapshots ?? {})) {
    if (snapshot === null || typeof snapshot !== "object") continue;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const entitlement = num(snapshot["entitlement"]);
    const remaining = num(snapshot["remaining"]);
    const percentRemaining = num(snapshot["percent_remaining"]);
    // Unlimited (-1 sentinels / explicit flag) or zero entitlement = no real meter.
    if (snapshot["unlimited"] === true || entitlement === -1 || remaining === -1 || entitlement === 0) continue;
    let usedPct: number | null = null;
    if (percentRemaining !== null) usedPct = Math.max(0, Math.min(100, 100 - percentRemaining));
    else if (entitlement !== null && entitlement > 0 && remaining !== null) {
      usedPct = Math.max(0, Math.min(100, 100 - (remaining / entitlement) * 100));
    }
    if (usedPct === null) continue;
    windows.push({ windowMinutes, usedPct, resetsAtEpoch });
    void label; // bucket names (chat/completions/...) are not stable enough to surface
    break; // one representative meter per account keeps the card compact
  }
  if (windows.length === 0) {
    return { accountKey: "default", windows, inserted: 0, error: "no bounded quota buckets in response" };
  }
  const capturedAtIso = new Date(now).toISOString();
  const inserted = opts.cache?.insertPolledSnapshots({
    provider: "copilot",
    accountKey: "default",
    windows,
    capturedAtIso,
    eventId: `poll:${capturedAtIso}:copilot`,
  }) ?? 0;
  return { accountKey: "default", harnesses: ["copilot"], windows, inserted };
}

/** Best-effort cursor access token from ~/.cursor/cli-auth.json (sqlite/keychain unsupported). */
function cursorAccessToken(opts: PollOptions): string | null {
  const path = opts.cursorAuthPath ?? `${process.env.HOME ?? "~"}/.cursor/cli-auth.json`;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as { accessToken?: string; api_key?: string };
    const t = parsed.accessToken ?? parsed.api_key;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

interface CursorUsageResult {
  usagePercent?: number;
  nextResetTimestampUtc?: string;
}

/** Cursor dashboard Connect POST → billing-period percent when recognizable. */
async function pollCursorQuotas(opts: PollOptions, fetcher: typeof fetch, now: number): Promise<PollAccountResult | string> {
  const token = cursorAccessToken(opts);
  if (token === null) return "cursor auth not found (cli-auth.json missing; sqlite/keychain unsupported)";

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

  // Defensive shape walk — the Connect payload nests the billing period under
  // either {billingPeriodInfo:{...}} or a bare usage object.
  const root = (body ?? {}) as Record<string, unknown>;
  const candidates: Array<Record<string, unknown>> = [];
  if (typeof root.billingPeriodInfo === "object" && root.billingPeriodInfo !== null) {
    candidates.push(root.billingPeriodInfo as Record<string, unknown>);
  }
  if (typeof root.usage === "object" && root.usage !== null) {
    candidates.push(root.usage as Record<string, unknown>);
  }
  candidates.push(root);
  for (const c of candidates) {
    const pct = typeof c.usagePercent === "number" ? c.usagePercent : typeof c.percentUsed === "number" ? c.percentUsed : null;
    if (pct === null) continue;
    const resetRaw = typeof c.nextResetTimestampUtc === "string" ? c.nextResetTimestampUtc : undefined;
    const resetMs = resetRaw !== undefined ? Date.parse(resetRaw) : NaN;
    const resetsAtEpoch = Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : 0;
    const windowMinutes = Number.isFinite(resetMs)
      ? Math.max(60, Math.min(43_200, Math.round((resetMs - now) / 60_000)))
      : 43_200;
    const windows = [{ windowMinutes, usedPct: Math.max(0, Math.min(100, pct)), resetsAtEpoch }];
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
  return "cursor response shape unrecognized";
}

/** Read email identities for opencodex's pooled ChatGPT accounts. */
export function opencodexAccountEmails(
  path: string = `${process.env.HOME ?? "~"}/.opencodex/codex-accounts.json`,
): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, {
      credential?: { accessToken?: string; access?: string; email?: string };
    }>;
    for (const [id, account] of Object.entries(parsed)) {
      const direct = account.credential?.email;
      if (typeof direct === "string" && direct.includes("@")) {
        out[id] = direct;
        continue;
      }
      const token = account.credential?.accessToken ?? account.credential?.access;
      const profile = typeof token === "string" ? decodeJwtPayload(token)?.["https://api.openai.com/profile"] : undefined;
      const email = profile !== null && typeof profile === "object"
        ? (profile as Record<string, unknown>).email
        : undefined;
      if (typeof email === "string" && email.includes("@")) out[id] = email;
    }
  } catch {
    // opencodex is optional
  }
  return out;
}

/** opencodex pooled-account quotas → {key: {weeklyPercent, weeklyResetAt}}. */
export function opencodexQuotas(path: string = OPENCODEX_QUOTA_CACHE): Record<string, {
  weeklyPercent?: number;
  weeklyResetAt?: number;
  shortPercent?: number;
  shortResetAt?: number;
  shortWindowSeconds?: number;
}> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as {
      quotas?: Record<string, {
        weeklyPercent?: number;
        weeklyResetAt?: number;
        shortPercent?: number;
        shortResetAt?: number;
        shortWindowSeconds?: number;
      }>;
    };
    return parsed.quotas ?? {};
  } catch {
    return {}; // not installed / not started — fine, nothing to do
  }
}

/** Redact a credential for display: first 4 + … + last 4 of the full value. */
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
export async function pollQuotas(opts: PollOptions = {}): Promise<PollResult> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const accounts: PollAccountResult[] = [];
  const reasons: string[] = [];
  const capturedAtIso = new Date(opts.now ?? Date.now()).toISOString();
  const cache = opts.cache;
  let now = opts.now ?? Date.now();

  // --- codex (ChatGPT wham/usage, OAuth) --------------------------------
  try {
    const codex = await pollCodexQuotas(opts);
    if (typeof codex === "string") reasons.push(`codex: ${codex}`);
    else accounts.push(codex);
  } catch (e) {
    reasons.push(`codex: ${String(e)}`);
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

  const orKey = piKeys["openrouter"];
  if (orKey === undefined || orKey.length === 0) {
    reasons.push("openrouter: no key in pi auth store");
  } else {
    const r = await pollOpenRouter(orKey, fetcher);
    if (r.error !== undefined) {
      reasons.push(`openrouter: ${r.error}`);
    } else if (r.skip !== undefined) {
      reasons.push(`openrouter: ${r.skip}`);
    } else {
      accounts.push({
        accountKey: "openrouter",
        harnesses: ["pi"],
        windows: r.windows.map((w) => ({ ...w, resetsAtEpoch: w.resetsAtEpoch || Math.round(now / 1000) })),
        inserted: persistWindows(r.windows, [["pi", "openrouter"]], ["pi"]),
      });
    }
  }

  const ocKey = piKeys["opencode-go"] ?? Object.values(opencodeCredentials(opts.opencodeAuthPath))[0] ?? "";
  if (ocKey === undefined || ocKey.length === 0) {
    reasons.push("opencode-go: no key in pi/opencode auth stores");
  } else {
    const r = await pollOpencodeGo(ocKey, fetcher);
    if (r.error !== undefined) {
      reasons.push(`opencode-go: ${r.error}`);
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

  // --- claude / copilot / cursor (each independent) ---------------------
  try {
    const claude = await pollClaudeQuotas(opts, fetcher);
    if (typeof claude === "string") reasons.push(`claude-code: ${claude}`);
    else accounts.push(claude);
  } catch (e) {
    reasons.push(`claude-code: ${String(e)}`);
  }

  try {
    const copilot = await pollCopilotQuotas(opts, fetcher, now);
    if (typeof copilot === "string") reasons.push(`copilot: ${copilot}`);
    else accounts.push(copilot);
  } catch (e) {
    reasons.push(`copilot: ${String(e)}`);
  }

  try {
    const cursor = await pollCursorQuotas(opts, fetcher, now);
    if (typeof cursor === "string") reasons.push(`cursor: ${cursor}`);
    else accounts.push(cursor);
  } catch (e) {
    reasons.push(`cursor: ${String(e)}`);
  }

  try {
    const commandcode = await pollCommandCodeQuotas(opts, fetcher, now);
    if (typeof commandcode === "string") reasons.push(`commandcode: ${commandcode}`);
    else accounts.push(commandcode);
  } catch (e) {
    reasons.push(`commandcode: ${String(e)}`);
  }

  // --- manual gateway keys (config.poll.extraKeys) -----------------------
  for (const mk of opts.manualKeys ?? []) {
    const r = await pollOpencodeGo(mk.key, fetcher);
    if (r.error !== undefined) {
      reasons.push(`${mk.id}: ${r.error}`);
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

  // --- opencodex pool (also when codex itself yielded a fresh login) ------
  // The pool can contain another ChatGPT login (for example a work account)
  // that is not represented by ~/.codex/auth.json. The old fallback skipped
  // the pool whenever the personal login succeeded, leaving that account
  // stale forever.
  const ownCodex = accounts.find((a) => a.accountKey.startsWith("openai:") && a.windows.length > 0);
  const ownWeeklyResets = new Set(
    ownCodex?.windows.filter((w) => w.windowMinutes === 10_080).map((w) => w.resetsAtEpoch) ?? [],
  );
  const pooled = opencodexQuotas(opts.opencodexCachePath);
  const seenResets = new Set<number>();
  for (const [poolKey, q] of Object.entries(pooled)) {
    if (typeof q.weeklyPercent !== "number" || typeof q.weeklyResetAt !== "number") continue;
    const weeklyResetAt = q.weeklyResetAt;
    const weeklyPercent = q.weeklyPercent;
    // Identical reset epochs are the same login mirrored by multiple pool
    // aliases. Also suppress the pool's __main__ mirror of the live OAuth
    // account when the reset is within the provider's normal clock skew.
    if (seenResets.has(weeklyResetAt)) continue;
    if ([...ownWeeklyResets].some((reset) => Math.abs(reset - weeklyResetAt) <= 15 * 60)) continue;
    seenResets.add(weeklyResetAt);
    let accountKey = poolKey === "__main__" ? "codex" : `codex:${poolKey}`;
    // Reuse the scan-era account key when its embedded weekly reset matches
    // this pool entry. This is what keeps an existing work-account card
    // (usually `codex`) fresh instead of creating an opaque new card.
    if (cache !== undefined) {
      const shortMinutes = typeof q.shortWindowSeconds === "number" && q.shortWindowSeconds > 0
        ? Math.round(q.shortWindowSeconds / 60)
        : 300;
      for (const existing of cache.detectedAccounts().filter((a) => a.provider === "codex")) {
        const snapshots = cache.latestQuotaSnapshots("codex", existing.accountKey);
        if (snapshots.some((w) =>
          (w.windowMinutes === 10_080 && w.resetsAt === weeklyResetAt) ||
          (w.windowMinutes === shortMinutes && w.resetsAt === q.shortResetAt)
        )) {
          accountKey = existing.accountKey;
          break;
        }
      }
    }
    const windows: PolledWindow[] = [{
      windowMinutes: 10_080,
      usedPct: Math.max(0, Math.min(100, weeklyPercent)),
      resetsAtEpoch: weeklyResetAt,
    }];
    if (typeof q.shortPercent === "number" && typeof q.shortResetAt === "number") {
      windows.unshift({
        windowMinutes: typeof q.shortWindowSeconds === "number" && q.shortWindowSeconds > 0
          ? Math.round(q.shortWindowSeconds / 60)
          : 300,
        usedPct: Math.max(0, Math.min(100, q.shortPercent)),
        resetsAtEpoch: q.shortResetAt,
      });
    }
    accounts.push({
      accountKey,
      harnesses: ["opencodex"],
      windows,
      inserted: cache?.insertPolledSnapshots({
        provider: "codex",
        accountKey,
        windows,
        capturedAtIso,
        eventId: `poll:${capturedAtIso}:opencodex:${poolKey}`,
      }) ?? 0,
    });
  }

  const ok = accounts.some((a) => a.windows.length > 0);
  return { ok, reason: ok ? undefined : reasons.join("; ") || "no provider returned quota data", accounts };
}

/** codex wham/usage poll. Returns the account result, or a reason string. */
async function pollCodexQuotas(opts: PollOptions): Promise<PollAccountResult | string> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const auth = loadAuth(opts);
  const token = auth?.tokens?.access_token;
  if (auth === null || token === undefined || token.length === 0) {
    return "not logged in (no codex auth.json / no access token)";
  }

  const claims = decodeJwtPayload(auth.tokens?.id_token ?? "");
  const authInfo = (claims?.["https://api.openai.com/auth"] ?? {}) as {
    chatgpt_account_id?: string;
  };
  const accountId = auth.tokens?.account_id ?? authInfo.chatgpt_account_id ?? "";
  if (accountId.length === 0) {
    return "no chatgpt account id in auth store";
  }
  const email = typeof claims?.email === "string" ? claims.email : undefined;

  let access = token;
  let res = await fetchUsage(access, accountId, fetcher);
  if (res.status === 401 || res.status === 403) {
    const refresh = auth.tokens?.refresh_token;
    if (refresh === undefined || refresh.length === 0) {
      return `unauthorized (${res.status}) and no refresh token available`;
    }
    const renewed = await refreshToken(refresh, fetcher);
    if (!renewed.ok) {
      return `unauthorized (${res.status}) and token refresh failed`;
    }
    access = renewed.accessToken!;
    res = await fetchUsage(access, accountId, fetcher);
  }
  if (res.status < 200 || res.status >= 300 || res.body === null) {
    return `usage endpoint returned HTTP ${res.status}`;
  }

  const planType = typeof res.body.plan_type === "string" ? res.body.plan_type : "unknown";
  // Scan-era account keys are "<model_provider>:<plan_type>"; the ChatGPT
  // login maps to model_provider "openai".
  const accountKey = `openai:${planType}`;
  const windows = parseWindows(res.body.rate_limit);

  const result: PollAccountResult = {
    accountKey,
    ...(email !== undefined ? { email } : {}),
    planType,
    windows,
    inserted: 0,
  };
  if (windows.length === 0) {
    result.error = "response carried no usable rate-limit windows";
  }

  const capturedAtIso = new Date(opts.now ?? Date.now()).toISOString();
  const cache = opts.cache;
  if (cache !== undefined && windows.length > 0) {
    result.inserted = cache.insertPolledSnapshots({
      provider: "codex",
      accountKey,
      windows,
      capturedAtIso,
      eventId: `poll:${capturedAtIso}`,
    });
  }
  return result;
}
