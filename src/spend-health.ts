import type { AggRow } from "./cache.ts";

export type SpendHealthState = "ok" | "warn" | "exceeded";

export interface SpendHealth {
  /** Month-to-date cost in USD. */
  monthToDate: number;
  /** Month-to-date requests, useful when providers do not expose prices. */
  requests: number;
  /** Observed month-to-date cost divided by elapsed calendar days. */
  perDay: number;
  /** Linear month-end projection from the observed daily burn. */
  projected: number;
  /** Configured monthly cap, when one exists. */
  monthlyCap?: number;
  /** Projected / monthly cap, when one exists. */
  projectedRatio?: number;
  state: SpendHealthState;
  daysElapsed: number;
  daysInMonth: number;
}

/**
 * Turn month-to-date spend into a compact, warning-capable health signal.
 * A warning is only possible with an explicit monthly budget: otherwise the
 * UI still reports the burn rate but must not invent a risk threshold.
 */
export function computeSpendHealth(
  mtd: Pick<AggRow, "costUsd" | "requests">,
  now: Date = new Date(),
  monthlyCap?: number,
  warningRatio = 0.8,
): SpendHealth {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = Math.max(1, now.getDate());
  const monthToDate = Math.max(0, mtd.costUsd);
  const perDay = monthToDate / daysElapsed;
  const projected = perDay * daysInMonth;
  const validCap = monthlyCap !== undefined && monthlyCap > 0 ? monthlyCap : undefined;
  const projectedRatio = validCap === undefined ? undefined : projected / validCap;
  const threshold = Math.max(0, Math.min(1, warningRatio));
  const state: SpendHealthState = projectedRatio === undefined
    ? "ok"
    : projectedRatio >= 1
      ? "exceeded"
      : projectedRatio >= threshold
        ? "warn"
        : "ok";

  return {
    monthToDate,
    requests: Math.max(0, mtd.requests),
    perDay,
    projected,
    ...(validCap === undefined ? {} : { monthlyCap: validCap }),
    ...(projectedRatio === undefined ? {} : { projectedRatio }),
    state,
    daysElapsed,
    daysInMonth,
  };
}

