import { z } from "zod";

/**
 * Provider-neutral quota window vocabulary shared by every poller and the
 * widget payload. Legacy `kind` keys ("day" for the 5h window, …) stay on
 * LimitWindow for existing clients; these fields describe the window
 * honestly for new ones.
 */

/** `other` marks a provider window whose duration was not reported. */
export type QuotaScope = "session" | "daily" | "weekly" | "monthly" | "model" | "other";

export type PaceStatus = "under" | "on" | "over";

export interface QuotaPace {
  /** Share of the window that would be used by now at an even burn rate, 0–100. */
  expectedPercent: number;
  /** usedPercent − expectedPercent; positive means ahead of an even pace. */
  deltaPercent: number;
  status: PaceStatus;
  /** Projected exhaustion instant at the current burn rate, only when it lands before the reset. */
  runsOutAt?: string;
}

export interface QuotaWindowFields {
  /** Stable per-account id: "session", "weekly", "weekly:opus", "monthly:cursor-models". */
  id: string;
  label: string;
  scope: QuotaScope;
  model?: string;
  usedPercent: number;
  windowMinutes?: number;
  pace?: QuotaPace;
}

/** Pace tolerance in percentage points before a window counts as under/over. */
const ON_PACE_TOLERANCE = 5;

const durationScope = (windowMinutes: number): Exclude<QuotaScope, "model"> => {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return "other";
  if (windowMinutes === 300) return "session";
  if (windowMinutes === 1440) return "daily";
  if (windowMinutes === 10080) return "weekly";
  if (windowMinutes >= 28 * 1440 && windowMinutes <= 31 * 1440) return "monthly";
  return "other";
};

const SCOPE_LABELS: Record<Exclude<QuotaScope, "model">, string> = {
  session: "Session",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  other: "Limit",
};

const slug = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const titleCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Describe one provider-reported window. `label` is the provider bucket name
 * when it has one (Cursor's "Other Models"); `model` marks per-model limits
 * (Claude's weekly Opus/Sonnet caps).
 */
export const describeQuotaWindow = (input: {
  windowMinutes: number;
  usedPercent: number;
  label?: string;
  model?: string;
  scope?: QuotaScope;
  bucketId?: string;
  windowId?: string;
}): Omit<QuotaWindowFields, "pace"> => {
  const durationKind = durationScope(input.windowMinutes);
  const labelScope = input.scope !== undefined && input.scope !== "model" ? input.scope : durationKind;
  const bucket = input.model ?? input.label;
  const hasBucket = bucket !== undefined && bucket.length > 0;
  const label = input.model !== undefined
    ? `${titleCase(input.model)} ${SCOPE_LABELS[durationKind].toLowerCase()}`
    : input.label !== undefined && input.label.length > 0
      ? input.label
      : SCOPE_LABELS[labelScope];
  const stableId = input.windowId ? [input.bucketId, input.windowId, input.model].filter(Boolean).join(":") : undefined;
  return {
    id: stableId ?? (hasBucket ? `${durationKind}:${slug(bucket)}` : durationKind),
    label,
    scope: input.scope ?? (input.model !== undefined ? "model" : durationKind),
    ...(input.model !== undefined ? { model: input.model } : {}),
    usedPercent: Math.max(0, Math.min(100, input.usedPercent)),
    ...(Number.isFinite(input.windowMinutes) && input.windowMinutes > 0 ? { windowMinutes: input.windowMinutes } : {}),
  };
};

/** Suffix repeated window ids (`session`, `session:2`) so ids stay unique within one account. */
export const withUniqueWindowIds = <Window extends { id?: string }>(windows: Window[]): Window[] => {
  const seen = new Map<string, number>();
  return windows.map((window) => {
    if (window.id === undefined) return window;
    const count = (seen.get(window.id) ?? 0) + 1;
    seen.set(window.id, count);
    return count === 1 ? window : { ...window, id: `${window.id}:${count}` };
  });
};

/**
 * Even-use pace for a fixed-length window ending at `resetsAt`. Returns
 * undefined when the window's position in time is unknown or already over.
 */
export const computePace = (input: {
  usedPercent: number;
  resetsAt: string | undefined;
  windowMinutes: number | undefined;
  now: Date;
  windowStart?: string;
}): QuotaPace | undefined => {
  if (input.resetsAt === undefined) return undefined;
  const resetMs = Date.parse(input.resetsAt);
  const nowMs = input.now.getTime();
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return undefined;
  const suppliedStart = input.windowStart !== undefined ? Date.parse(input.windowStart) : NaN;
  const durationMs = Number.isFinite(suppliedStart) ? resetMs - suppliedStart
    : input.windowMinutes !== undefined ? input.windowMinutes * 60_000 : NaN;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  const elapsedMs = durationMs - (resetMs - nowMs);
  if (elapsedMs <= 0) return undefined;

  const used = Math.max(0, Math.min(100, input.usedPercent));
  const expectedPercent = Math.round((elapsedMs / durationMs) * 1000) / 10;
  const deltaPercent = Math.round((used - expectedPercent) * 10) / 10;
  const status: PaceStatus = deltaPercent > ON_PACE_TOLERANCE
    ? "over"
    : deltaPercent < -ON_PACE_TOLERANCE ? "under" : "on";

  if (used <= 0 || used >= 100) return { expectedPercent, deltaPercent, status };
  const msToExhaustion = ((100 - used) / used) * elapsedMs;
  const runsOutMs = nowMs + msToExhaustion;
  return {
    expectedPercent,
    deltaPercent,
    status,
    ...(runsOutMs < resetMs ? { runsOutAt: new Date(Math.round(runsOutMs)).toISOString() } : {}),
  };
};

export const AccountBalanceSchema = z.object({
  currency: z.string(),
  remaining: z.number(),
  total: z.number().optional(),
  used: z.number().optional(),
  granted: z.number().optional(),
  paid: z.number().optional(),
  available: z.boolean().optional(),
});

export type AccountBalance = z.infer<typeof AccountBalanceSchema>;

export const AccountCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().nullable().optional(),
});

export type AccountCredits = z.infer<typeof AccountCreditsSchema>;

export const QuotaAccountMetaSchema = z.object({
  /** Workspace monetary credits, independent of reset-credit counts. */
  credits: AccountCreditsSchema.optional(),
  /** Native credential home, used only to target account login actions. */
  codexHome: z.string().optional(),
  /** Login target retained after logout; never used as an identity binding. */
  reauthHome: z.string().optional(),
  /** Explicit reset credits, independent of workspace monetary credits. */
  bankedResets: z.number().int().nonnegative().optional(),
  bankedExpiresAt: z.string().optional(),
  plan: z.string().optional(),
  email: z.string().optional(),
  organization: z.string().optional(),
  extraUsage: z.object({
    enabled: z.boolean(),
    usedUsd: z.number().optional(),
    limitUsd: z.number().optional(),
    usedPercent: z.number().optional(),
  }).optional(),
  balance: AccountBalanceSchema.optional(),
});

export type QuotaAccountMeta = z.infer<typeof QuotaAccountMetaSchema>;

export type AccountExtraUsage = NonNullable<QuotaAccountMeta["extraUsage"]>;
