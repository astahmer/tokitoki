import fs from "node:fs";

import type { TokitokiConfig } from "./config.ts";
import type { EventCache } from "./cache.ts";
import { accountEmailFor, accountIdentityFor } from "./accounts.ts";

/**
 * Usage/limits engine: per provider+account windows with reset schedules.
 *
 * Two data sources, in priority order:
 * 1. **Embedded** — provider-reported quota snapshots (codex `rate_limits`:
 *    used_percent, window_minutes, resets_at). Real data; shown as-is.
 * 2. **Derived** — rolling token/cost sums from the event log over calendar
 *    day/week/month windows. usedPct only when a matching plan cap exists in
 *    config ([plans]); otherwise raw numbers without a gauge.
 *
 * Reset semantics (CodexBar-style):
 * - embedded windows reset at the provider-given epoch
 * - derived day resets at next local midnight, week at next Monday 00:00
 *   local, month at the 1st 00:00 local (DST-safe via local Date arithmetic)
 */

export type WindowKind = "day" | "week" | "month";

export interface LimitWindow {
  /** "day" | "week" | "month", or "<N>min" for embedded custom windows. */
  kind: WindowKind | string;
  source: "embedded" | "derived";
  tokens: number;
  cost: number;
  requests: number;
  /** 0–100 when a denominator exists (embedded quota or plan cap), else undefined. */
  usedPct?: number;
  /** ISO-8601 instant this window resets. */
  resetsAt?: string;
  /** ISO-8601 calendar-window bounds (derived windows only). */
  windowStart?: string;
  windowEnd?: string;
}

export interface AccountLimits {
  provider: string;
  accountKey: string;
  /** User-facing label for configured synthetic accounts (never a secret). */
  label?: string;
  /** Stable provider account id when the quota source exposes one. */
  accountId?: string;
  /** Best-effort logged-in email for disambiguating multiple accounts. */
  email?: string;
  /** Plan badge when derivable (account suffix after ':' or config match). */
  planLabel?: string;
  windows: LimitWindow[];
  /** Redacted API-key / credential hint for key-based accounts (opencode…). */
  credential?: string;
  /** Other harnesses sharing this exact credential (credential-grouped cards). */
  alsoOn?: string[];
  /** Where this account's quota data comes from: polled | opencodex | manual | scan. */
  origin?: string;
  /** Most recent quota observation used to render this card. */
  observedAt?: string;
  /** Freshness of provider-reported data; never confuse stale data with zero. */
  freshness?: "fresh" | "stale" | "unknown";
  /** Banked rate-limit resets (codex credits analog). */
  bankedResets?: number;
  bankedExpiresAt?: string;
}

/** Keep the payload invariant: one visible card per provider/account identity. */
export function dedupeAccountLimits(limits: AccountLimits[]): AccountLimits[] {
  const out = new Map<string, AccountLimits>();
  const rank = (source: string) =>
    source === "embedded" || source === "polled" ? 2 : source === "derived" ? 1 : 0;
  for (const incoming of limits) {
    const id = `${incoming.provider}@${incoming.accountKey}`;
    const existing = out.get(id);
    if (existing === undefined) {
      out.set(id, incoming);
      continue;
    }
    const windows = new Map<string, LimitWindow>();
    for (const w of [...existing.windows, ...incoming.windows]) {
      const previous = windows.get(w.kind);
      if (previous === undefined || rank(w.source) >= rank(previous.source)) windows.set(w.kind, w);
    }
    out.set(id, {
      ...existing,
      ...incoming,
      accountId: incoming.accountId ?? existing.accountId,
      label: incoming.label ?? existing.label,
      email: incoming.email ?? existing.email,
      planLabel: incoming.planLabel ?? existing.planLabel,
      credential: incoming.credential ?? existing.credential,
      origin: incoming.origin ?? existing.origin,
      windows: [...windows.values()],
      alsoOn: [...new Set([...(existing.alsoOn ?? []), ...(incoming.alsoOn ?? [])])],
    });
  }
  return [...out.values()];
}

/** Local midnight following `now`. DST-safe: arithmetic on local date parts. */
export function nextLocalMidnight(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

/** Next Monday 00:00 local (ISO week start). DST-safe. */
export function nextWeekStart(now: Date): Date {
  const d = nextLocalMidnight(now);
  const daysSinceMonday = (d.getDay() + 6) % 7;
  if (daysSinceMonday === 0) return d; // already Monday midnight
  d.setDate(d.getDate() + (7 - daysSinceMonday));
  return d;
}

/** First day of next month, 00:00 local. DST-safe. */
export function nextMonthStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
}

function iso(d: Date): string {
  return d.toISOString();
}

interface UsageRow {
  tokens: number;
  cost: number;
  requests: number;
}

const ZERO: UsageRow = { tokens: 0, cost: 0, requests: 0 };

/** Map an embedded window length to a friendly kind. */
export function embeddedKind(windowMinutes: number): string {
  // 300min = the 5h session window; 1440 = calendar day. Both display as
  // "Session"/sort first via the existing kind tables.
  if (windowMinutes === 300 || windowMinutes === 1440) return "day";
  if (windowMinutes === 10080) return "week";
  if (windowMinutes === 43200) return "month";
  return `${windowMinutes}min`;
}

/**
 * Foreign quota fingerprints: window resets reported by the opencodex
 * account pool (~/.opencodex/codex-quota-cache.json), i.e. OTHER ChatGPT
 * logins that ran through the proxy on this machine. An account whose
 * embedded weekly window matches one of these is provably NOT the locally
 * authenticated codex login — never stamp our email on it.
 */
export function foreignQuotaFingerprints(provider: string): Set<string> {
  const out = new Set<string>();
  if (provider !== "codex") return out;
  try {
    const raw = JSON.parse(
      fs.readFileSync(`${process.env.HOME ?? "~"}/.opencodex/codex-quota-cache.json`, "utf8"),
    ) as { quotas?: Record<string, { weeklyResetAt?: number }> };
    for (const q of Object.values(raw.quotas ?? {})) {
      if (typeof q.weeklyResetAt === "number") out.add(`10080:${q.weeklyResetAt}`);
    }
  } catch {
    // no opencodex pool on this machine — nothing foreign known
  }
  return out;
}

/**
 * Match config [plans] caps for an account key: exact match first, then
 * trailing-`*` prefix patterns (longest pattern wins).
 */
function planCapsFor(
  plans: TokitokiConfig["plans"],
  accountKey: string,
): { monthlyCostCap?: number; monthlyRequestCap?: number } | undefined {
  if (plans === undefined) return undefined;
  const exact = plans[accountKey];
  if (exact !== undefined) return exact;
  let best: { pat: string; plan: NonNullable<typeof plans>[string] } | undefined;
  for (const [pat, plan] of Object.entries(plans)) {
    if (!pat.endsWith("*")) continue;
    if (!accountKey.startsWith(pat.slice(0, -1))) continue;
    if (best === undefined || pat.length > best.pat.length) best = { pat, plan };
  }
  return best?.plan;
}

/**
 * Compute per-account limits across all providers present in the cache.
 *
 * @param accounts explicit account list (provider, accountKey); defaults to
 *   every distinct pair seen in the event log.
 */
export function computeLimits(
  cache: EventCache,
  config: TokitokiConfig,
  now: Date = new Date(),
  accounts?: Array<{ provider: string; accountKey: string }>,
): AccountLimits[] {
  const rawList =
    accounts ?? cache.detectedAccounts().map((a) => ({ provider: a.provider, accountKey: a.accountKey }));
  const seen = new Set<string>();
  const list = rawList.filter(({ provider, accountKey }) => {
    const id = `${provider}@${accountKey}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const out: AccountLimits[] = [];

  for (const { provider, accountKey } of list) {
    const windows: LimitWindow[] = [];
    let bankedResets: number | undefined;
    let bankedExpiresAt: string | undefined;

    // --- Embedded snapshots (real data wins) -----------------------------
    const snaps = cache.latestQuotaSnapshots(provider, accountKey);
    const observedAt = snaps
      .map((s) => Date.parse(s.capturedAt))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const polledObservedAt = snaps
      .filter((s) => s.eventId?.startsWith("poll:") === true)
      .map((s) => Date.parse(s.capturedAt))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const freshness = snaps.length === 0
      ? "unknown" as const
      : polledObservedAt === undefined
        ? "fresh" as const
        : now.getTime() - polledObservedAt <= Math.max(10, (config.poll?.intervalMinutes ?? 15) * 2) * 60_000
          ? "fresh" as const
          : "stale" as const;
    const quotaAccountIds = cache.quotaAccountIds(provider, accountKey);
    const accountId = quotaAccountIds.size === 1 ? quotaAccountIds.values().next().value : undefined;
    const embeddedKinds = new Set<string>();
    for (const s of snaps) {
      // A label distinguishes same-duration windows on one account (e.g.
      // Cursor's "Cursor Models" vs "Other Models" quota buckets) — prefer
      // it over the duration-derived kind, which would otherwise collide.
      const kind = s.label.length > 0 ? s.label : embeddedKind(s.windowMinutes);
      embeddedKinds.add(kind);
      const usage =
        cache.windowUsageForAccount(
          provider,
          accountKey,
          new Date(Date.now() - s.windowMinutes * 60_000).toISOString(),
        ) ?? ZERO;
      const w: LimitWindow = {
        kind,
        source: "embedded",
        tokens: usage.tokens,
        cost: usage.cost,
        requests: usage.requests,
        usedPct: Math.max(0, Math.min(100, s.usedPct)),
        // Command Code returns resetAt=0 when a rolling window has not
        // started yet; never render that sentinel as January 1970.
        resetsAt: s.resetsAt > 0 ? new Date(s.resetsAt * 1000).toISOString() : undefined,
      };
      windows.push(w);
      if (s.creditsJson !== null) {
        try {
          const c = JSON.parse(s.creditsJson) as {
            hasCredits: boolean;
            unlimited: boolean;
            balance: string;
            expiresAt?: string;
          };
          if (c.hasCredits && !c.unlimited && Number(c.balance) > 0) {
            bankedResets = Math.floor(Number(c.balance));
            if (typeof c.expiresAt === "string" && !Number.isNaN(Date.parse(c.expiresAt))) {
              bankedExpiresAt = c.expiresAt;
            }
          }
        } catch {
          // malformed credits json — ignore
        }
      }
    }

    // --- Derived calendar windows ---------------------------------------
    const caps = planCapsFor(config.plans, accountKey);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = (() => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return d;
    })();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const cal: Array<{ kind: WindowKind; start: Date; end: Date }> = [
      { kind: "day", start: dayStart, end: nextLocalMidnight(now) },
      { kind: "week", start: weekStart, end: nextWeekStart(now) },
      { kind: "month", start: monthStart, end: nextMonthStart(now) },
    ];
    for (const c of cal) {
      if (embeddedKinds.has(c.kind)) continue; // real data already covers it
      const usage =
        cache.windowUsageForAccount(provider, accountKey, iso(c.start)) ?? ZERO;
      // Monthly cap pro-rates into shorter windows by elapsed fraction.
      const monthElapsed =
        (now.getTime() - monthStart.getTime()) /
        Math.max(1, nextMonthStart(now).getTime() - monthStart.getTime());
      let usedPct: number | undefined;
      if (c.kind === "month") {
        if (caps?.monthlyCostCap !== undefined && caps.monthlyCostCap > 0)
          usedPct = (usage.cost / caps.monthlyCostCap) * 100;
        else if (
          caps?.monthlyRequestCap !== undefined &&
          caps.monthlyRequestCap > 0 &&
          usage.cost === 0
        )
          usedPct = (usage.requests / caps.monthlyRequestCap) * 100;
      } else if (caps?.monthlyCostCap !== undefined && caps.monthlyCostCap > 0 && usage.cost > 0) {
        // Pace gauge: >100 means burning faster than a rate that would exactly
        // exhaust the monthly cap by reset. 100 = exactly on pace. Zero-cost
        // windows carry no pace signal.
        const elapsedFrac = Math.max(
          0.001,
          c.kind === "day"
            ? (now.getTime() - dayStart.getTime()) / 86_400_000
            : (now.getTime() - weekStart.getTime()) / (7 * 86_400_000),
        );
        usedPct = (usage.cost / (caps.monthlyCostCap * elapsedFrac)) * 100;
      }
      windows.push({
        kind: c.kind,
        source: "derived",
        tokens: usage.tokens,
        cost: usage.cost,
        requests: usage.requests,
        usedPct: usedPct !== undefined ? Math.min(999, Math.round(usedPct * 10) / 10) : undefined,
        resetsAt: iso(c.end),
        windowStart: iso(c.start),
        windowEnd: iso(c.end),
      });
    }

    // Plan badge from codex-style account suffix ("codex:plus" → "Plus")
    const colon = accountKey.lastIndexOf(":");
    const planLabel =
      colon > 0 ? accountKey.slice(colon + 1).charAt(0).toUpperCase() + accountKey.slice(colon + 2) : undefined;

    const order: Record<string, number> = { day: 0, week: 1, month: 2 };
    windows.sort((a, b) => (order[a.kind] ?? 99) - (order[b.kind] ?? 99));

    // Email attribution (the CodexBar trick): the provider-level email comes
    // from the CURRENT auth store, so it may not belong to every account
    // sharing this machine. Keep it only when the account is provably the
    // local login — its embedded windows match polled quota fingerprints —
    // or when nothing contradicts it (never polled + no foreign pool data).
    const pairs = snaps.map((s) => `${Math.round(s.windowMinutes)}:${Math.round(s.resetsAt)}`);
    const own = cache.ownLoginFingerprints(provider);
    const foreign = foreignQuotaFingerprints(provider);
    let email = accountEmailFor(provider) ?? undefined;
    if (provider === "codex") {
      const localId = accountIdentityFor(provider)?.accountId;
      const snapshotIds = cache.quotaAccountIds(provider, accountKey);
      // Account IDs are authoritative. A card with polled identity data that
      // belongs to another login must never inherit the active JWT email.
      if (snapshotIds.size > 0 && (localId === undefined || !snapshotIds.has(localId))) {
        email = undefined;
      } else if (snapshotIds.size === 0 && (!pairs.some((p) => own.has(p)) && !(own.size === 0 && !pairs.some((p) => foreign.has(p))))) {
        // Compatibility for pre-account_id snapshots; this path disappears
        // naturally after the next poll writes stable identity metadata.
        email = undefined;
      }
    } else if (!pairs.some((p) => own.has(p)) && !(own.size === 0 && !pairs.some((p) => foreign.has(p)))) {
      email = undefined;
    }

    out.push({
      provider,
      accountKey,
      ...(accountId !== undefined ? { accountId } : {}),
      email,
      planLabel,
      windows,
      bankedResets,
      bankedExpiresAt,
      ...(observedAt !== undefined ? { observedAt: new Date(observedAt).toISOString() } : {}),
      freshness,
    });
  }
  return out;
}

/**
 * Display-level alias merge. Same provider + same stable account id + same
 * embedded-quota signature = the same real account seen through different
 * extraction eras. When a provider has no stable id, the account key is part
 * of the fallback identity. Reset timestamps alone are deliberately not an
 * identity: two real logins can have identical windows, and merging them
 * would leak the active login's email onto the other card.
 *
 * Accounts WITHOUT embedded windows are never merged: provider-level email
 * attribution comes from the CURRENT auth store, so it cannot distinguish
 * multiple logins on the same machine and must not drive grouping.
 */
export function mergeAliasLimits(limits: AccountLimits[]): AccountLimits[] {
  const out: AccountLimits[] = [];
  const bySignature = new Map<string, AccountLimits[]>();
  for (const l of limits) {
    const sig = quotaSignature(l);
    if (sig === null) {
      out.push(l);
      continue;
    }
    const identity = l.accountId !== undefined ? `id:${l.accountId}` : `legacy:${l.accountKey}`;
    const key = `${l.provider}|${identity}|${sig}`;
    const g = bySignature.get(key);
    if (g === undefined) bySignature.set(key, [l]);
    else g.push(l);
  }

  for (const group of bySignature.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    // Identity prefers the entry whose accountKey carries plan info
    // (e.g. "openai:plus" beats bare "codex").
    const withPlan = group.find((l) => l.accountKey.includes(":")) ?? group[0]!;
    const byKind = new Map<string, LimitWindow>();
    const ordered = [...group].sort(
      (a, b) =>
        Number(a.windows.some((w) => w.source === "embedded")) -
        Number(b.windows.some((w) => w.source === "embedded")),
    );
    for (const l of ordered) {
      for (const w of l.windows) {
        const existing = byKind.get(w.kind);
        if (existing === undefined || (existing.source !== "embedded" && w.source === "embedded")) {
          byKind.set(w.kind, w);
        }
      }
    }
    out.push({
      ...withPlan,
      windows: [...byKind.values()],
      bankedResets: group.map((l) => l.bankedResets).find((b) => b !== undefined),
      bankedExpiresAt: group.map((l) => l.bankedExpiresAt).find((b) => b !== undefined),
    });
  }
  // Provider-level emails come from the CURRENT auth store, so they are only
  // trustworthy for accounts that carry embedded quota data (their sessions
  // provably belong to the logged-in user). For sibling accounts without
  // embedded data the email may belong to a different login — drop it rather
  // than show a wrong attribution.
  const providersWithEmbedded = new Set(
    out.filter((l) => l.windows.some((w) => w.source === "embedded")).map((l) => l.provider),
  );
  for (const l of out) {
    if (!providersWithEmbedded.has(l.provider)) continue;
    if (!l.windows.some((w) => w.source === "embedded")) l.email = undefined;
  }
  return out;
}

/**
 * Quota identity signature from EMBEDDED windows only: sorted
 * "minutes@resetsAt" pairs, null when the account has none (estimates /
 * derived gauges carry no provider-reported resets).
 */
function quotaSignature(l: AccountLimits): string | null {
  const parts = l.windows
    .filter((w) => w.source === "embedded")
    .map((w) => {
      const minutes = windowMinutesOf(w);
      return minutes === null ? null : `${minutes}@${w.resetsAt ?? "?"}`;
    })
    .filter((x): x is string => x !== null);
  if (parts.length === 0) return null;
  return [...new Set(parts)].sort().join("|");
}

/**
 * Group accounts that share the SAME redacted credential (e.g. pi and
 * opencode both reading the opencode-go gateway key): one card per real
 * account instead of N near-identical ones. The primary entry is the one
 * with the most recorded tokens; other harnesses ride along in `alsoOn`.
 *
 * Window merge per kind: embedded/polled data beats derived; two derived
 * windows SUM (the harnesses index disjoint session stores, so no double
 * counting) with resets taken from the later side.
 */
export function groupBySharedCredential(limits: AccountLimits[]): AccountLimits[] {
  const groups = new Map<string, AccountLimits[]>();
  const unkeyed: AccountLimits[] = [];
  for (const l of limits) {
    if (l.credential === undefined || l.credential.length === 0) {
      unkeyed.push(l);
      continue;
    }
    const g = groups.get(l.credential);
    if (g === undefined) groups.set(l.credential, [l]);
    else g.push(l);
  }

  const totalTokens = (l: AccountLimits) => l.windows.reduce((s, w) => s + w.tokens, 0);
  const out: AccountLimits[] = [...unkeyed];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    const sorted = [...group].sort((a, b) => totalTokens(b) - totalTokens(a));
    const primary = sorted[0]!;
    const byKind = new Map<string, LimitWindow>();
    for (const l of sorted) {
      for (const w of l.windows) {
        const existing = byKind.get(w.kind);
        if (existing === undefined) {
          byKind.set(w.kind, { ...w });
          continue;
        }
        const rank = (src: string) => (src === "embedded" || src === "polled" ? 1 : 0);
        if (rank(w.source) > rank(existing.source)) {
          byKind.set(w.kind, { ...w });
        } else if (rank(w.source) === rank(existing.source) && existing.source === "derived") {
          byKind.set(w.kind, {
            ...existing,
            tokens: existing.tokens + w.tokens,
            cost: existing.cost + w.cost,
            requests: existing.requests + w.requests,
            resetsAt: [existing.resetsAt, w.resetsAt].sort().at(-1) ?? existing.resetsAt,
            windowStart: [existing.windowStart, w.windowStart].sort()[0],
            windowEnd: [existing.windowEnd, w.windowEnd].sort().at(-1),
          });
        }
      }
    }
    out.push({
      ...primary,
      windows: [...byKind.values()],
      alsoOn: sorted.slice(1).map((l) => l.provider),
      email: undefined,
    });
  }
  return out.sort((a, b) => totalTokens(b) - totalTokens(a));
}

function windowMinutesOf(w: LimitWindow): number | null {
  if (w.windowStart === undefined || w.windowEnd === undefined) return kindToMinutes(w.kind);
  const ms = Date.parse(w.windowEnd) - Date.parse(w.windowStart);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : kindToMinutes(w.kind);
}

function kindToMinutes(kind: string): number | null {
  switch (kind) {
    case "session":
    case "day": return 300;
    case "week": return 10_080;
    case "month": return 43_200;
    default: return null;
  }
}

function bankedOf(l: AccountLimits): number | undefined {
  return l.bankedResets;
}
