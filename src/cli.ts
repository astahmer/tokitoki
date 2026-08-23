#!/usr/bin/env bun
import { parseArgs, type ParsedInvocation } from "./args.ts";
import { localMachineId } from "./machine.ts";
import { PROVIDERS, getProvider } from "./providers/index.ts";
import { scanProvider } from "./scan.ts";
import { DIMENSIONS, EventCache, type AggRow, type Dimension, type SeriesBucket } from "./cache.ts";
import { renderTable, renderMiniProjects, resolveExtraFiles, resolveSortColumn, sinceIsoFor, previousWindow, monthStartIso, sortRows, formatDelta, deltaInfo, totalRow, totalTokens, planGaugeFn, renderBurnLine } from "./report.ts";
import { bar, formatCost, humanCount, sparkline } from "./format.ts";
import { loadConfig } from "./config.ts";
import { getSyncBackend, runSync } from "./sync/index.ts";
import type { SyncConfig } from "./sync/types.ts";
import { startWebServer } from "./web/server.ts";

type Period = "day" | "week" | "month";

const PERIODS: Period[] = ["day", "week", "month"];
const CHART_DIMENSIONS = ["provider", "model"] as const;

const HELP = `tokitoki — unified coding-agent usage analytics

Usage: tokitoki <command> [options]

Commands:
  scan [--provider <id>]                     incrementally scan harness stores
  report --last <day|week|month>             aggregate over a rolling window
      [--by model|project|account|machine|provider] [--json]
      [--sort requests|sessions|avg|input|output|cache|%cache|cost|name]
      [--asc] [--provider <id>]... [--delta/--no-delta]
  today | week | month                       shortcuts for report
  chart [--last day|week|month]              daily token evolution as ASCII bars
      [--by provider|model] [--spark]
  pie [--last day|week|month]                share-of-tokens legend w/ cost bars
      [--by provider|model]
  sync [--backend dir|git|atproto]           push/pull events across machines
      [--push|--pull|--both] (default: both; backend + url/path from [sync]
      in config.toml)
  web [--port <n>]                           local dashboard (default :7788)

Global: --help`;

function main(argv: string[]): void {
  const parsed = parseArgs(argv);
  if (parsed.command === undefined || parsed.flags.help === true || parsed.command === "help") {
    console.log(HELP);
    return;
  }


  switch (parsed.command) {
    case "scan":
      runScan(parsed);
      break;
    case "report":
      runReport(parsed);
      break;
    case "today":
    case "week":
    case "month":
      runShortcut(parsed);
      break;
    case "chart":
      runChart(parsed);
      break;
    case "pie":
      runPie(parsed);
      break;
    case "sync":
      runSyncCommand(parsed);
      break;
    case "web":
      runWeb(parsed);
      break;
    default:
      console.error(`unknown command: ${parsed.command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

function flagString(parsed: ParsedInvocation, key: string): string | undefined {
  const v = parsed.flags[key];
  return typeof v === "string" ? v : undefined;
}

function flagBool(parsed: ParsedInvocation, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === "true";
}

function flagStrings(parsed: ParsedInvocation, key: string): string[] {
  const v = parsed.flags[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [v as string];
}

function resolvePeriod(raw: string | undefined): Period {
  const period = raw ?? "month";
  if (!PERIODS.includes(period as Period)) {
    throw new UserError(`invalid period: ${period} (valid: ${PERIODS.join(", ")})`);
  }
  return period as Period;
}

class UserError extends Error {}

function withCache<T>(fn: (cache: EventCache) => T): T {
  const cache = new EventCache();
  try {
    return fn(cache);
  } finally {
    cache.close();
  }
}

// ---------------------------------------------------------------- scan

function runScan(parsed: ParsedInvocation): void {
  const only = flagString(parsed, "provider");
  const providers = only !== undefined ? [getProvider(only)] : [...PROVIDERS];
  for (const p of providers) {
    if (p === undefined) {
      console.error(
        `unknown provider: ${only} (known: ${PROVIDERS.map((x) => x.id).join(", ")})`,
      );
      process.exitCode = 1;
      return;
    }
    const result = scanProvider(p, localMachineId());
    console.log(
      `${result.provider}: +${result.eventsEmitted} events (${result.filesScanned} files updated)`,
    );
  }
}

// ---------------------------------------------------------------- report

interface ReportOptions {
  period: Period;
  groupBy: Dimension;
  json: boolean;
  sort?: ReturnType<typeof resolveSortColumn>;
  asc: boolean;
  providers: string[];
  delta: boolean;
}

function reportOptions(parsed: ParsedInvocation, defaultPeriod?: Period): ReportOptions {
  const periodRaw = defaultPeriod ?? flagString(parsed, "last");
  if (periodRaw === undefined) throw new UserError("report requires --last <day|week|month>");
  const period = resolvePeriod(periodRaw);

  const groupBy = (flagString(parsed, "by") ?? "model") as Dimension;
  if (!DIMENSIONS.includes(groupBy)) {
    throw new UserError(`invalid --by: ${groupBy} (valid: ${DIMENSIONS.join(", ")})`);
  }

  const sortRaw = flagString(parsed, "sort");
  let sort: ReportOptions["sort"];
  if (sortRaw !== undefined) {
    sort = resolveSortColumn(sortRaw);
    if (sort === undefined) {
      throw new UserError(
        `invalid --sort: ${sortRaw} (valid: requests, sessions, avg, input, output, cache, %cache, cost, name)`,
      );
    }
  }

  // --delta is the default; --no-delta disables Δ vs previous period.
  const delta = parsed.flags["no-delta"] === true ? false : flagBool(parsed, "delta") || parsed.flags["delta"] === undefined;

  return {
    period,
    groupBy,
    json: flagBool(parsed, "json"),
    sort,
    asc: flagBool(parsed, "asc"),
    providers: flagStrings(parsed, "provider"),
    delta,
  };
}

function runReport(parsed: ParsedInvocation): void {
  const opts = reportOptions(parsed);
  try {
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const sinceIso = sinceIsoFor(opts.period);
      const rows = cache.aggregate(sinceIso, opts.groupBy, opts.providers);
      if (opts.json) {
        return JSON.stringify({ period: opts.period, groupBy: opts.groupBy, rows }, null, 2);
      }

      const ctx: Parameters<typeof renderTable>[1] = {};
      ctx.total = cache.totals(sinceIso, opts.providers);
      if (opts.delta) {
        const prev = previousWindow(opts.period);
        const prevRows = cache.aggregate(prev.sinceIso, opts.groupBy, opts.providers, prev.untilIso);
        ctx.prevCostById = new Map(prevRows.map((r) => [r.bucket, r.costUsd]));
        ctx.totalPrevCost = cache.totals(prev.sinceIso, opts.providers, prev.untilIso).costUsd;
      }
      const cfg = loadConfig();
      if (cfg.plans !== undefined && Object.keys(cfg.plans).length > 0) {
        const mtdByAccount = new Map(
          cache.aggregate(monthStartIso(), "account", opts.providers).map((r) => [r.bucket, r]),
        );
        ctx.gaugeFor = planGaugeFn(cfg.plans, mtdByAccount);
      }
      if (opts.delta && process.env.NO_COLOR === undefined) {
        ctx.colorizeDelta = deltaColorizer;
      }

      let text = renderTable(sortRows(rows, opts.sort, opts.asc), ctx);
      if (opts.period === "month") {
        const mtd = ctx.total ?? totalRow(rows);
        text += `\n${renderBurnLine(mtd.costUsd, mtd.requests)}`;
      }
      return text;
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

function runShortcut(parsed: ParsedInvocation): void {
  const synthetic: ParsedInvocation = {
    ...parsed,
    flags: { ...parsed.flags, last: shortcutPeriod(parsed.command!) },
  };
  if (parsed.command === "today") {
    runToday(synthetic);
    return;
  }
  runReport(synthetic);
}

function runToday(parsed: ParsedInvocation): void {
  try {
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const sinceIso = sinceIsoFor("day");
      const rows = cache.aggregate(sinceIso, "model", flagStrings(parsed, "provider"));
      const total = cache.totals(sinceIso, flagStrings(parsed, "provider"));
      let text = renderTable(sortRows(rows), { total });
      // Burn projection + top-3 projects this month
      const mtd = cache.totals(monthStartIso(), flagStrings(parsed, "provider"));
      text += `\n${renderBurnLine(mtd.costUsd, mtd.requests)}`;
      const projects = cache
        .aggregate(monthStartIso(), "project")
        .sort((a, b) => totalTokens(b) - totalTokens(a))
        .slice(0, 3);
      const mini = renderMiniProjects(projects);
      if (mini.length > 0) text += `\n\ntop projects (month-to-date):\n${mini}`;
      return text;
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

function shortcutPeriod(command: string): string {
  return command === "today" ? "day" : command === "week" ? "week" : "month";
}

// ---------------------------------------------------------------- chart

function runChart(parsed: ParsedInvocation): void {
  try {
    const period = resolvePeriod(flagString(parsed, "last"));
    const spark = flagBool(parsed, "spark");
    const by = flagString(parsed, "by");
    if (by !== undefined && !CHART_DIMENSIONS.includes(by as (typeof CHART_DIMENSIONS)[number])) {
      throw new UserError(`invalid --by for chart: ${by} (valid: ${CHART_DIMENSIONS.join(", ")})`);
    }

    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      if (spark) return sparkSection(cache, period, by);
      const sinceIso = sinceIsoFor(period);
      const days = cache.dailyTotals(sinceIso);
      if (days.length === 0) return "no usage recorded in this window — run `tokitoki scan` first";
      const max = Math.max(...days.map((d) => d.tokens));
      const bars = days
        .map((d) => `${d.day}  ${coloredBar(max > 0 ? d.tokens / max : 0, 30)}  ${humanCount(d.tokens)}`)
        .join("\n");
      // Δ vs the equally-sized previous window (total tokens)
      const prev = previousWindow(period);
      const curTotal = totalTokens(cache.totals(sinceIso));
      const prevTotal = cache.totals(prev.sinceIso, undefined, prev.untilIso);
      const prevTokens = prevTotal.inputTokens + prevTotal.outputTokens + prevTotal.cacheReadTokens + prevTotal.cacheWriteTokens;
      const d = deltaInfo(curTotal, prevTokens);
      const deltaLine = d.kind === "" ? null : `Δ vs previous period: ${formatDelta(d)} (tokens)`;
      return deltaLine === null ? bars : `${bars}\n${deltaLine}`;
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- pie

function runPie(parsed: ParsedInvocation): void {
  try {
    const period = resolvePeriod(flagString(parsed, "last"));
    const groupBy = (flagString(parsed, "by") ?? "provider") as Dimension;
    if (groupBy !== "provider" && groupBy !== "model") {
      throw new UserError(`invalid --by for pie: ${groupBy} (valid: provider, model)`);
    }

    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const rows = cache.aggregate(sinceIsoFor(period), groupBy, flagStrings(parsed, "provider"));
      return renderPie(rows);
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

export function renderPie(rows: AggRow[]): string {
  if (rows.length === 0) return "no usage recorded in this window — run `tokitoki scan` first";

  const totalTokensOf = (r: AggRow): number =>
    r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
  const grandTotal = rows.reduce((sum, r) => sum + totalTokensOf(r), 0);

  const sorted = [...rows].sort((a, b) => totalTokensOf(b) - totalTokensOf(a));
  const nameWidth = Math.max(...sorted.map((r) => r.bucket.length), "TOTAL".length);

  const lines: string[] = [];
  for (const r of sorted) {
    const tokens = totalTokensOf(r);
    const share = grandTotal > 0 ? tokens / grandTotal : 0;
    lines.push(
      `${r.bucket.padEnd(nameWidth)}  ${bar(share, 20)}  ${Math.round(share * 100)}%  ${formatCost(r.costUsd)}`,
    );
  }
  lines.push("-".repeat(nameWidth + 30));
  lines.push(
    `${"TOTAL".padEnd(nameWidth)}  ${bar(1, 20)}  100%  ${formatCost(sorted.reduce((s, r) => s + r.costUsd, 0))}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------- sync

function runSyncCommand(parsed: ParsedInvocation): void {
  const modeRaw = flagBool(parsed, "pull") ? "pull" : flagBool(parsed, "push") ? "push" : "both";
  const backendOverride = flagString(parsed, "backend");
  try {
    const cfg = loadConfig();
    const syncCfg: SyncConfig = { ...cfg.sync };
    if (backendOverride !== undefined) syncCfg.backend = backendOverride as SyncConfig["backend"];
    if (
      parsed.flags["sync-atproto"] === true &&
      syncCfg.backend !== "atproto" &&
      syncCfg.handle !== undefined
    ) {
      syncCfg.backend = "atproto";
    }
    const adapter = getSyncBackend(syncCfg);
    console.log(`sync via ${adapter.label} (${modeRaw})...`);
    runSync(adapter, modeRaw)
      .then((result) => {
        console.log(
          `pushed ${result.pushed} lines · pulled ${result.pulledValid} valid / ${result.pulledInvalid} skipped`,
        );
      })
      .catch(handleErrorAsync);
  } catch (err) {
    handleError(err);
  }
}

function handleErrorAsync(err: unknown): void {
  if (err instanceof UserError || err instanceof Error) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  throw err;
}

// ---------------------------------------------------------------- web

function runWeb(parsed: ParsedInvocation): void {
  try {
    const port = Number(flagString(parsed, "port") ?? "7788");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new UserError(`invalid --port: ${port}`);
    }
    const server = startWebServer({ port });
    console.log(`tokitoki dashboard → http://localhost:${server.port}`);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- helpers

/** Daily evolution as compact sparklines (one row per top bucket). */
function sparkSection(cache: EventCache, period: Period, by: string | undefined): string {
  let series: SeriesBucket[];
  if (by === "model" || by === "provider") {
    series = cache.seriesDaily(sinceIsoFor(period), by);
  } else {
    const days = cache.dailyTotals(sinceIsoFor(period));
    series = [
      { bucket: "total", days: days.map((d) => d.day), values: days.map((d) => d.tokens) },
    ];
  }
  if (series.length === 0 || series.every((s) => s.values.every((v) => v === 0))) {
    return "no usage recorded in this window — run `tokitoki scan` first";
  }
  const nameWidth = Math.max(...series.map((s) => s.bucket.length));
  return series
    .map(
      (s) =>
        `${s.bucket.padEnd(nameWidth)}  ${coloredSpark(sparkline(s.values))}  ${humanCount(Math.max(...s.values))}`,
    )
    .join("\n");
}

function coloredBar(fraction: number, width: number): string {
  const text = bar(fraction, width);
  if (process.stdout.isTTY !== true) return text;
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return `\x1b[32m${text.slice(0, filled)}\x1b[0m${text.slice(filled)}`;
}

function coloredSpark(text: string): string {
  return process.stdout.isTTY === true ? `\x1b[36m${text}\x1b[0m` : text;
}

/** ▲ green when spend rose, ▼ red when it fell — color only on a TTY. */
function deltaColorizer(text: string, kind: "up" | "down"): string {
  if (process.stdout.isTTY !== true) return text;
  return kind === "up" ? `\x1b[32m${text}\x1b[0m` : `\x1b[31m${text}\x1b[0m`;
}

function handleError(err: unknown): void {
  if (err instanceof UserError) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  throw err;
}

main(process.argv.slice(2));
