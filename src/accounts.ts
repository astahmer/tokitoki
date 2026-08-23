import fs from "node:fs";

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
 * - pi / opencode: API-key auth only — no email in any local store.
 */

export function accountEmailFor(providerId: string): string | null {
  switch (providerId) {
    case "claude-code":
      return claudeEmail();
    case "codex":
      return codexEmail();
    default:
      return null;
  }
}

function claudeEmail(): string | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const candidates = [
    configDir !== undefined && configDir.length > 0
      ? `${configDir}/.claude.json`
      : `${process.env.HOME ?? "~"}/.claude.json`,
    ...(configDir !== undefined && configDir.length > 0
      ? [`${configDir}/../.claude.json`]
      : []),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const oauth = parsed.oauthAccount as Record<string, unknown> | undefined;
      const email = oauth?.emailAddress;
      if (typeof email === "string" && email.includes("@")) return email;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function codexEmail(): string | null {
  const home = process.env.CODEX_HOME ?? `${process.env.HOME ?? "~"}/.codex`;
  try {
    const auth = JSON.parse(fs.readFileSync(`${home}/auth.json`, "utf8")) as {
      tokens?: { id_token?: string };
    };
    const jwt = auth.tokens?.id_token;
    if (typeof jwt !== "string") return null;
    const payloadPart = jwt.split(".")[1];
    if (payloadPart === undefined) return null;
    const b64 = payloadPart.replaceAll("-", "+").replaceAll("_", "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    const email = payload.email;
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
