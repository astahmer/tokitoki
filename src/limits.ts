import type { TokitokiConfig } from "./config.ts";
import type { EventCache } from "./cache.ts";
import { accountEmailFor } from "./accounts.ts";

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
  /** Best-effort logged-in email for disambiguating multiple accounts. */
  email?: string;
  /** Plan badge when derivable (account suffix after ':' or config match). */
  planLabel?: string;
  windows: LimitWindow[];
  /** Banked rate-limit resets (codex credits analog). */
  bankedResets?: number;
  bankedExpiresAt?: string;
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
function embeddedKind(windowMinutes: number): string {
  if (windowMinutes === 1440) return "day";
  if (windowMinutes === 10080) return "week";
  if (windowMinutes === 43200) return "month";
  return `${windowMinutes}min`;
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
  const list =
    accounts ?? cache.detectedAccounts().map((a) => ({ provider: a.provider, accountKey: a.accountKey }));
  const out: AccountLimits[] = [];

  for (const { provider, accountKey } of list) {
    const windows: LimitWindow[] = [];
    let bankedResets: number | undefined;
    let bankedExpiresAt: string | undefined;

    // --- Embedded snapshots (real data wins) -----------------------------
    const snaps = cache.latestQuotaSnapshots(provider, accountKey);
    const embeddedKinds = new Set<string>();
    for (const s of snaps) {
      const kind = embeddedKind(s.windowMinutes);
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
        resetsAt: new Date(s.resetsAt * 1000).toISOString(),
      };
      windows.push(w);
      if (s.creditsJson !== null) {
        try {
          const c = JSON.parse(s.creditsJson) as { hasCredits: boolean; unlimited: boolean; balance: string };
          if (c.hasCredits && !c.unlimited && Number(c.balance) > 0) {
            bankedResets = Math.floor(Number(c.balance));
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

    out.push({
      provider,
      accountKey,
      email: accountEmailFor(provider) ?? undefined,
      planLabel,
      windows,
      bankedResets,
      bankedExpiresAt,
    });
  }
  return out;
}
