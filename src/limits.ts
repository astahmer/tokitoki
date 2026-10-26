import type { TokitokiConfig } from "./config.ts";
import type { EventCache, QuotaSnapshotRow } from "./cache.ts";
import { accountEmailFor, nativeCodexIdentities } from "./accounts.ts";
import { modelProvider } from "./model-provider.ts";
import { balanceAccounts } from "./quota/shared.ts";
import {
  AccountCreditsSchema,
  type AccountCredits,
  computePace,
  describeQuotaWindow,
  type AccountBalance,
  type AccountExtraUsage,
  type QuotaWindowFields,
} from "./quota-windows.ts";

// Scanned snapshots only refresh when the harness is used, so old ones no longer reflect the live quota.
const SCANNED_SNAPSHOT_FRESH_MS = 6 * 60 * 60_000;

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

/**
 * Provider-reported windows also carry the provider-neutral QuotaWindowFields
 * (id/label/scope/model/usedPercent/windowMinutes/pace). `kind` is the legacy
 * key kept for existing clients: it still says "day" for 5h session windows.
 */
export interface LimitWindow extends Partial<QuotaWindowFields> {
  /** "day" | "week" | "month", or "<N>min" for embedded custom windows. */
  kind: WindowKind | string;
  source: "embedded" | "derived";
  tokens: number;
  cost: number;
  requests: number;
  /** 0–100 when a denominator exists (embedded quota or plan cap), else undefined. */
  usedPct?: number;
  /** Real USD spend for open-ended (not percent-bounded) windows, e.g. Cursor's On-Demand — shown instead of usedPct when present. */
  amountUsd?: number;
  /** ISO-8601 instant this window resets. */
  resetsAt?: string;
  /** ISO-8601 calendar-window bounds (derived windows only). */
  windowStart?: string;
  windowEnd?: string;
  status?: "current" | "stale" | "expired" | "unknown";
  observedAt?: string;
  bucketId?: string;
  windowId?: string;
}

export interface AccountLimits {
  /** Native credential home for login actions; never a display label. */
  codexHome?: string;
  provider: string;
  accountKey: string;
  /** User-facing label for configured synthetic accounts (never a secret). */
  label?: string;
  /** Stable provider account id when the quota source exposes one. */
  accountId?: string;
  /** Best-effort logged-in email for disambiguating multiple accounts. */
  email?: string;
  /** Plan badge when derivable (provider-reported plan or account suffix after ':'). */
  planLabel?: string;
  /** Provider-reported plan name (e.g. "Max 20x", "Plus"). */
  plan?: string;
  /** Pay-as-you-go usage beyond the plan's included quota (Claude extra usage). */
  extraUsage?: AccountExtraUsage;
  /** Prepaid credit balance reported by the provider (DeepSeek, OpenRouter). */
  balance?: AccountBalance;
  windows: LimitWindow[];
  /** Local calendar usage and configured budgets, never provider quotas. */
  budgetWindows?: LimitWindow[];
  /** Redacted API-key / credential hint for key-based accounts (opencode…). */
  credential?: string;
  /** Other harnesses sharing this exact credential (credential-grouped cards). */
  alsoOn?: string[];
  /** Where this account's quota data comes from: polled | manual | scan. */
  origin?: string;
  /** Most recent quota observation used to render this card. */
  observedAt?: string;
  /** Freshness of provider-reported data; never confuse stale data with zero. */
  freshness?: "fresh" | "stale" | "unknown";
  refreshError?: string;
  /** Provider workspace credits, separate from available rate-limit resets. */
  credits?: AccountCredits;
  /** Banked rate-limit resets. */
  bankedResets?: number;
  bankedExpiresAt?: string;
}

type ExtraKey = NonNullable<NonNullable<TokitokiConfig["poll"]>["extraKeys"]>[number];
type GatewayExtraKey = ExtraKey & { provider: "opencode-go" | "openrouter" };
type ProviderPollKeys = Partial<Record<"zai" | "kimi" | "deepseek", string>>;

/** Multi-account gateway keys (opencode-go/openrouter); zai/kimi/deepseek keys belong to a single default account. */
export const gatewayExtraKeys = (config: TokitokiConfig): GatewayExtraKey[] =>
  (config.poll?.extraKeys ?? []).flatMap((key) => {
    const provider = key.provider ?? "opencode-go";
    return provider === "opencode-go" || provider === "openrouter" ? [{ ...key, provider }] : [];
  });

/** First configured key per single-account key provider, for pollQuotas' providerKeys. */
export const providerPollKeys = (config: TokitokiConfig): ProviderPollKeys => {
  const keys: ProviderPollKeys = {};
  for (const key of config.poll?.extraKeys ?? []) {
    if (key.key.length === 0) continue;
    if (key.provider === "zai" || key.provider === "kimi" || key.provider === "deepseek") keys[key.provider] ??= key.key;
  }
  return keys;
};

/** Attach the polled balance stored for this card's provider/account, when the card lacks one. */
const withAccountBalance = (input: { limit: AccountLimits; cache: EventCache }): AccountLimits => {
  if (input.limit.balance !== undefined) return input.limit;
  const balance = input.cache.quotaAccountMeta(input.limit.provider, input.limit.accountKey)?.balance;
  return balance !== undefined ? { ...input.limit, balance } : input.limit;
};

/**
 * Balance-only accounts (DeepSeek, OpenRouter keys without a limit) have no
 * snapshot rows, so the polled-card discovery never sees them. Attach their
 * balance to an existing card or add a card from the stored account meta.
 */
export const appendBalanceOnlyAccounts = (input: { limits: AccountLimits[]; cache: EventCache; now?: Date }): AccountLimits[] => {
  const limits = input.limits.map((limit) => withAccountBalance({ limit, cache: input.cache }));
  const known = new Set(limits.map((limit) => `${limit.provider}@${limit.accountKey}`));
  for (const account of balanceAccounts(input.cache)) {
    if (input.cache.isRetiredQuotaProvider(account.provider)) continue;
    if (known.has(`${account.provider}@${account.accountKey}`)) continue;
    const meta = input.cache.quotaAccountMeta(account.provider, account.accountKey);
    if (meta?.balance === undefined) continue;
    const now = input.now ?? new Date();
    limits.push({
      provider: account.provider,
      accountKey: account.accountKey,
      ...(meta.email !== undefined ? { email: meta.email } : {}),
      ...(meta.plan !== undefined ? { plan: meta.plan, planLabel: meta.plan } : {}),
      balance: meta.balance,
      origin: "polled",
      windows: input.cache.latestQuotaSnapshots(account.provider, account.accountKey).map((snapshot) => embeddedLimitWindow({ snapshot, now })),
    });
    known.add(`${account.provider}@${account.accountKey}`);
  }
  return limits;
};

/** Newest native workspace-credit payload, without interpreting it as reset credits. */
export function snapshotAccountCredits(snapshots: QuotaSnapshotRow[]): AccountCredits | undefined {
  for (const snapshot of [...snapshots].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))) {
    if (snapshot.creditsJson === null) continue;
    try {
      const parsed = AccountCreditsSchema.safeParse(JSON.parse(snapshot.creditsJson));
      if (parsed.success) return parsed.data;
    } catch { /* Try the next independently valid native observation. */ }
  }
  return undefined;
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
      const previous = windows.get(w.id ?? w.kind);
      if (previous === undefined || rank(w.source) >= rank(previous.source)) windows.set(w.id ?? w.kind, w);
    }
    out.set(id, {
      ...existing,
      ...incoming,
      accountId: incoming.accountId ?? existing.accountId,
      codexHome: incoming.codexHome ?? existing.codexHome,
      label: incoming.label ?? existing.label,
      email: incoming.email ?? existing.email,
      planLabel: incoming.planLabel ?? existing.planLabel,
      plan: incoming.plan ?? existing.plan,
      extraUsage: incoming.extraUsage ?? existing.extraUsage,
      balance: incoming.balance ?? existing.balance,
      credits: incoming.credits ?? existing.credits,
      credential: incoming.credential ?? existing.credential,
      origin: incoming.origin ?? existing.origin,
      windows: [...windows.values()],
      budgetWindows: mergeLocalWindows([existing, incoming], false),
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

/** One provider-reported snapshot as a card window: legacy kind plus generic fields and pace. */
export const embeddedLimitWindow = (input: {
  snapshot: QuotaSnapshotRow;
  usage?: { tokens: number; cost: number; requests: number };
  now: Date;
  maxAgeMs?: number;
  identityVerified?: boolean;
}): LimitWindow => {
  const snapshot = input.snapshot;
  const observedAt = snapshot.observedAt ?? snapshot.capturedAt;
  const observedMs = Date.parse(observedAt);
  const age = input.now.getTime() - observedMs;
  const maxAge = input.maxAgeMs ?? (snapshot.eventId?.startsWith("poll:") ? 30 * 60_000 : SCANNED_SNAPSHOT_FRESH_MS);
  const rolledOver = snapshot.resetsAt > 0 && snapshot.resetsAt * 1000 <= input.now.getTime();
  const status = input.identityVerified === false || !Number.isFinite(snapshot.usedPct) ||
      !Number.isFinite(observedMs) || age < -5 * 60_000
    ? "unknown" : rolledOver ? "expired" : age > maxAge ? "stale" : "current";
  const usedPct = Math.max(0, Math.min(100, snapshot.usedPct));
  // Command Code returns resetAt=0 when a rolling window has not started
  // yet; never render that sentinel as January 1970.
  const resetsAt = snapshot.resetsAt > 0 ? new Date(snapshot.resetsAt * 1000).toISOString() : undefined;
  const fields = describeQuotaWindow({
    windowMinutes: snapshot.windowMinutes,
    usedPercent: usedPct,
    ...(snapshot.label.length > 0 ? { label: snapshot.label } : {}),
    ...(snapshot.model !== null && snapshot.model.length > 0 ? { model: snapshot.model } : {}),
    scope: snapshot.scope ?? undefined,
    bucketId: snapshot.bucketId,
    windowId: snapshot.windowId,
  });
  const amountUsd = snapshot.amountUsd ?? undefined;
  const pace = status === "current" && amountUsd === undefined
    ? computePace({ usedPercent: usedPct, resetsAt, windowMinutes: snapshot.windowMinutes, windowStart: snapshot.windowStart, now: input.now })
    : undefined;
  return {
    // A label distinguishes same-duration windows on one account (Cursor's
    // "Cursor Models" vs "Other Models") — prefer it over the duration kind.
    kind: snapshot.label.length > 0 ? snapshot.label : embeddedKind(snapshot.windowMinutes),
    source: "embedded",
    tokens: input.usage?.tokens ?? 0,
    cost: input.usage?.cost ?? 0,
    requests: input.usage?.requests ?? 0,
    resetsAt,
    ...fields,
    usedPct: status === "current" ? usedPct : undefined,
    usedPercent: status === "current" ? usedPct : undefined,
    amountUsd: status === "current" ? amountUsd : undefined,
    status,
    observedAt,
    bucketId: snapshot.bucketId,
    windowId: snapshot.windowId,
    ...(snapshot.windowStart ? { windowStart: snapshot.windowStart } : {}),
    ...(snapshot.windowEnd ? { windowEnd: snapshot.windowEnd } : {}),
    ...(pace !== undefined ? { pace } : {}),
  };
};

/** Plan badge from a codex-style account suffix ("codex:plus" → "Plus"). */
const planFromAccountKey = (accountKey: string): string | undefined => {
  if (/^(?:account|unidentified):/.test(accountKey)) return undefined;
  const colon = accountKey.lastIndexOf(":");
  return colon > 0 ? accountKey.slice(colon + 1).charAt(0).toUpperCase() + accountKey.slice(colon + 2) : undefined;
};

interface UsageRow {
  tokens: number;
  cost: number;
  requests: number;
}

const ZERO: UsageRow = { tokens: 0, cost: 0, requests: 0 };

/**
 * Legacy kind for an embedded window length. 300min (the 5h session) shares
 * "day" with the calendar day because existing clients key their "Session /
 * day" row on it; scope/label on the window carry the accurate name.
 */
export function embeddedKind(windowMinutes: number): string {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return "unknown";
  if (windowMinutes === 300 || windowMinutes === 1440) return "day";
  if (windowMinutes === 10080) return "week";
  if (windowMinutes === 43200) return "month";
  return `${windowMinutes}min`;
}

/**
 * Match config [plans] caps for an account key: exact match first, then
 * trailing-`*` prefix patterns (longest pattern wins).
 */
export function planCapsFor(
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
    if (cache.isRetiredQuotaProvider(provider)) return false;
    const id = `${provider}@${accountKey}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const out: AccountLimits[] = [];
  // These values are provider-scoped, but the original per-account loop
  // reread large quota stores and auth files for every card.
  const ownFingerprintsByProvider = new Map<string, Set<string>>();
  const emailsByProvider = new Map<string, string | null>();
  const codexIdentities = nativeCodexIdentities({ config });

  for (const { provider, accountKey } of list) {
    const windows: LimitWindow[] = [];
    const budgetWindows: LimitWindow[] = [];
    let bankedResets: number | undefined;
    let bankedExpiresAt: string | undefined;

    // --- Embedded snapshots (real data wins) -----------------------------
    const snaps = cache.latestQuotaSnapshots(provider, accountKey);
    const observedAt = snaps
      .map((s) => Date.parse(s.observedAt ?? s.capturedAt))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const polledObservedAt = snaps
      .filter((s) => s.eventId?.startsWith("poll:") === true)
      .map((s) => Date.parse(s.observedAt ?? s.capturedAt))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const freshness = snaps.length === 0
      ? "unknown" as const
      : polledObservedAt === undefined
        ? observedAt !== undefined && now.getTime() - observedAt <= SCANNED_SNAPSHOT_FRESH_MS
          ? "fresh" as const
          : "stale" as const
        : now.getTime() - polledObservedAt <= Math.max(10, (config.poll?.intervalMinutes ?? 15) * 2) * 60_000
          ? "fresh" as const
          : "stale" as const;
    const quotaAccountIds = cache.quotaAccountIds(provider, accountKey);
    const accountId = quotaAccountIds.size === 1 ? quotaAccountIds.values().next().value : undefined;
    for (const s of snaps) {
      const usage =
        cache.windowUsageForAccount(
          provider,
          accountKey,
          new Date(now.getTime() - s.windowMinutes * 60_000).toISOString(),
        ) ?? ZERO;
      const w = embeddedLimitWindow({ snapshot: s, usage, now,
        identityVerified: provider !== "codex" || Boolean(s.accountId),
        maxAgeMs: s.eventId?.startsWith("poll:") ? Math.max(10, (config.poll?.intervalMinutes ?? 15) * 2) * 60_000 : SCANNED_SNAPSHOT_FRESH_MS,
      });
      windows.push(w);
      if (provider !== "codex" && s.creditsJson !== null) {
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
      const usage =
        cache.windowUsageForAccount(provider, accountKey, iso(c.start)) ?? ZERO;
      if (usage.requests === 0 && caps === undefined) continue;
      const monthDurationMs = Math.max(1, nextMonthStart(now).getTime() - monthStart.getTime());
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
        //
        // The budget available "so far" for a day/week is its own pro-rated
        // share of the monthly cap (elapsed time in the period, as a
        // fraction of the whole month) — not the entire monthly cap, which
        // would only be reached by a rate ~daysInMonth times higher than
        // the true pace threshold.
        const periodStart = c.kind === "day" ? dayStart : weekStart;
        const elapsedMs = Math.max(monthDurationMs * 0.0001, now.getTime() - periodStart.getTime());
        const budgetSoFar = caps.monthlyCostCap * (elapsedMs / monthDurationMs);
        usedPct = (usage.cost / budgetSoFar) * 100;
      }
      budgetWindows.push({
        kind: c.kind,
        source: "derived",
        id: `local:${c.kind}`,
        label: c.kind === "day" ? (usedPct === undefined ? "Today usage" : "Today budget pace")
          : c.kind === "week" ? (usedPct === undefined ? "This week usage" : "This week budget pace")
            : usedPct === undefined ? "This month usage" : "Monthly budget",
        scope: c.kind === "day" ? "daily" : c.kind === "week" ? "weekly" : "monthly",
        tokens: usage.tokens,
        cost: usage.cost,
        requests: usage.requests,
        usedPct: usedPct !== undefined ? Math.min(999, Math.round(usedPct * 10) / 10) : undefined,
        resetsAt: iso(c.end),
        windowStart: iso(c.start),
        windowEnd: iso(c.end),
      });
    }

    const accountMeta = cache.quotaAccountMeta(provider, accountKey);
    const plan = accountMeta?.plan ?? planFromAccountKey(accountKey);

    const order: Record<string, number> = { day: 0, week: 1, month: 2 };
    windows.sort((a, b) => (order[a.kind] ?? 99) - (order[b.kind] ?? 99));

    // A stable native account ID is the bridge from historical sessions to
    // current credentials; matching plan/reset schedules are not identity.
    let email: string | undefined;
    if (provider === "codex") {
      email = accountId === undefined ? undefined : codexIdentities.get(accountId)?.email ?? accountMeta?.email;
      bankedResets = accountMeta?.bankedResets;
      bankedExpiresAt = accountMeta?.bankedExpiresAt;
    } else {
      let own = ownFingerprintsByProvider.get(provider);
      if (own === undefined) {
        own = cache.ownLoginFingerprints(provider);
        ownFingerprintsByProvider.set(provider, own);
      }
      if (!emailsByProvider.has(provider)) emailsByProvider.set(provider, accountEmailFor(provider));
      const pairs = snaps.map(snapshot => `${Math.round(snapshot.windowMinutes)}:${Math.round(snapshot.resetsAt)}`);
      email = own.size === 0 || pairs.some(pair => own.has(pair))
        ? emailsByProvider.get(provider) ?? accountMeta?.email : undefined;
    }

    out.push({
      provider,
      accountKey,
      ...(accountId !== undefined ? { accountId } : {}),
      ...(provider === "codex" && (accountMeta?.codexHome ?? accountMeta?.reauthHome) !== undefined ? { codexHome: accountMeta?.codexHome ?? accountMeta?.reauthHome } : {}),
      email,
      planLabel: plan,
      ...(plan !== undefined ? { plan } : {}),
      ...(accountMeta?.extraUsage !== undefined ? { extraUsage: accountMeta.extraUsage } : {}),
      ...(accountMeta?.balance !== undefined ? { balance: accountMeta.balance } : {}),
      ...(provider === "codex" ? { credits: accountMeta?.credits ?? snapshotAccountCredits(snaps) } : {}),
      windows,
      ...(budgetWindows.length > 0 ? { budgetWindows } : {}),
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
const mergeLocalWindows = (limits: AccountLimits[], sum: boolean): LimitWindow[] => {
  const windows = new Map<string, LimitWindow>();
  for (const limit of limits) {
    for (const window of limit.budgetWindows ?? []) {
      const key = JSON.stringify([window.id ?? window.kind, window.windowStart, window.windowEnd]);
      const previous = windows.get(key);
      if (previous === undefined || !sum) {
        windows.set(key, { ...window });
        continue;
      }
      windows.set(key, {
        ...previous,
        tokens: previous.tokens + window.tokens,
        cost: previous.cost + window.cost,
        requests: previous.requests + window.requests,
        usedPct: previous.usedPct !== undefined && window.usedPct !== undefined ? previous.usedPct + window.usedPct : undefined,
      });
    }
  }
  return [...windows.values()];
};

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
        const existing = byKind.get(w.id ?? w.kind);
        if (existing === undefined || (existing.source !== "embedded" && w.source === "embedded")) {
          byKind.set(w.id ?? w.kind, w);
        }
      }
    }
    out.push({
      ...withPlan,
      windows: [...byKind.values()],
      budgetWindows: mergeLocalWindows(group, false),
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

  const totalTokens = totalLimitTokens;
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
        const existing = byKind.get(w.id ?? w.kind);
        if (existing === undefined) {
          byKind.set(w.id ?? w.kind, { ...w });
          continue;
        }
        const rank = (src: string) => (src === "embedded" || src === "polled" ? 1 : 0);
        if (rank(w.source) > rank(existing.source)) {
          byKind.set(w.id ?? w.kind, { ...w });
        } else if (rank(w.source) === rank(existing.source) && existing.source === "derived") {
          byKind.set(w.id ?? w.kind, {
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
      budgetWindows: mergeLocalWindows(group, true),
      alsoOn: sorted.slice(1).map((l) => l.provider),
      email: undefined,
    });
  }
  return out.sort((a, b) => totalTokens(b) - totalTokens(a));
}

/** Collapse equivalent upstream account keys while keeping raw harness rows available to reports. */
export function collapseHarnessVariants(limits: AccountLimits[]): AccountLimits[] {
  const groups = new Map<string, AccountLimits[]>();
  for (const limit of limits) {
    const provider = cardProviderFor(limit);
    const key = `${provider}\u0000${limit.accountKey}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [limit]);
    else group.push(limit);
  }

  const out: AccountLimits[] = [];
  for (const group of groups.values()) {
    const accountIds = [...new Set(group.flatMap((limit) => limit.accountId === undefined ? [] : [limit.accountId]))];
    if (accountIds.length <= 1) {
      out.push(mergeHarnessVariantGroup(group));
      continue;
    }

    const byAccountId = new Map<string, AccountLimits[]>();
    for (const limit of group) {
      const key = limit.accountId === undefined ? `unknown:${limit.provider}` : `id:${limit.accountId}`;
      const accountGroup = byAccountId.get(key);
      if (accountGroup === undefined) byAccountId.set(key, [limit]);
      else accountGroup.push(limit);
    }
    for (const accountGroup of byAccountId.values()) out.push(mergeHarnessVariantGroup(accountGroup));
  }

  return out.sort((a, b) => totalLimitTokens(b) - totalLimitTokens(a));
}

const UPSTREAM_ROUTED_HARNESSES = new Set(["codex", "pi", "opencode", "t3code"]);

function cardProviderFor(limit: AccountLimits): string {
  if (!UPSTREAM_ROUTED_HARNESSES.has(limit.provider)) return limit.provider;
  const provider = modelProvider("", limit.provider, limit.accountKey);
  return provider === "other" ? limit.provider : provider;
}

function totalLimitTokens(limit: AccountLimits): number {
  return (limit.budgetWindows ?? limit.windows).reduce((sum, window) => sum + window.tokens, 0);
}

function mergeHarnessVariantGroup(group: AccountLimits[]): AccountLimits {
  if (group.length === 1) return group[0]!;

  const upstream = cardProviderFor(group[0]!);
  const preferredProviders = upstream === "opencode"
    ? ["opencode", "pi", "codex", "t3code"]
    : upstream === "openai"
      ? ["codex", "pi", "opencode", "t3code"]
      : [upstream, "codex", "pi", "opencode", "t3code"];
  const providerRank = (provider: string) => {
    const index = preferredProviders.indexOf(provider);
    return index === -1 ? 0 : preferredProviders.length - index;
  };
  const sorted = [...group].sort((a, b) => {
    const rankDifference = providerRank(b.provider) - providerRank(a.provider);
    return rankDifference === 0 ? totalLimitTokens(b) - totalLimitTokens(a) : rankDifference;
  });
  const primary = sorted[0]!;
  const byKind = new Map<string, LimitWindow>();
  for (const limit of sorted) {
    for (const window of limit.windows) {
      const existing = byKind.get(window.id ?? window.kind);
      if (existing === undefined) {
        byKind.set(window.id ?? window.kind, { ...window });
        continue;
      }
      const rank = (source: string) => (source === "embedded" || source === "polled" ? 1 : 0);
      if (rank(window.source) > rank(existing.source)) {
        byKind.set(window.id ?? window.kind, { ...window });
      } else if (rank(window.source) === rank(existing.source) && existing.source === "derived") {
        byKind.set(window.id ?? window.kind, {
          ...existing,
          tokens: existing.tokens + window.tokens,
          cost: existing.cost + window.cost,
          requests: existing.requests + window.requests,
          resetsAt: [existing.resetsAt, window.resetsAt].sort().at(-1) ?? existing.resetsAt,
          windowStart: [existing.windowStart, window.windowStart].sort()[0],
          windowEnd: [existing.windowEnd, window.windowEnd].sort().at(-1),
        });
      }
    }
  }

  const emails = [...new Set(group.map((limit) => limit.email).filter((email): email is string => email !== undefined && email.length > 0))];
  const accountId = group.find((limit) => limit.accountId !== undefined)?.accountId;
  const label = group.find((limit) => limit.label !== undefined)?.label;
  const planLabel = group.find((limit) => limit.planLabel !== undefined)?.planLabel;
  const plan = group.find((limit) => limit.plan !== undefined)?.plan;
  const extraUsage = group.find((limit) => limit.extraUsage !== undefined)?.extraUsage;
  const balance = group.find((limit) => limit.balance !== undefined)?.balance;
  const credential = group.find((limit) => limit.credential !== undefined)?.credential;
  const alsoOn = [...new Set([
    ...group.flatMap((limit) => limit.alsoOn ?? []),
    ...sorted.slice(1).map((limit) => limit.provider),
  ])].filter((provider) => provider !== primary.provider);

  return {
    ...primary,
    windows: [...byKind.values()],
    budgetWindows: mergeLocalWindows(group, true),
    ...(primary.accountId === undefined && accountId !== undefined ? { accountId } : {}),
    ...(primary.label === undefined && label !== undefined ? { label } : {}),
    ...(primary.planLabel === undefined && planLabel !== undefined ? { planLabel } : {}),
    ...(primary.plan === undefined && plan !== undefined ? { plan } : {}),
    ...(primary.extraUsage === undefined && extraUsage !== undefined ? { extraUsage } : {}),
    ...(primary.balance === undefined && balance !== undefined ? { balance } : {}),
    ...(primary.credential === undefined && credential !== undefined ? { credential } : {}),
    alsoOn: alsoOn.length > 0 ? alsoOn : undefined,
    email: emails.length === 1 ? emails[0] : undefined,
  };
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
