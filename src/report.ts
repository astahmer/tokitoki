import type { TokitokiConfig } from "./config.ts";
import { loadConfig, type PlanConfig } from "./config.ts";
import { bar, cachePct, formatCost, formatInt, humanCount } from "./format.ts";
import type { AggRow } from "./cache.ts";
import { syncedExtraFiles } from "./sync/index.ts";

/** Rolling window boundaries in ISO-8601 UTC. */
export function sinceIsoFor(period: "day" | "week" | "month"): string {
  const now = new Date();
  if (period === "day") {
    // Local calendar day start
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return d.toISOString();
  }
  const ms = period === "week" ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000;
  return new Date(now.getTime() - ms).toISOString();
}

/**
 * Equally-sized window immediately before the current one.
 * `day` uses local calendar days; week/month roll back by their length.
 */
export function previousWindow(
  period: "day" | "week" | "month",
  now: Date = new Date(),
): { sinceIso: string; untilIso: string } {
  if (period === "day") {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const prevStart = new Date(dayStart.getTime() - 24 * 3600_000);
    return { sinceIso: prevStart.toISOString(), untilIso: dayStart.toISOString() };
  }
  const ms = period === "week" ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000;
  const until = now.getTime();
  return {
    sinceIso: new Date(until - 2 * ms).toISOString(),
    untilIso: new Date(until - ms).toISOString(),
  };
}

export function monthStartIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

/**
 * Month-to-date burn projection: total / daysElapsed * daysInMonth.
 * Includes today in daysElapsed (partial day counts as a full one — honest
 * overestimate rather than under).
 */
export function burnProjection(
  monthToDateTotal: number,
  now: Date = new Date(),
): { perDay: number; projected: number } {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const perDay = monthToDateTotal / dayOfMonth;
  return { perDay, projected: perDay * daysInMonth };
}

export function renderBurnLine(mtdCost: number, mtdRequests: number, now: Date = new Date()): string {
  const b = burnProjection(mtdCost, now);
  if (mtdCost > 0) {
    return `burn: $${b.perDay.toFixed(2)}/day → projected ${formatCost(b.projected)} by month end`;
  }
  return `burn: ${formatInt(b.perDay)} req/day → projected ${formatInt(b.projected)} req by month end`;
}

/** Signed percentage change of a metric vs its previous value. */
export interface DeltaInfo {
  /** "up" | "down" when comparable; "new" when prev=0 & cur>0; "" otherwise */
  kind: "up" | "down" | "new" | "";
  pct: number;
}

export function deltaInfo(current: number, previous: number | undefined): DeltaInfo {
  if (previous === undefined) return { kind: "", pct: 0 };
  if (previous <= 0) return current > 0 ? { kind: "new", pct: 0 } : { kind: "", pct: 0 };
  if (current <= 0) return { kind: "down", pct: 100 };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { kind: "", pct: 0 };
  return { kind: pct > 0 ? "up" : "down", pct: Math.abs(pct) };
}

export function formatDelta(d: DeltaInfo): string {
  switch (d.kind) {
    case "up":
      return `▲${d.pct}%`;
    case "down":
      return `▼${d.pct}%`;
    case "new":
      return "▲new";
    default:
      return "";
  }
}

/** Match an accountKey against config plan patterns (exact or trailing `*`). */
export function matchPlanKey(plans: Record<string, PlanConfig>, bucket: string): string | undefined {
  if (plans[bucket] !== undefined) return bucket;
  for (const key of Object.keys(plans)) {
    if (key.endsWith("*") && bucket.startsWith(key.slice(0, -1))) return key;
  }
  return undefined;
}

/**
 * Build a gauge-cell renderer for rows matching configured plans. Usage is
 * measured month-to-date vs user-configured caps (providers don't expose
 * plan quotas — these are estimates).
 */
export function planGaugeFn(
  plans: Record<string, PlanConfig> | undefined,
  mtdByAccount: Map<string, AggRow>,
): ((bucket: string) => string | undefined) | undefined {
  if (plans === undefined || Object.keys(plans).length === 0) return undefined;
  return (bucket: string): string | undefined => {
    const key = matchPlanKey(plans, bucket);
    if (key === undefined) return undefined;
    const plan = plans[key]!;
    const usage = mtdByAccount.get(bucket);
    if (usage === undefined) return `${bar(0, 10, "▇")} 0%`;
    let frac: number;
    let label: string;
    if (plan.monthlyRequestCap !== undefined && plan.monthlyRequestCap > 0) {
      frac = usage.requests / plan.monthlyRequestCap;
      label = `of ${humanCount(plan.monthlyRequestCap)} req cap`;
    } else if (plan.monthlyCostCap !== undefined && plan.monthlyCostCap > 0) {
      frac = usage.costUsd / plan.monthlyCostCap;
      label = `of ${formatCost(plan.monthlyCostCap)} cap`;
    } else {
      return undefined;
    }
    return `${bar(frac, 10, "▇")} ${Math.round(frac * 100)}% ${label}`;
  };
}

export function resolveExtraFiles(config?: TokitokiConfig): string[] {
  const cfg = config ?? loadConfig();
  const extra = [...(cfg.extraEventFiles ?? []), ...syncedExtraFiles()];
  return extra.filter((f) => typeof f === "string" && f.length > 0);
}

export type SortColumn =
  | "bucket"
  | "requests"
  | "sessions"
  | "avgTokensPerReq"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "costUsd"
  | "cachePct";

const SORT_ALIASES: Record<string, SortColumn> = {
  name: "bucket",
  bucket: "bucket",
  requests: "requests",
  req: "requests",
  sessions: "sessions",
  sess: "sessions",
  avg: "avgTokensPerReq",
  "avg/req": "avgTokensPerReq",
  input: "inputTokens",
  output: "outputTokens",
  cache: "cacheReadTokens",
  "cache-read": "cacheReadTokens",
  cachepct: "cachePct",
  "%cache": "cachePct",
  pct: "cachePct",
  cost: "costUsd",
};

export function resolveSortColumn(raw: string): SortColumn | undefined {
  return SORT_ALIASES[raw.toLowerCase().replaceAll("_", "-")];
}

/** Total tokens across all token kinds. */
export function totalTokens(row: AggRow): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
}

export function avgTokensPerReq(row: AggRow): number {
  if (row.requests <= 0) return 0;
  return totalTokens(row) / row.requests;
}

export function sortValue(row: AggRow, column: SortColumn): number | string {
  switch (column) {
    case "bucket":
      return row.bucket;
    case "requests":
      return row.requests;
    case "sessions":
      return row.sessions;
    case "avgTokensPerReq":
      return avgTokensPerReq(row);
    case "inputTokens":
      return row.inputTokens;
    case "outputTokens":
      return row.outputTokens;
    case "cacheReadTokens":
      return row.cacheReadTokens;
    case "cachePct":
      return cachePct(row.inputTokens, row.cacheReadTokens);
    case "costUsd":
      return row.costUsd;
  }
}

/**
 * Sort rows by column. Default order is cost desc then requests desc;
 * an explicit column sorts by it (asc unless `asc`), ties broken by
 * requests descending.
 */
export function sortRows(rows: AggRow[], column?: SortColumn, asc?: boolean): AggRow[] {
  const sorted = [...rows];
  if (column === undefined) {
    sorted.sort(
      (a, b) => b.costUsd - a.costUsd || b.requests - a.requests || a.bucket.localeCompare(b.bucket),
    );
    return sorted;
  }
  const dir = asc === true ? 1 : -1;
  sorted.sort((a, b) => {
    const va = sortValue(a, column);
    const vb = sortValue(b, column);
    let cmp: number;
    if (typeof va === "string" || typeof vb === "string") {
      cmp = String(va).localeCompare(String(vb));
    } else {
      cmp = va - vb;
    }
    return cmp * dir || b.requests - a.requests || a.bucket.localeCompare(b.bucket);
  });
  return sorted;
}

export function totalRow(rows: AggRow[]): AggRow {
  return rows.reduce<AggRow>(
    (acc, r) => ({
      bucket: "TOTAL",
      requests: acc.requests + r.requests,
      sessions: acc.sessions + r.sessions,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    {
      bucket: "TOTAL",
      requests: 0,
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
  );
}

const HEADER = ["name", "req", "sess", "avg/req", "input", "output", "cache", "%cache", "%share", "cost"];

/** Optional context that enriches the table beyond plain aggregation. */
export interface TableContext {
  /** Precomputed TOTAL row (global distinct sessions) — falls back to summing rows. */
  total?: AggRow;
  /** Previous-period cost per bucket, for Δ rendering next to cost. */
  prevCostById?: Map<string, number>;
  /** Previous-period TOTAL cost, for the TOTAL row's Δ. */
  totalPrevCost?: number;
  /** Returns a gauge cell for buckets matching a configured plan. */
  gaugeFor?: (bucket: string) => string | undefined;
  /** TTY colorizer for delta strings; receives ("▲12%", "up"|"down"). */
  colorizeDelta?: (text: string, kind: "up" | "down") => string;
}

function deltaCell(costCell: string, cost: number, prev: number | undefined, ctx: TableContext): string {
  if (!ctx.colorizeDelta && ctx.prevCostById === undefined && ctx.totalPrevCost === undefined) {
    return costCell;
  }
  const d = deltaInfo(cost, prev);
  if (d.kind === "") return costCell;
  const text = formatDelta(d);
  const colored = ctx.colorizeDelta !== undefined && (d.kind === "up" || d.kind === "down")
    ? ctx.colorizeDelta(text, d.kind)
    : text;
  return `${costCell} ${colored}`;
}

export function renderTable(rows: AggRow[], ctx: TableContext = {}): string {
  if (rows.length === 0) return "no usage recorded in this window — run `tokitoki scan` first";

  const totals = ctx.total ?? totalRow(rows);
  // Share basis: cost when any cost is recorded, tokens otherwise.
  const shareByCost = totals.costUsd > 0;
  const grandTotal = shareByCost ? totals.costUsd : totals.inputTokens + totals.outputTokens + totals.cacheReadTokens;

  const cellsFor = (r: AggRow, name?: string): string[] => {
    const shareRaw = shareByCost ? r.costUsd : totalTokens(r);
    const sharePct = grandTotal > 0 ? Math.round((shareRaw / grandTotal) * 100) : 0;
    const gauge = ctx.gaugeFor?.(name ?? r.bucket);
    const baseCost = gauge ?? formatCost(r.costUsd);
    const prev = ctx.prevCostById?.get(r.bucket);
    return [
      name ?? r.bucket,
      formatInt(r.requests),
      formatInt(r.sessions),
      humanCount(avgTokensPerReq(r)),
      humanCount(r.inputTokens),
      humanCount(r.outputTokens),
      humanCount(r.cacheReadTokens),
      `${cachePct(r.inputTokens, r.cacheReadTokens)}%`,
      `${sharePct}%`,
      deltaCell(baseCost, r.costUsd, prev, ctx),
    ];
  };

  const body = rows.map((r) => cellsFor(r));
  const totalCells = cellsFor(totals);
  totalCells[0] = "TOTAL";
  // TOTAL Δ compares against the previous window's global total.
  if (ctx.prevCostById !== undefined || ctx.totalPrevCost !== undefined) {
    totalCells[9] = deltaCell(formatCost(totals.costUsd), totals.costUsd, ctx.totalPrevCost, ctx);
  }

  const all = [HEADER, ...body, ["-", ...totalCells.slice(1)]];
  const widths = HEADER.map((_, i) => Math.max(...all.map((row) => row[i]?.length ?? 0)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");

  const out = [line(HEADER), widths.map((w) => "-".repeat(w ?? 0)).join("  ")];
  for (const cells of body) out.push(line(cells));
  out.push(widths.map((w) => "-".repeat(w ?? 0)).join("  "));
  out.push(line(totalCells));
  return out.join("\n");
}

const MINI_HEADER = ["project", "req", "tokens", "%cache"];

/** Small secondary breakdown used by `today` (top projects this month). */
export function renderMiniProjects(rows: AggRow[]): string {
  if (rows.length === 0) return "";
  const cellsFor = (r: AggRow): string[] => [
    r.bucket,
    formatInt(r.requests),
    humanCount(totalTokens(r)),
    `${cachePct(r.inputTokens, r.cacheReadTokens)}%`,
  ];
  const body = rows.map(cellsFor);
  const all = [MINI_HEADER, ...body];
  const widths = MINI_HEADER.map((_, i) => Math.max(...all.map((row) => row[i]?.length ?? 0)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  const out = [line(MINI_HEADER), widths.map((w) => "-".repeat(w ?? 0)).join("  ")];
  for (const cells of body) out.push(line(cells));
  return out.join("\n");
}
