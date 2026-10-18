import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { BudgetGaugeJson } from "./budget-status.ts";
import type { NotificationsConfig } from "./config.ts";
import type { AccountLimits, LimitWindow } from "./limits.ts";
import type { SpendHealth } from "./spend-health.ts";
import { dataDir } from "./store.ts";

/**
 * Desktop alerts for Linux shells (DMS, Quickshell, Waybar…), mirroring the
 * macOS menubar categories plus a CodexBar-style pace alert. Evaluation is
 * pure; dedupe keys include the reset instant or calendar period so each
 * window alerts at most once.
 */

export type NotificationKind = "quotaCritical" | "quotaReset" | "quotaPace" | "burnRate" | "budget";

export interface PendingNotification {
  kind: NotificationKind;
  key: string;
  title: string;
  body: string;
  reason: string;
}

const ObservationSchema = z.object({ remaining: z.number(), resetAt: z.string().optional() });

const HistoryRecordSchema = z.object({
  id: z.string(),
  at: z.string(),
  title: z.string(),
  body: z.string(),
  reason: z.string(),
  kind: z.string().optional(),
});

const NotifyStateSchema = z.object({
  keys: z.array(z.string()).default([]),
  history: z.array(HistoryRecordSchema).default([]),
  observations: z.record(z.string(), ObservationSchema).default({}),
});

export type NotifyState = z.infer<typeof NotifyStateSchema>;
export type NotificationHistoryRecord = z.infer<typeof HistoryRecordSchema>;

const MAX_KEYS = 500;
const MAX_HISTORY = 50;
const LOCK_STALE_MS = 60_000;

export const emptyNotifyState = (): NotifyState => ({ keys: [], history: [], observations: {} });

const statePath = (): string => path.join(dataDir(), "notify-state.json");

export const readNotifyState = (): NotifyState => {
  try {
    const parsed = NotifyStateSchema.safeParse(JSON.parse(fs.readFileSync(statePath(), "utf8")));
    return parsed.success ? parsed.data : emptyNotifyState();
  } catch {
    return emptyNotifyState();
  }
};

const writeNotifyState = (state: NotifyState): void => {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
};

const periodKey = (scope: string, now: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (scope.startsWith("month")) return day.slice(0, 7);
  if (scope.startsWith("week")) {
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    return `w${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
  }
  return day;
};

const windowName = (window: LimitWindow): string => {
  if (window.label !== undefined && window.label.length > 0) return window.label;
  if (window.kind === "day") return "Day";
  if (window.kind === "week") return "Weekly";
  if (window.kind === "month") return "Monthly";
  return window.kind;
};

const countdown = (iso: string | undefined, now: Date): string => {
  if (iso === undefined) return "—";
  const seconds = Math.floor((Date.parse(iso) - now.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export const evaluateNotifications = (input: {
  limits: AccountLimits[];
  budgets: BudgetGaugeJson[];
  spendHealth?: SpendHealth;
  settings: NotificationsConfig;
  state: NotifyState;
  now: Date;
}): { notifications: PendingNotification[]; state: NotifyState } => {
  const criticalPercent = Math.max(0, Math.min(100, input.settings.quotaCriticalPercent ?? 10));
  const disabled = new Set(input.settings.disabled ?? []);
  const seen = new Set(input.state.keys);
  const notifications: PendingNotification[] = [];
  const observations: NotifyState["observations"] = { ...input.state.observations };

  const push = (notification: PendingNotification): void => {
    if (disabled.has(notification.kind) || seen.has(notification.key)) return;
    seen.add(notification.key);
    notifications.push(notification);
  };

  for (const account of input.limits) {
    if (account.freshness === "stale") continue;
    const who = account.label ?? account.email ?? account.accountKey;
    for (const window of account.windows) {
      if (window.usedPct === undefined || window.source !== "embedded") continue;
      const remaining = Math.max(0, Math.min(100, 100 - window.usedPct));
      const identity = `${account.provider}@${account.accountKey}|${window.id ?? window.kind}`;
      const previous = observations[identity];
      const name = `${account.provider} · ${who} · ${windowName(window)}`;
      const reset = window.resetsAt ?? "unknown";

      if (remaining <= criticalPercent) {
        push({
          kind: "quotaCritical",
          key: `quota-critical|${identity}|${reset}`,
          title: "tokitoki quota critical",
          body: `${name}: ${Math.round(remaining)}% left · resets in ${countdown(window.resetsAt, input.now)}`,
          reason: `The reported ${windowName(window).toLowerCase()} quota reached your critical threshold of ${criticalPercent}% remaining.`,
        });
      } else if (window.pace?.runsOutAt !== undefined && window.pace.status === "over") {
        push({
          kind: "quotaPace",
          key: `quota-pace|${identity}|${reset}`,
          title: "tokitoki quota running out",
          body: `${name}: ${Math.round(remaining)}% left · runs out ~${clockTime(window.pace.runsOutAt)}, resets in ${countdown(window.resetsAt, input.now)}`,
          reason: "At the current burn rate this window is exhausted before it resets.",
        });
      }

      const resetChanged = previous?.resetAt !== undefined && window.resetsAt !== undefined && previous.resetAt !== window.resetsAt;
      const recovered = previous !== undefined && previous.remaining <= criticalPercent && remaining >= 50;
      if (input.settings.resetAware === true && previous !== undefined && previous.remaining <= criticalPercent && (resetChanged || recovered)) {
        push({
          kind: "quotaReset",
          key: `quota-reset|${identity}|${reset}`,
          title: "tokitoki quota available",
          body: `${name} is available again · ${Math.round(remaining)}% left`,
          reason: "This quota was exhausted or critical and its provider now reports usable capacity again.",
        });
      }
      observations[identity] = { remaining, ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt }) };
    }
  }

  for (const budget of input.budgets) {
    if (budget.state === "ok") continue;
    const level = budget.state === "exceeded" ? 100 : 80;
    push({
      kind: "budget",
      key: `budget|${budget.label}|${level}|${periodKey(budget.scope, input.now)}`,
      title: `tokitoki budget ${level}%`,
      body: `${budget.label}: $${budget.used.toFixed(2)} / $${budget.cap.toFixed(2)}`,
      reason: `This budget crossed its ${level}% warning threshold.`,
    });
  }

  const health = input.spendHealth;
  const warningRatio = Math.max(0, Math.min(1, input.settings.burnWarningRatio ?? 0.8));
  if (input.settings.burnWarnings === true && health?.monthlyCap !== undefined && health.projectedRatio !== undefined && health.projectedRatio >= warningRatio) {
    const level = health.projectedRatio >= 1 ? 100 : 80;
    push({
      kind: "burnRate",
      key: `burn|${periodKey("month", input.now)}|${level}`,
      title: "tokitoki burn-rate warning",
      body: `Projected $${health.projected.toFixed(0)} by month end vs $${health.monthlyCap.toFixed(0)} cap · $${health.perDay.toFixed(2)}/day`,
      reason: "Your month-to-date spend pace projects above the configured warning threshold.",
    });
  }

  const at = input.now.toISOString();
  return {
    notifications,
    state: {
      keys: [...input.state.keys, ...notifications.map((notification) => notification.key)].slice(-MAX_KEYS),
      history: [
        ...notifications.map((notification) => ({
          id: notification.key,
          at,
          title: notification.title,
          body: notification.body,
          reason: notification.reason,
          kind: notification.kind,
        })),
        ...input.state.history,
      ].slice(0, MAX_HISTORY),
      observations,
    },
  };
};

const deliver = (notification: PendingNotification): boolean => {
  const command = process.platform === "darwin"
    ? ["osascript", "-e", `display notification ${JSON.stringify(notification.body)} with title ${JSON.stringify(notification.title)}`]
    : ["notify-send", "--app-name=tokitoki", `--urgency=${notification.kind === "quotaCritical" ? "critical" : "normal"}`, notification.title, notification.body];
  try {
    return Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
};

/** Serializes concurrent widgets (one per monitor) so an alert fires once. */
const withLock = <T>(fn: () => T): T | undefined => {
  const lock = `${statePath()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.closeSync(fs.openSync(lock, "wx"));
  } catch {
    const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age < LOCK_STALE_MS) return undefined;
    fs.rmSync(lock, { force: true });
    return withLock(fn);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
};

export interface NotifyResult {
  sent: PendingNotification[];
  undelivered: number;
  skipped?: "disabled" | "locked";
}

export const dispatchNotifications = (input: {
  limits: AccountLimits[];
  budgets: BudgetGaugeJson[];
  spendHealth?: SpendHealth;
  settings: NotificationsConfig | undefined;
  now?: Date;
  dryRun?: boolean;
}): NotifyResult => {
  if (input.settings?.enabled !== true) return { sent: [], undelivered: 0, skipped: "disabled" };
  const settings = input.settings;
  const result = withLock(() => {
    const evaluated = evaluateNotifications({ ...input, settings, state: readNotifyState(), now: input.now ?? new Date() });
    if (input.dryRun === true) return { sent: evaluated.notifications, undelivered: 0 };
    // Persist before delivery so a failing notifier can never cause repeats.
    writeNotifyState(evaluated.state);
    const undelivered = evaluated.notifications.filter((notification) => !deliver(notification)).length;
    return { sent: evaluated.notifications, undelivered };
  });
  return result ?? { sent: [], undelivered: 0, skipped: "locked" };
};
