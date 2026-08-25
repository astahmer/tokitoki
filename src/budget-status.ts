import type { EventCache } from "./cache.ts";
import { evaluateBudgets, type BudgetAlert, type BudgetsConfig } from "./budgets.ts";
import { monthStartIso } from "./report.ts";

/**
 * Single source of truth for budget gauge state — consumed by
 * `/api/budgets` (web) and `tokitoki budgets --json` (CLI/menubar).
 * Pure read: never fires notifications or mutates alert state.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Exact match, or trailing `*` prefix match (same semantics as [plans]). */
export function matchesBudgetPattern(pattern: string, key: string): boolean {
  return pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : pattern === key;
}

export interface BudgetStatusRow {
  scope: "daily" | "weekly" | "monthly";
  pattern: string;
  spend: number;
  cap: number;
  pct: number;
  /** Highest alert level currently crossed: 0 | 80 | 100. */
  level: 0 | 80 | 100;
}

export interface BudgetStatusPayload {
  configured: boolean;
  /** One row per configured scope×pattern, always shown (gauge bars). */
  rows: BudgetStatusRow[];
  alerts: BudgetAlert[];
}

/** Budget gauges + currently-firing alerts (no notification side effects). */
export function computeBudgetStatus(
  cache: EventCache,
  budgets: BudgetsConfig | undefined,
): BudgetStatusPayload {
  if (budgets === undefined) return { configured: false, rows: [], alerts: [] };

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const monthStart = monthStartIso();
  // hybridUsage/hybridAggregate: exact same numbers as totals()/aggregate()
  // (interior days from daily_rollups, partial edge slices from events) but
  // O(days×accounts) — this runs on every menubar poll.
  const dayTotals = cache.hybridUsage(midnight.toISOString());
  const weekTotals = cache.hybridUsage(weekAgo.toISOString());
  const monthTotals = cache.hybridUsage(monthStart);
  const byAccount = (sinceIso: string): Array<{ key: string; daily: number; weekly: number; monthly: number }> =>
    cache.hybridAggregate(sinceIso, "account").map((r) => ({
      key: r.bucket,
      daily: r.costUsd,
      weekly: r.costUsd,
      monthly: r.costUsd,
    }));
  const accountSpends = byAccount(midnight.toISOString());
  const weeklyByAccount = new Map(byAccount(weekAgo.toISOString()).map((a) => [a.key, a.weekly]));
  const monthlyByAccount = new Map(
    cache.hybridAggregate(monthStart, "account").map((r) => [r.bucket, r.costUsd]),
  );
  for (const a of accountSpends) {
    a.weekly = weeklyByAccount.get(a.key) ?? 0;
    a.monthly = monthlyByAccount.get(a.key) ?? 0;
  }
  const spends = { daily: dayTotals.costUsd, weekly: weekTotals.costUsd, monthly: monthTotals.costUsd };
  const alerts = evaluateBudgets(spends, budgets, accountSpends);

  const rows: BudgetStatusRow[] = [];
  const push = (scope: BudgetAlert["scope"], pattern: string, spend: number, cap: number | undefined): void => {
    if (cap === undefined || cap <= 0) return;
    const pct = spend / cap;
    rows.push({ scope, pattern, spend: round2(spend), cap, pct, level: pct >= 1 ? 100 : pct >= 0.8 ? 80 : 0 });
  };
  push("daily", "(global)", spends.daily, budgets.daily);
  push("weekly", "(global)", spends.weekly, budgets.weekly);
  push("monthly", "(global)", spends.monthly, budgets.monthly);
  if (budgets.accounts !== undefined) {
    for (const [pattern, caps] of Object.entries(budgets.accounts)) {
      const matched = accountSpends.filter((a) => matchesBudgetPattern(pattern, a.key));
      // Aggregate wildcard matches so the gauge shows one combined bar.
      const sum = (f: (a: (typeof matched)[number]) => number): number =>
        matched.reduce((acc, a) => acc + f(a), 0);
      push("daily", pattern, sum((a) => a.daily), caps.daily);
      push("weekly", pattern, sum((a) => a.weekly), caps.weekly);
      push("monthly", pattern, sum((a) => a.monthly), caps.monthly);
    }
  }
  return { configured: true, rows, alerts };
}

// ------------------------------------------------------------- menubar JSON

export interface BudgetGaugeJson {
  /** day|week|month (calendar scopes, matching [budgets] keys minus "ly") */
  scope: string;
  label: string;
  cap: number;
  used: number;
  unit: "usd";
  ratio: number;
  state: "ok" | "warn" | "exceeded";
  /** Fractional days until this scope's period rolls over. */
  daysLeft: number;
}

/** Days (fractional) remaining in the calendar period for a scope. */
export function daysLeftForScope(scope: string, now: Date = new Date()): number {
  const end = new Date(now);
  if (scope === "day") {
    end.setHours(24, 0, 0, 0);
  } else if (scope === "week") {
    // Periods align to Monday like the ISO-ish week id in budgets.ts.
    // End = next Monday 00:00 local — computed from the week's start so the
    // result can never exceed 7 days regardless of the current time of day.
    const offset = (end.getDay() + 6) % 7;
    const start = new Date(end);
    start.setDate(start.getDate() - offset);
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime() + 7 * 86_400_000);
  } else {
    end.setDate(1);
    end.setMonth(end.getMonth() + 1);
    end.setHours(0, 0, 0, 0);
  }
  return Math.max(0, Math.round(((end.getTime() - now.getTime()) / 86_400_000) * 10) / 10);
}

/** "daily"|"weekly"|"monthly" → "day"|"week"|"month" (explicit, no string surgery). */
const SCOPE_NAME: Record<BudgetStatusRow["scope"], string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

/** Shape consumed by the menubar app (`tokitoki budgets --json`). */
export function gaugesForMenubar(payload: BudgetStatusPayload, now: Date = new Date()): BudgetGaugeJson[] {
  return payload.rows.map((r) => ({
    scope: SCOPE_NAME[r.scope],
    label: r.pattern === "(global)" ? r.scope : `${r.pattern} ${r.scope}`,
    cap: r.cap,
    used: r.spend,
    unit: "usd" as const,
    ratio: Math.round(r.pct * 10_000) / 10_000,
    state: r.level >= 100 ? "exceeded" : r.level >= 80 ? "warn" : "ok",
    daysLeft: daysLeftForScope(SCOPE_NAME[r.scope], now),
  }));
}
