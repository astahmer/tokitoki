import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { Database } from "bun:sqlite";

import type { EventCache } from "./cache.ts";
import { cursorIdeDir } from "./providers/cursor.ts";
import { dataDir } from "./store.ts";

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
 * The menubar runs this only when the user enables background polling. Tokens
 * are never logged; refreshed tokens stay in-memory for the current process.
 */

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
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
  /** Distinguishes same-duration windows on one account (e.g. Cursor's "Cursor Models" vs "Other Models"). */
  label?: string;
  /** Real USD spend for open-ended windows (e.g. Cursor's On-Demand) — displayed instead of usedPct when present. */
  amountUsd?: number;
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
  inserted: number;
  error?: string;
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
  return /not logged in|auth(?:entication)? (?:not found|required)|oauth[_ -]?token|unauthorized|token refresh failed|refresh token|\b(?:401|403)\b/i.test(reason);
}

function authStateFor(provider: string, reason: string): "login-required" | "api-key-required" | "temporarily-unavailable" | undefined {
  const keyProvider = provider === "openrouter" || provider === "opencode-go";
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
  /** Absolute path to a pi auth.json fixture (tests). Default ~/.pi/agent/auth.json. */
  piAuthPath?: string;
  /** Absolute path to a claude .credentials.json fixture (tests). Default ~/.claude/.credentials.json; keychain fallback when absent. */
  claudeCredentialsPath?: string;
  /** Absolute path to a github-copilot apps.json/hosts.json fixture (tests). Default ~/.config/github-copilot/{apps,hosts}.json. */
  copilotAuthPath?: string;
  /** Absolute path to a cursor cli-auth.json fixture (tests). Default ~/.cursor/cli-auth.json. */
  cursorAuthPath?: string;
  /** Absolute path to a cursor state.vscdb fixture (tests). Default platform IDE data dir. */
  cursorStateVscdbPath?: string;
  /** Absolute path to an opencodex codex-quota-cache.json fixture (tests). Default ~/.opencodex/codex-quota-cache.json. */
  opencodexCachePath?: string;
  /** Absolute path to opencodex's pooled account credentials (tests). */
  opencodexAccountsPath?: string;
  /** Absolute path to an opencode auth.json fixture (tests). Default ~/.local/share/opencode/auth.json. */
  opencodeAuthPath?: string;
  /** Absolute path to Command Code auth.json (tests). Default ~/.commandcode/auth.json. */
  commandcodeAuthPath?: string;
  /** Manually registered provider keys polled as synthetic accounts. */
  manualKeys?: Array<{ id: string; provider: "opencode-go" | "openrouter"; key: string }>;
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
  rate_limit?: {
    primary_window?: WhamWindow;
    secondary_window?: WhamWindow;
    credits?: Record<string, unknown>;
  };
}

function parsePolledCredits(raw: unknown): { hasCredits: boolean; unlimited: boolean; balance: string; expiresAt?: string } | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const hasCredits = value.has_credits === true || value.hasCredits === true;
  const unlimited = value.unlimited === true;
  const balance = typeof value.balance === "string" || typeof value.balance === "number" ? String(value.balance) : "0";
  const expiry = value.expires_at ?? value.expiration_date ?? value.expiresAt ?? value.expirationDate;
  const expiresAt = typeof expiry === "number" && Number.isFinite(expiry)
    ? new Date(expiry * 1000).toISOString()
    : typeof expiry === "string" && !Number.isNaN(Date.parse(expiry))
      ? new Date(expiry).toISOString()
      : undefined;
  return { hasCredits, unlimited, balance, ...(expiresAt !== undefined ? { expiresAt } : {}) };
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
    // Every other provider parser clamps usedPct to [0,100] before pushing
    // a PolledWindow — this one didn't, so a reported burst-overage percent
    // (>100) flowed straight into the immediate CLI output while limits.ts
    // clamps on read, making the same window show two different numbers
    // depending which view you looked at.
    out.push({ windowMinutes: Math.round(seconds / 60), usedPct: Math.max(0, Math.min(100, usedPct)), resetsAtEpoch });
  }
  return out;
}

async function refreshToken(
  refreshToken: string,
  fetcher: typeof fetch,
): Promise<{ ok: boolean; accessToken?: string; refreshToken?: string }> {
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
    const json = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (json.access_token === undefined || json.access_token.length === 0) return { ok: false };
    return {
      ok: true,
      accessToken: json.access_token,
      // If OpenAI's endpoint also rotates refresh tokens (the same
      // realistic assumption already confirmed for Anthropic's — see
      // persistClaudeCredentials), capture it so we can save it back.
      ...(json.refresh_token !== undefined && json.refresh_token.length > 0
        ? { refreshToken: json.refresh_token }
        : {}),
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Write a rotated Codex access/refresh token back to ~/.codex/auth.json,
 * merging into the existing tokens object (never dropping sibling fields
 * like id_token/account_id, or the top-level auth_mode/OPENAI_API_KEY keys)
 * so the codex CLI's own next read still sees a valid, current session.
 * Best-effort and silent — same rationale as persistClaudeCredentials: a
 * failed persist here must never fail the poll itself.
 */
function persistCodexCredentials(opts: PollOptions, updated: { accessToken: string; refreshToken?: string }): void {
  if (updated.refreshToken === undefined) return; // nothing rotated — nothing to persist
  const filePath = authPath(opts);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const tokens = (parsed.tokens ?? {}) as Record<string, unknown>;
    const merged = {
      ...parsed,
      tokens: { ...tokens, access_token: updated.accessToken, refresh_token: updated.refreshToken },
      last_refresh: new Date().toISOString(),
    };
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, filePath); // same filesystem — atomic, no partial-write window
  } catch {
    // best-effort — see doc comment above
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

/** Codex keeps optional/banked reset inventory in a supplemental endpoint,
 * rather than embedding it in every wham/usage response. */
async function fetchCodexResetCredits(
  accessToken: string,
  accountId: string,
  fetcher: typeof fetch,
): Promise<{ hasCredits: boolean; unlimited: boolean; balance: string; expiresAt?: string } | undefined> {
  try {
    const res = await fetcher(CODEX_RESET_CREDITS_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "openai-beta": "codex-1",
        originator: "Codex Desktop",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
    });
    if (!res.ok) return undefined;
    const body = await res.json() as { credits?: Array<Record<string, unknown>>; available_count?: number };
    const available = (body.credits ?? []).filter((credit) => credit.status === "available");
    const count = typeof body.available_count === "number" ? body.available_count : available.length;
    if (count <= 0) return { hasCredits: false, unlimited: false, balance: "0" };
    const expiries = available
      .map((credit) => parsePolledCredits({ has_credits: true, balance: "1", expires_at: credit.expires_at })?.expiresAt)
      .filter((value): value is string => value !== undefined)
      .sort();
    return {
      hasCredits: true,
      unlimited: false,
      balance: String(count),
      ...(expiries[0] !== undefined ? { expiresAt: expiries[0] } : {}),
    };
  } catch {
    return undefined;
  }
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
      return `unauthorized (${res.status}) and token refresh failed${renewed.error !== undefined ? `: ${renewed.error}` : ""}`;
    }
    persistClaudeCredentials(opts, { accessToken: renewed.accessToken, refreshToken: renewed.refreshToken, expiresAt: renewed.expiresAt });
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

  const resetMs = typeof body.quota_reset_date === "string" ? Date.parse(body.quota_reset_date) : NaN;
  const resetsAtEpoch = Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : 0;
  // Copilot exposes one rolling quota bucket, but its reset timestamp changes
  // every poll. Keep the storage key stable or every poll becomes a new
  // `NNNNMin` row in the popover (and old rows never age out of the view).
  const windowMinutes = 43_200;

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
interface CursorUsageResult {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  planUsage?: { autoPercentUsed?: number; apiPercentUsed?: number };
  spendLimitUsage?: { pooledUsed?: number; pooledLimit?: number };
}

async function pollCursorQuotas(opts: PollOptions, fetcher: typeof fetch, now: number): Promise<PollAccountResult | string> {
  const token = cursorAccessToken(opts);
  if (token === null) return "cursor auth not found (no cursor-agent CLI login and no Cursor IDE login)";

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

  const root = body as CursorUsageResult;
  const startMs = Number(root.billingCycleStart);
  const endMs = Number(root.billingCycleEnd);
  const hasCycle = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const resetsAtEpoch = hasCycle ? Math.round(endMs / 1000) : 0;
  const windowMinutes = hasCycle ? Math.max(60, Math.round((endMs - startMs) / 60_000)) : 43_200;

  const windows: PolledWindow[] = [];
  const pushPct = (label: string, pct: number | undefined): void => {
    if (typeof pct !== "number" || !Number.isFinite(pct)) return;
    windows.push({ windowMinutes, usedPct: Math.max(0, Math.min(100, pct)), resetsAtEpoch, label });
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
    });
  }
  if (windows.length === 0) return "cursor response shape unrecognized";

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

export interface OpencodexAccountIdentity {
  email?: string;
  accountId?: string;
}

/** Read stable identities for opencodex's pooled ChatGPT accounts. */
export function opencodexAccountIdentities(
  path: string = `${process.env.HOME ?? "~"}/.opencodex/codex-accounts.json`,
): Record<string, OpencodexAccountIdentity> {
  const out: Record<string, OpencodexAccountIdentity> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, {
      credential?: { accessToken?: string; access?: string; email?: string; chatgptAccountId?: string };
    }>;
    for (const [id, account] of Object.entries(parsed)) {
      const direct = account.credential?.email;
      const token = account.credential?.accessToken ?? account.credential?.access;
      const claims = typeof token === "string" ? decodeJwtPayload(token) : undefined;
      const auth = claims?.["https://api.openai.com/auth"];
      const authId = auth !== null && typeof auth === "object"
        ? (auth as Record<string, unknown>).chatgpt_account_id
        : undefined;
      const profile = claims?.["https://api.openai.com/profile"];
      const email = profile !== null && typeof profile === "object"
        ? (profile as Record<string, unknown>).email
        : undefined;
      const resolvedEmail = typeof direct === "string" && direct.includes("@")
        ? direct
        : typeof email === "string" && email.includes("@") ? email : undefined;
      const resolvedId = typeof account.credential?.chatgptAccountId === "string" && account.credential.chatgptAccountId.length > 0
        ? account.credential.chatgptAccountId
        : typeof authId === "string" && authId.length > 0 ? authId : undefined;
      if (resolvedEmail !== undefined || resolvedId !== undefined) {
        out[id] = {
          ...(resolvedEmail !== undefined ? { email: resolvedEmail } : {}),
          ...(resolvedId !== undefined ? { accountId: resolvedId } : {}),
        };
      }
    }
  } catch {
    // opencodex is optional
  }
  return out;
}

/** Backwards-compatible email-only view for callers that do not need IDs. */
export function opencodexAccountEmails(
  path: string = `${process.env.HOME ?? "~"}/.opencodex/codex-accounts.json`,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(opencodexAccountIdentities(path))
      .filter(([, identity]) => identity.email !== undefined)
      .map(([id, identity]) => [id, identity.email!]),
  );
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
let pollInFlight: Promise<PollResult> | undefined;

const POLL_LOCK_MAX_AGE_MS = 15 * 60_000;

/**
 * Polling is commonly started by the menubar, a web request, and a manual CLI
 * command at the same time. SQLite's busy timeout protects the database, but
 * it does not stop duplicate upstream requests or last-writer-wins snapshots.
 * A small process lock gives all callers one serialized poll, while the
 * in-process promise coalesces concurrent callers to the same result.
 */
function acquirePollLock(): { fd: number; file: string } | undefined {
  const file = process.env.TOKITOKI_POLL_LOCK ?? path.join(dataDir(), "poll.lock");
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

function releasePollLock(lock: { fd: number; file: string }): void {
  try { fs.closeSync(lock.fd); } catch { /* already closed */ }
  try { fs.unlinkSync(lock.file); } catch { /* another process cleaned it */ }
}

export function pollQuotas(opts: PollOptions = {}): Promise<PollResult> {
  if (pollInFlight !== undefined) return pollInFlight;
  pollInFlight = pollQuotasUnlocked(opts).finally(() => {
    pollInFlight = undefined;
  });
  return pollInFlight;
}

async function pollQuotasUnlocked(opts: PollOptions = {}): Promise<PollResult> {
  const lock = acquirePollLock();
  if (lock === undefined) {
    return { ok: false, reason: "another quota poll is already running", accounts: [] };
  }
  try {
    return await pollQuotasLocked(opts);
  } finally {
    releasePollLock(lock);
  }
}

async function pollQuotasLocked(opts: PollOptions = {}): Promise<PollResult> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const accounts: PollAccountResult[] = [];
  const reasons: string[] = [];
  const authRequiredProviders = new Set<string>();
  const providerAuthStates = new Map<string, "login-required" | "api-key-required" | "temporarily-unavailable">();
  const addReason = (provider: string, reason: string): void => {
    reasons.push(`${provider}: ${reason}`);
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

  // --- codex (ChatGPT wham/usage, OAuth) --------------------------------
  if (providerEnabled("codex")) {
    try {
      const codex = await pollCodexQuotas(opts);
      if (typeof codex === "string") addReason("codex", codex);
      else accounts.push(codex);
    } catch (e) {
      addReason("codex", String(e));
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
        // OpenRouter's /key endpoint has no reset timestamp, only a period
        // string — fall back to "now" so a real reset isn't rendered as a
        // sentinel 0 ("no reset"/epoch). Compute the patched windows once
        // and persist that SAME array; persisting the raw, unpatched
        // r.windows here previously stored resets_at=0 while the returned
        // account object showed the patched value — the poll's own
        // immediate output disagreed with what was actually saved.
        const windows = r.windows.map((w) => ({ ...w, resetsAtEpoch: w.resetsAtEpoch || Math.round(now / 1000) }));
        accounts.push({
          accountKey: "openrouter",
          harnesses: ["pi"],
          windows,
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
      const claude = await pollClaudeQuotas(opts, fetcher);
      if (typeof claude === "string") addReason("claude-code", claude);
      else accounts.push(claude);
    } catch (e) {
      addReason("claude-code", String(e));
    }
  }

  if (providerEnabled("copilot")) {
    try {
      const copilot = await pollCopilotQuotas(opts, fetcher, now);
      if (typeof copilot === "string") addReason("copilot", copilot);
      else accounts.push(copilot);
    } catch (e) {
      addReason("copilot", String(e));
    }
  }

  if (providerEnabled("cursor")) {
    try {
      const cursor = await pollCursorQuotas(opts, fetcher, now);
      if (typeof cursor === "string") addReason("cursor", cursor);
      else accounts.push(cursor);
    } catch (e) {
      addReason("cursor", String(e));
    }
  }

  if (providerEnabled("commandcode")) {
    try {
      const commandcode = await pollCommandCodeQuotas(opts, fetcher, now);
      if (typeof commandcode === "string") addReason("commandcode", commandcode);
      else accounts.push(commandcode);
    } catch (e) {
      addReason("commandcode", String(e));
    }
  }

  // --- manual gateway keys (config.poll.extraKeys) -----------------------
  for (const mk of opts.manualKeys ?? []) {
    if (!providerEnabled(mk.provider)) continue;
    if (mk.provider === "openrouter") {
      const r = await pollOpenRouter(mk.key, fetcher);
      if (r.error !== undefined) {
        addReason(mk.provider, `${mk.id}: ${r.error}`);
      } else if (r.skip !== undefined) {
        addReason(mk.provider, `${mk.id}: ${r.skip}`);
      } else {
        accounts.push({
          accountKey: mk.id,
          harnesses: ["pi"],
          windows: r.windows,
          inserted: persistWindows(r.windows, [["openrouter", mk.id]], ["pi"]),
        });
      }
      continue;
    }
    const r = await pollOpencodeGo(mk.key, fetcher);
    if (r.error !== undefined) {
      addReason(mk.provider, `${mk.id}: ${r.error}`);
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
  const poolIdentities = opencodexAccountIdentities(opts.opencodexAccountsPath);
  const poolCredentials = opencodexAccountCredentials(opts.opencodexAccountsPath);
  const freshPoolKeys = new Set<string>();
  // The quota JSON is a lossy compatibility cache. When opencodex has the
  // OAuth credential, ask WHAM directly so a legacy/misclassified cache field
  // cannot turn the 5-hour window into a weekly card (or retain stale values).
  if (providerEnabled("codex")) {
    for (const [poolKey, credential] of Object.entries(poolCredentials)) {
      const poolAccountId = poolIdentities[poolKey]?.accountId ?? credential.accountId;
      if (poolAccountId !== undefined && poolAccountId === ownCodex?.accountId) continue;
      if (credential.accessToken === undefined || poolAccountId === undefined) continue;
      const accountKey = poolKey === "__main__" ? "codex" : `codex:${poolKey}`;
      const result = await pollCodexCredential(
        opts,
        {
          tokens: {
            access_token: credential.accessToken,
            ...(credential.refreshToken !== undefined ? { refresh_token: credential.refreshToken } : {}),
            account_id: poolAccountId,
          },
        },
        accountKey,
        poolIdentities[poolKey]?.email ?? credential.email,
        `:opencodex:${poolKey}`,
      );
      if (typeof result === "string") {
        addReason("codex", `${accountKey}: ${result}`);
      } else if (result.windows.length > 0) {
        accounts.push({ ...result, harnesses: ["opencodex"] });
        freshPoolKeys.add(poolKey);
      }
    }
  }
  const seenResets = new Set<number>();
  const seenPoolIds = new Set<string>();
  for (const [poolKey, q] of providerEnabled("codex") ? Object.entries(pooled) : []) {
    if (freshPoolKeys.has(poolKey)) continue;
    if (typeof q.weeklyPercent !== "number" || typeof q.weeklyResetAt !== "number") continue;
    const weeklyResetAt = q.weeklyResetAt;
    const weeklyPercent = q.weeklyPercent;
    const poolAccountId = poolIdentities[poolKey]?.accountId ?? (poolKey === "__main__" ? ownCodex?.accountId : undefined);
    // The live OAuth poll is the canonical source for the active login.
    // Never materialize the same account a second time through __main__.
    if (poolAccountId !== undefined && poolAccountId === ownCodex?.accountId) continue;
    // Reset epochs are quota data, not identity. Two real accounts can reset
    // at the same instant, so stable pool account IDs always win. Legacy
    // pool entries without IDs retain the old reset-based mirror guard.
    if (poolAccountId !== undefined) {
      if (seenPoolIds.has(poolAccountId)) continue;
      seenPoolIds.add(poolAccountId);
    } else {
      if (seenResets.has(weeklyResetAt)) continue;
      if ([...ownWeeklyResets].some((reset) => Math.abs(reset - weeklyResetAt) <= 15 * 60)) continue;
      seenResets.add(weeklyResetAt);
    }
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
        const resetMatches = snapshots.some((w) =>
          (w.windowMinutes === 10_080 && w.resetsAt === weeklyResetAt) ||
          (w.windowMinutes === shortMinutes && w.resetsAt === q.shortResetAt)
        );
        if (!resetMatches) continue;
        // Same "reset epochs are quota data, not identity" principle as
        // above: a reset-time collision alone isn't proof of identity. If
        // this existing card already has a KNOWN stable account id and it's
        // not this pool entry's id, it's a different account that merely
        // resets at the same second — don't merge. Legacy entries with no
        // known id yet keep the old reset-based match (nothing better to go on).
        if (poolAccountId !== undefined) {
          const knownIds = cache.quotaAccountIds("codex", existing.accountKey);
          if (knownIds.size > 0 && !knownIds.has(poolAccountId)) continue;
        }
        accountKey = existing.accountKey;
        break;
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
      ...(poolAccountId !== undefined
        ? { accountId: poolAccountId }
        : {}),
      harnesses: ["opencodex"],
      windows,
      inserted: cache?.insertPolledSnapshots({
        provider: "codex",
        accountKey,
        accountId: poolAccountId,
        windows,
        capturedAtIso,
        eventId: `poll:${capturedAtIso}:opencodex:${poolKey}`,
      }) ?? 0,
    });
  }

  const ok = accounts.some((a) => a.windows.length > 0);
  return {
    ok,
    reason: ok ? undefined : reasons.join("; ") || "no provider returned quota data",
    accounts,
    ...(authRequiredProviders.size > 0 ? { authRequiredProviders: [...authRequiredProviders].sort() } : {}),
    ...(providerAuthStates.size > 0 ? { providerAuthStates: Object.fromEntries([...providerAuthStates.entries()].sort(([a], [b]) => a.localeCompare(b))) } : {}),
  };
}

/** codex wham/usage poll. Returns the account result, or a reason string. */
async function pollCodexQuotas(opts: PollOptions): Promise<PollAccountResult | string> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const auth = loadAuth(opts);
  const token = auth?.tokens?.access_token;
  if (auth === null || token === undefined || token.length === 0) {
    return "not logged in (no codex auth.json / no access token)";
  }

  return pollCodexCredential(opts, auth);
}

/** Poll one OAuth credential, including pooled accounts managed by opencodex. */
async function pollCodexCredential(
  opts: PollOptions,
  auth: CodexAuth,
  accountKeyOverride?: string,
  fallbackEmail?: string,
  eventIdSuffix?: string,
): Promise<PollAccountResult | string> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const token = auth.tokens?.access_token;
  if (token === undefined || token.length === 0) {
    return "not logged in (no access token in credential)";
  }

  const claims = decodeJwtPayload(auth.tokens?.id_token ?? "");
  const authInfo = (claims?.["https://api.openai.com/auth"] ?? {}) as {
    chatgpt_account_id?: string;
  };
  const accountId = auth.tokens?.account_id ?? authInfo.chatgpt_account_id ?? "";
  if (accountId.length === 0) {
    return "no chatgpt account id in auth store";
  }
  const profile = (claims?.["https://api.openai.com/profile"] ?? {}) as { email?: unknown };
  const email = typeof claims?.email === "string"
    ? claims.email
    : typeof profile.email === "string" ? profile.email : fallbackEmail;

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
    persistCodexCredentials(opts, { accessToken: renewed.accessToken!, refreshToken: renewed.refreshToken });
    access = renewed.accessToken!;
    res = await fetchUsage(access, accountId, fetcher);
  }
  if (res.status < 200 || res.status >= 300 || res.body === null) {
    return `usage endpoint returned HTTP ${res.status}`;
  }

  const planType = typeof res.body.plan_type === "string" ? res.body.plan_type : "unknown";
  // Scan-era account keys are "<model_provider>:<plan_type>"; the ChatGPT
  // login maps to model_provider "openai".
  const accountKey = accountKeyOverride ?? `openai:${planType}`;
  const windows = parseWindows(res.body.rate_limit);
  let credits = parsePolledCredits(res.body.rate_limit?.credits);
  if (credits === undefined || !credits.hasCredits || Number(credits.balance) <= 0) {
    credits = await fetchCodexResetCredits(access, accountId, fetcher) ?? credits;
  }

  const result: PollAccountResult = {
    accountKey,
    accountId,
    ...(email !== undefined ? { email } : {}),
    planType,
    windows,
    ...(credits !== undefined ? { credits } : {}),
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
      accountId,
      windows,
      credits,
      capturedAtIso,
      eventId: `poll:${capturedAtIso}${eventIdSuffix ?? ""}`,
    });
  }
  return result;
}

interface OpencodexAccountCredential {
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  email?: string;
}

/** Read OAuth credentials for pooled ChatGPT accounts without exposing tokens. */
function opencodexAccountCredentials(
  path: string = `${process.env.HOME ?? "~"}/.opencodex/codex-accounts.json`,
): Record<string, OpencodexAccountCredential> {
  const out: Record<string, OpencodexAccountCredential> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, {
      credential?: { accessToken?: unknown; refreshToken?: unknown; chatgptAccountId?: unknown; email?: unknown };
    }>;
    for (const [id, account] of Object.entries(parsed)) {
      const credential = account.credential;
      if (credential === undefined || typeof credential !== "object" || credential === null) continue;
      out[id] = {
        ...(typeof credential.accessToken === "string" ? { accessToken: credential.accessToken } : {}),
        ...(typeof credential.refreshToken === "string" ? { refreshToken: credential.refreshToken } : {}),
        ...(typeof credential.chatgptAccountId === "string" ? { accountId: credential.chatgptAccountId } : {}),
        ...(typeof credential.email === "string" ? { email: credential.email } : {}),
      };
    }
  } catch {
    // opencodex is optional
  }
  return out;
}
