import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TokitokiConfig } from "./config.ts";

/**
 * Budget evaluation + ntfy push alerts.
 *
 * Config (config.json / config.toml):
 *   [budgets]
 *   daily = 10        # USD caps, global
 *   weekly = 50
 *   monthly = 200
 *   ntfy = "https://ntfy.sh/tokitoki-secret"   # optional push target
 *   [budgets.accounts."codex*"]                # accountKey pattern, trailing *
 *   monthly = 120
 *
 * Thresholds: 80% and 100% of each cap. Alerts dedupe per (scope, period,
 * pattern, threshold) in an on-disk state file so a threshold fires once per
 * period even across many scans/reports.
 */

export interface BudgetCaps {
  daily?: number;
  weekly?: number;
  monthly?: number;
}

export interface BudgetsConfig {
  daily?: number;
  weekly?: number;
  monthly?: number;
  accounts?: Record<string, BudgetCaps>;
  /** Full ntfy topic URL; plain HTTP POST, no dependency. */
  ntfy?: string;
}

export const THRESHOLDS = [0.8, 1.0] as const;

export interface BudgetAlert {
  /** "daily" | "weekly" | "monthly" */
  scope: "daily" | "weekly" | "monthly";
  /** Account pattern ("(global)" for the global budget) */
  pattern: string;
  spend: number;
  cap: number;
  pct: number;
  /** Crossing level that fired: 80 or 100 */
  level: number;
}

/** Period identity used for dedupe — a new day/week/month re-arms thresholds. */
export function alertStateKey(alert: BudgetAlert, now: Date): string {
  const y = now.getFullYear();
  if (alert.scope === "daily") return `daily:${y}-${now.getMonth() + 1}-${now.getDate()}:${alert.pattern}`;
  if (alert.scope === "weekly") {
    // ISO-ish week id: year + week number
    const first = new Date(y, 0, 1);
    const week = Math.ceil(((now.getTime() - first.getTime()) / 86_400_000 + first.getDay() + 1) / 7);
    return `weekly:${y}-w${week}:${alert.pattern}`;
  }
  return `monthly:${y}-${now.getMonth() + 1}:${alert.pattern}`;
}

function capFor(caps: BudgetCaps, scope: BudgetAlert["scope"]): number | undefined {
  return scope === "daily" ? caps.daily : scope === "weekly" ? caps.weekly : caps.monthly;
}

/** Pure evaluation: given windowed spends and config, which alerts fire? */
export function evaluateBudgets(
  spends: { daily: number; weekly: number; monthly: number },
  budgets: BudgetsConfig,
  accountSpends?: Array<{ key: string; daily: number; weekly: number; monthly: number }>,
): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  const check = (
    scope: BudgetAlert["scope"],
    spend: number,
    cap: number | undefined,
    pattern: string,
  ): void => {
    if (cap === undefined || cap <= 0 || spend <= 0) return;
    const pct = spend / cap;
    for (const t of THRESHOLDS) {
      // Fires when crossing the threshold this period. We don't have "last
      // check" history per value, so fire while >= threshold and let state
      // dedupe repeats.
      if (pct >= t) {
        alerts.push({
          scope,
          pattern,
          spend,
          cap,
          pct,
          level: Math.round(t * 100),
        });
      }
    }
  };
  check("daily", spends.daily, budgets.daily, "(global)");
  check("weekly", spends.weekly, budgets.weekly, "(global)");
  check("monthly", spends.monthly, budgets.monthly, "(global)");
  if (budgets.accounts !== undefined && accountSpends !== undefined) {
    for (const [pattern, caps] of Object.entries(budgets.accounts)) {
      for (const acc of accountSpends) {
        if (!matchPattern(pattern, acc.key)) continue;
        check("daily", acc.daily, caps.daily, `${pattern} (${acc.key})`);
        check("weekly", acc.weekly, caps.weekly, `${pattern} (${acc.key})`);
        check("monthly", acc.monthly, caps.monthly, `${pattern} (${acc.key})`);
      }
    }
  }
  return alerts;
}

/** Exact match, or trailing `*` prefix match (same semantics as [plans]). */
function matchPattern(pattern: string, key: string): boolean {
  if (pattern.endsWith("*")) return key.startsWith(pattern.slice(0, -1));
  return pattern === key;
}

// ------------------------------------------------------------------ state

function alertStatePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? path.join(xdg, "tokitoki") : path.join(os.homedir(), ".local", "share", "tokitoki");
  return path.join(base, "alerts.json");
}

type AlertState = Record<string, true>;

export function loadAlertState(file: string = alertStatePath()): AlertState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AlertState;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveAlertState(state: AlertState, file: string = alertStatePath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    /* best effort — worst case an alert re-fires */
  }
}

/** Returns only not-yet-sent alerts, marking them sent. Injectable file for tests. */
export function filterNewAlerts(
  alerts: BudgetAlert[],
  now: Date,
  file: string = alertStatePath(),
): BudgetAlert[] {
  const state = loadAlertState(file);
  const fresh: BudgetAlert[] = [];
  for (const a of alerts) {
    const key = alertStateKey(a, now);
    if (state[key] === true) continue;
    state[key] = true;
    fresh.push(a);
  }
  if (fresh.length > 0) saveAlertState(state, file);
  return fresh;
}

/** Fire-and-forget ntfy push. Never throws; logs failures to stderr once. */
export async function notifyNtfy(topicUrl: string, title: string, body: string): Promise<void> {
  try {
    await fetch(topicUrl, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: "warning" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(`\x1b[2mtokitoki: ntfy push failed: ${(err as Error).message}\x1b[0m`);
  }
}

/**
 * Evaluate + dedupe + render banners synchronously; ntfy pushes happen in the
 * background. Returns banner lines ready to print after command output.
 */
export function processBudgetAlerts(
  cfg: TokitokiConfig,
  spends: { daily: number; weekly: number; monthly: number },
  accountSpends?: Array<{ key: string; daily: number; weekly: number; monthly: number }>,
  now: Date = new Date(),
): string[] {
  const budgets = cfg.budgets;
  if (budgets === undefined) return [];
  const alerts = evaluateBudgets(spends, budgets, accountSpends);
  if (alerts.length === 0) return [];
  const fresh = filterNewAlerts(alerts, now);
  if (fresh.length === 0) return [];

  const lines: string[] = [];
  for (const a of fresh) {
    const line = `⚠ ${a.scope} budget ${a.pattern}: $${a.spend.toFixed(2)} / $${a.cap.toFixed(2)} (${Math.round(a.pct * 100)}%)`;
    lines.push(line);
    if (budgets.ntfy !== undefined && budgets.ntfy.length > 0) {
      void notifyNtfy(budgets.ntfy, `tokitoki ${a.scope} budget ${a.level}%`, line);
    }
  }
  return [`\x1b[33m${lines.join("\n")}\x1b[0m`];
}
