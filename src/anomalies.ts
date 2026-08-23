import type { DailyTotal } from "./cache.ts";

/**
 * Spike detection: flag days whose metric dwarfs the trailing 14-day baseline.
 *
 * Rules (documented in help + README):
 * - baseline = mean of the 14 calendar days BEFORE the day under test
 *   (missing days count as zero — a quiet stretch lowers the bar honestly)
 * - spike when value > 3× baseline
 * - slow periods (fewer than 5 nonzero baseline days) use a gentler 2× so
 *   "first busy day after vacation" still surfaces without crying wolf on
 *   every first-usage day: an absolute floor also applies (see MIN_VALUE)
 * - today is never flagged: it's a partial day
 */

export type AnomalyMetric = "tokens" | "cost" | "requests";

export const ANOMALY_METRICS: AnomalyMetric[] = ["tokens", "cost", "requests"];

/** Absolute minimum value before a day can even be considered a spike. */
const MIN_VALUE: Record<AnomalyMetric, number> = {
  tokens: 50_000,
  cost: 0.5,
  requests: 10,
};

export interface Anomaly {
  day: string;
  metric: AnomalyMetric;
  value: number;
  /** Mean of the trailing window */
  baseline: number;
  /** value / baseline (∞ → capped at 0 for display; guarded by MIN_VALUE) */
  ratio: number;
}

export interface AnomalyOptions {
  metric?: AnomalyMetric;
  /** Trailing calendar days forming the baseline (default 14). */
  windowDays?: number;
  /** Standard multiplier (default 3). */
  spikeRatio?: number;
  /** Multiplier for slow periods (default 2). */
  slowSpikeRatio?: number;
  /** Nonzero days required in the baseline to count as "not slow". */
  slowMinActiveDays?: number;
  /** Today's local date (excluded from detection); default = actual today. */
  now?: Date;
}

function metricOf(d: DailyTotal, metric: AnomalyMetric): number {
  if (metric === "cost") return d.costUsd;
  if (metric === "requests") return d.requests;
  return d.tokens;
}

export function detectAnomalies(days: DailyTotal[], opts: AnomalyOptions = {}): Anomaly[] {
  const metric = opts.metric ?? "tokens";
  const windowDays = opts.windowDays ?? 14;
  const spikeRatio = opts.spikeRatio ?? 3;
  const slowRatio = opts.slowSpikeRatio ?? 2;
  const slowMinActive = opts.slowMinActiveDays ?? 5;

  const now = opts.now ?? new Date();
  const todayIso = localIso(now);
  const byDay = new Map(days.map((d) => [d.day, d]));

  // Days need a full baseline window of observed history before they can be
  // judged, otherwise the first days after import/scan always look spiky.
  const sortedDates = [...byDay.keys()].sort();
  if (sortedDates.length === 0) return [];
  const firstDate = new Date(`${sortedDates[0]!}T12:00:00`);
  const minHistoryCutoff = new Date(firstDate);
  minHistoryCutoff.setDate(minHistoryCutoff.getDate() + windowDays);

  const out: Anomaly[] = [];
  const ordered = [...days].sort((a, b) => a.day.localeCompare(b.day));
  for (const point of ordered) {
    if (point.day >= todayIso) continue; // partial day — never flag
    if (new Date(`${point.day}T12:00:00`) < minHistoryCutoff) continue; // not enough history
    const value = metricOf(point, metric);
    let baseSum = 0;
    let active = 0;
    for (let i = 1; i <= windowDays; i++) {
      const probe = new Date(`${point.day}T12:00:00`);
      probe.setDate(probe.getDate() - i);
      const prev = byDay.get(localIso(probe));
      const v = prev === undefined ? 0 : metricOf(prev, metric);
      baseSum += v;
      if (v > 0) active++;
    }
    const baseline = baseSum / windowDays;
    if (value < MIN_VALUE[metric]) continue;
    if (baseline <= 0) continue; // first-ever usage day: not a "spike"
    const threshold = active < slowMinActive ? slowRatio : spikeRatio;
    const ratio = value / baseline;
    if (ratio > threshold) {
      out.push({ day: point.day, metric, value, baseline, ratio });
    }
  }
  return out;
}

export function anomalyFooter(anomalies: Anomaly[]): string {
  if (anomalies.length === 0) return "";
  const parts = anomalies.slice(0, 4).map((a) => `${a.day} (${a.ratio.toFixed(1)}x)`);
  const more = anomalies.length > 4 ? ` +${anomalies.length - 4} more` : "";
  return `▲ unusual activity: ${parts.join(", ")}${more}`;
}

function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
