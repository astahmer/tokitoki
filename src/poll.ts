import fs from "node:fs";

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
const USER_AGENT = "tokitoki";

export interface PolledWindow {
  /** minutes; mirrors quota_snapshots.window_minutes */
  windowMinutes: number;
  usedPct: number;
  resetsAtEpoch: number;
}

export interface PollAccountResult {
  accountKey: string;
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
  const auth = loadAuth(opts);
  const token = auth?.tokens?.access_token;
  if (auth === null || token === undefined || token.length === 0) {
    return { ok: false, reason: "not logged in (no codex auth.json / no access token)", accounts: [] };
  }

  const claims = decodeJwtPayload(auth.tokens?.id_token ?? "");
  const authInfo = (claims?.["https://api.openai.com/auth"] ?? {}) as {
    chatgpt_account_id?: string;
  };
  const accountId =
    auth.tokens?.account_id ?? authInfo.chatgpt_account_id ?? "";
  if (accountId.length === 0) {
    return { ok: false, reason: "no chatgpt account id in auth store", accounts: [] };
  }
  const email = typeof claims?.email === "string" ? claims.email : undefined;

  let access = token;
  let res = await fetchUsage(access, accountId, fetcher);
  if (res.status === 401 || res.status === 403) {
    const refresh = auth.tokens?.refresh_token;
    if (refresh === undefined || refresh.length === 0) {
      return { ok: false, reason: `unauthorized (${res.status}) and no refresh token available`, accounts: [] };
    }
    const renewed = await refreshToken(refresh, fetcher);
    if (!renewed.ok) {
      return { ok: false, reason: `unauthorized (${res.status}) and token refresh failed`, accounts: [] };
    }
    access = renewed.accessToken!;
    res = await fetchUsage(access, accountId, fetcher);
  }
  if (res.status < 200 || res.status >= 300 || res.body === null) {
    return { ok: false, reason: `usage endpoint returned HTTP ${res.status}`, accounts: [] };
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

  return { ok: true, accounts: [result] };
}
