import fs from "node:fs";
import path from "node:path";
import { codexHomes } from "./codex-homes.ts";
import type { TokitokiConfig } from "./config.ts";

import { z } from "zod";

/**
 * Best-effort resolution of the logged-in account email per provider, read
 * live from each harness's local store. No emails are persisted anywhere:
 * they are resolved on demand for `--show-email` / the web dashboard.
 *
 * Known sources (verified against real stores):
 * - claude-code: `$CLAUDE_CONFIG_DIR/../.claude.json` (default ~/.claude.json)
 *   → oauthAccount.emailAddress
 * - codex: `$CODEX_HOME/auth.json` (default ~/.codex/auth.json) → JWT
 *   id_token payload → email
 * - cursor: `$CURSOR_DIR/cli-config.json` (default ~/.cursor) → authInfo.email.
 *   Cursor keeps no usage store, but its CLI config does carry the login, so
 *   cursor-routed harnesses (T3 Code's `cursor` backend) can show a name.
 * - pi / opencode: API-key auth only — no email in any local store.
 */

export function accountEmailFor(providerId: string): string | null {
  switch (providerId) {
    case "claude-code":
      return claudeEmail();
    case "codex":
      return codexEmail();
    case "cursor":
      return cursorEmail();
    default:
      return null;
  }
}

export interface AccountIdentity {
  email?: string;
  accountId?: string;
}

/** Resolve the stable identity behind a local provider login. */
export function accountIdentityFor(providerId: string): AccountIdentity | null {
  if (providerId !== "codex") return null;
  return nativeCodexIdentity(codexHomes()[0]!);
}

/** Read identity claims only; credential refresh belongs to the native harness. */
const nativeAuthSchema = z.object({
  tokens: z.object({ id_token: z.string().optional(), account_id: z.string().optional() }).nullish(),
});
const nativeClaimsSchema = z.object({
  email: z.unknown().optional(),
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.unknown().optional() }).nullish(),
  "https://api.openai.com/profile": z.object({ email: z.unknown().optional() }).nullish(),
});
export function nativeCodexIdentity(home: string, explicitAuthPath?: string): AccountIdentity | null {
  try {
    const auth = nativeAuthSchema.parse(JSON.parse(fs.readFileSync(explicitAuthPath ?? path.join(home, "auth.json"), "utf8")));
    let payload: z.infer<typeof nativeClaimsSchema> = {};
    const part = auth.tokens?.id_token?.split(".")[1];
    if (part !== undefined) {
      try { payload = nativeClaimsSchema.parse(JSON.parse(Buffer.from(part, "base64url").toString("utf8"))); } catch { /* account_id can stand alone */ }
    }
    const claims = payload["https://api.openai.com/auth"];
    const profile = payload["https://api.openai.com/profile"];
    const rawEmail = payload.email ?? profile?.email;
    const email = typeof rawEmail === "string" && rawEmail.includes("@") ? rawEmail : undefined;
    const rawId = auth.tokens?.account_id ?? claims?.chatgpt_account_id;
    const accountId = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;
    return accountId === undefined && email === undefined ? null : { ...(email ? { email } : {}), ...(accountId ? { accountId } : {}) };
  } catch { return null; }
}

/** Stable ids from native homes, for joining scanner aliases. Never joins by email. */
export function nativeCodexIdentities(options: { config?: TokitokiConfig } = {}): Map<string, AccountIdentity> {
  const identities = new Map<string, AccountIdentity>();
  for (const home of codexHomes(options)) {
    const identity = nativeCodexIdentity(home);
    if (identity?.accountId !== undefined) identities.set(identity.accountId, identity);
  }
  return identities;
}

const ClaudeOauthAccountSchema = z.object({
  oauthAccount: z.object({
    accountUuid: z.string().optional(),
    emailAddress: z.string().optional(),
    organizationUuid: z.string().optional(),
    organizationName: z.string().optional(),
  }),
});

export interface ClaudeOauthAccount {
  email: string;
  accountUuid?: string;
  organizationUuid?: string;
  organizationName?: string;
}

/**
 * The login Claude Code records in .claude.json (oauthAccount). An explicit
 * path (tests) disables the CLAUDE_CONFIG_DIR / home lookup.
 */
export const claudeOauthAccount = (explicitPath?: string): ClaudeOauthAccount | null => {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const hasConfigDir = configDir !== undefined && configDir.length > 0;
  const candidates = explicitPath !== undefined
    ? [explicitPath]
    : [
      hasConfigDir ? `${configDir}/.claude.json` : `${process.env.HOME ?? "~"}/.claude.json`,
      ...(hasConfigDir ? [`${configDir}/../.claude.json`] : []),
    ];
  for (const file of candidates) {
    try {
      const parsed = ClaudeOauthAccountSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!parsed.success) continue;
      const oauth = parsed.data.oauthAccount;
      const email = oauth.emailAddress;
      if (email === undefined || !email.includes("@")) continue;
      return {
        email,
        ...(oauth.accountUuid !== undefined ? { accountUuid: oauth.accountUuid } : {}),
        ...(oauth.organizationUuid !== undefined ? { organizationUuid: oauth.organizationUuid } : {}),
        ...(oauth.organizationName !== undefined ? { organizationName: oauth.organizationName } : {}),
      };
    } catch {
      // try next candidate
    }
  }
  return null;
};

function claudeEmail(): string | null {
  return claudeOauthAccount()?.email ?? null;
}

function codexEmail(): string | null {
  return accountIdentityFor("codex")?.email ?? null;
}

function cursorEmail(): string | null {
  const dir = process.env.CURSOR_DIR ?? `${process.env.HOME ?? "~"}/.cursor`;
  try {
    const parsed = JSON.parse(fs.readFileSync(`${dir}/cli-config.json`, "utf8")) as {
      authInfo?: { email?: unknown };
    };
    const email = parsed.authInfo?.email;
    return typeof email === "string" && email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

/**
 * Emails keyed by accountKey for display joins. An entry is included only
 * when unambiguous: either a single provider owns the key, or all providers
 * sharing the key resolve to the same address.
 */
export function accountEmailMap(
  keys: Iterable<string>,
  providersByKey: Map<string, Iterable<string>>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys) {
    const emails = new Set<string>();
    for (const provider of providersByKey.get(key) ?? []) {
      const email = accountEmailFor(provider);
      if (email !== null) emails.add(email);
    }
    if (emails.size === 1) {
      const email = emails.values().next().value;
      if (email !== undefined) out.set(key, email);
    }
  }
  return out;
}
