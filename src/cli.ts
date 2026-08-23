#!/usr/bin/env bun
import { parseArgs, type ParsedInvocation } from "./args.ts";
import { localMachineId } from "./machine.ts";
import { PROVIDERS, getProvider } from "./providers/index.ts";
import { scanProvider } from "./scan.ts";
import { DIMENSIONS, EventCache, type AggRow, type Dimension, type SeriesBucket } from "./cache.ts";
import { renderTable, renderMiniProjects, resolveExtraFiles, resolveSortColumn, sinceIsoFor, sinceIsoForDays, previousWindow, monthStartIso, sortRows, formatDelta, deltaInfo, totalRow, totalTokens, planGaugeFn, renderBurnLine, burnProjection } from "./report.ts";
import { accountEmailMap } from "./accounts.ts";
import { renderGrid } from "./grid.ts";
import { bar, formatCost, humanCount, sparkline } from "./format.ts";
import { loadConfig } from "./config.ts";
import { getSyncBackend, runSync } from "./sync/index.ts";
import type { SyncConfig } from "./sync/types.ts";
import { startWebServer } from "./web/server.ts";

type Period = "day" | "week" | "month";

const PERIODS: Period[] = ["day", "week", "month"];
const CHART_DIMENSIONS = ["provider", "model"] as const;

const DIMENSION_LIST = "model|provider|account|machine|project|repo";

interface CommandHelp {
  usage: string;
  flags: string;
  example?: string;
}

const COMMAND_HELP: Record<string, CommandHelp> = {
  scan: {
    usage: "tokitoki scan [--provider <id>]",
    flags: "  --provider <id>   only scan this harness (repeatable not allowed here)",
    example: "tokitoki scan",
  },
  report: {
    usage: "tokitoki report [--last day|week|month] [--by <dimension>]",
    flags: `  --last day|week|month     rolling window (default: week)
  --since YYYY-MM-DD        absolute range start (disables Δ)
  --until YYYY-MM-DD        absolute range end, inclusive
  --by ${DIMENSION_LIST}
  --sort requests|sessions|avg|input|output|cache|%cache|%share|cost|name
  --asc                     ascending sort
  --provider <id>           filter (repeatable)
  --delta / --no-delta      Δ vs previous window (default: delta)
  --show-email              render account rows as name <email> (implies --by account
                            unless an explicit --by is given)
  --json                    machine-readable output`,
    example: "tokitoki report --last week --by provider",
  },
  export: {
    usage: "tokitoki export [--format csv|json] [--out <file>]",
    flags: `  same filters/sorting as report (--last/--since/--until/--by/--provider/--sort)
  --format csv|json         output format (default: csv)
  --out <file>              write to file instead of stdout`,
    example: "tokitoki export --last month --by repo --format csv --out usage.csv",
  },
  today: {
    usage: "tokitoki today",
    flags: "  shortcut for report --last day (plus top projects this month)",
    example: "tokitoki today",
  },
  week: { usage: "tokitoki week", flags: "  shortcut for report --last week", example: "tokitoki week" },
  month: { usage: "tokitoki month", flags: "  shortcut for report --last month", example: "tokitoki month" },
  chart: {
    usage: "tokitoki chart [--last day|week|month]",
    flags: "  --by provider|model   one sparkline row per bucket\n  --spark               compact inline sparklines\n  (default period: week)",
    example: "tokitoki chart --last month --spark",
  },
  pie: {
    usage: "tokitoki pie [--last day|week|month] [--by provider|model]",
    flags: "  share-of-tokens legend bars with cost (default period: week)",
    example: "tokitoki pie --last week",
  },
  grid: {
    usage: "tokitoki grid [--last month|quarter|year]",
    flags: "  --metric tokens|cost|requests   cell intensity (default: tokens)\n  (default window: month)",
    example: "tokitoki grid --last quarter",
  },
  sync: {
    usage: "tokitoki sync [--backend dir|git|atproto] [--push|--pull|--both]",
    flags: "  backend + remote come from the [sync] section of config.toml;\n  --backend overrides it for this run. Default mode: both.",
    example: "tokitoki sync --backend git --push",
  },
  web: {
    usage: "tokitoki web [--port <n>]",
    flags: "  local dashboard, default port 7788",
    example: "tokitoki web",
  },
};

function commandHelpText(id: string): string {
  const h = COMMAND_HELP[id];
  if (h === undefined) return `unknown command: ${id}`;
  return `${h.usage}\n\nFlags:\n${h.flags}${h.example !== undefined ? `\n\nExample:\n  ${h.example}` : ""}`;
}

function printHelp(topic?: string): void {
  if (topic === undefined) {
    console.log(GLOBAL_HELP);
    return;
  }
  if (COMMAND_HELP[topic] !== undefined) {
    console.log(commandHelpText(topic));
    return;
  }
  const close = closestMatch(topic, Object.keys(COMMAND_HELP));
  console.error(
    `error: no help topic '${topic}'` + (close !== null ? ` — did you mean '${close}'?` : "") +
      `\ntry: tokitoki --help`,
  );
  process.exitCode = 1;
}

const GLOBAL_HELP = `tokitoki — unified coding-agent usage analytics

Usage: tokitoki <command> [options]

Commands:
  scan       incrementally scan harness stores into the local cache
  report     aggregate a rolling window (--last day|week|month, default week)
  today      shortcut for report --last day (+ top projects MTD)
  week       shortcut for report --last week
  month      shortcut for report --last month
  chart      daily token evolution as ASCII bars / sparklines
  pie        share-of-tokens legend with cost bars
  grid       GitHub-style calendar heatmap (horizontal, weeks = columns)
  sync       push/pull events across machines (dir | git | atproto backends)
  web        local dashboard (default :7788)

Run 'tokitoki help <command>' or 'tokitoki <command> --help' for details.
`;

function main(argv: string[]): void {
  // -h/--help wins over everything, including per-command validation.
  if (argv.includes("-h") || argv.includes("--help")) {
    const cmd = argv.find((a) => !a.startsWith("-") && a !== "help");
    printHelp(cmd);
    return;
  }
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === undefined || parsed.command === "help") {
      printHelp(parsed.rest[0]);
      return;
    }
    assertKnownFlags(parsed.command, parsed.flags);
    switch (parsed.command) {
      case "scan": runScan(parsed); break;
      case "report": runReport(parsed); break;
      case "export": runExport(parsed); break;
      case "today": case "week": case "month": runShortcut(parsed); break;
      case "chart": runChart(parsed); break;
      case "pie": runPie(parsed); break;
      case "grid": runGrid(parsed); break;
      case "sync": runSyncCommand(parsed); break;
      case "web": runWeb(parsed); break;
      default: {
        const close = closestMatch(parsed.command, Object.keys(COMMAND_HELP));
        console.error(
          `error: unknown command '${parsed.command}'` +
            (close !== null ? ` — did you mean '${close}'?` : "") +
            `\ntry: tokitoki --help`,
        );
        process.exitCode = 1;
      }
    }
  } catch (err) {
    handleError(err);
  }
}

/** Flags each command accepts — anything else is a typo we can suggest around. */
const KNOWN_FLAGS: Record<string, string[]> = {
  scan: ["provider"],
  report: ["last", "by", "json", "sort", "asc", "provider", "delta", "no-delta", "show-email", "show-emails", "since", "until"],
  today: ["provider", "json", "show-email", "show-emails"],
  week: ["provider", "json", "show-email", "show-emails"],
  month: ["provider", "json", "show-email", "show-emails"],
  chart: ["last", "by", "spark", "provider"],
  pie: ["last", "by", "provider"],
  grid: ["last", "metric"],
  sync: ["backend", "push", "pull", "both", "sync-atproto"],
  export: ["last", "by", "format", "out", "sort", "asc", "provider", "since", "until", "show-email", "show-emails"],
  web: ["port"],
  help: [],
};

function assertKnownFlags(command: string, flags: Record<string, unknown>): void {
  const known = KNOWN_FLAGS[command];
  if (known === undefined) return;
  for (const key of Object.keys(flags)) {
    if (known.includes(key)) continue;
    const close = closestMatch(key, known);
    let msg = `unknown flag '--${key}' for '${command}'`;
    if (close !== null) msg += ` — did you mean '--${close}'?`;
    throw new UserError(msg, `tokitoki ${command} --help`);
  }
}

/** Nearest existing alternative (null when nothing is close enough). */
export function closestMatch(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = levenshtein(input.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
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

function resolvePeriod(raw: string | undefined, fallback: Period = "week"): Period {
  const period = raw ?? fallback;
  if (!PERIODS.includes(period as Period)) {
    throw new UserError(
      `invalid period: ${period} (valid: ${PERIODS.join(", ")})`,
      `tokitoki report --last ${fallback}`,
    );
  }
  return period as Period;
}

export class UserError extends Error {
  /** Exact next command that fixes the problem, printed as a dimmed hint. */
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

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
      throw new UserError(
        `unknown provider: ${only}`,
        `tokitoki scan (known: ${PROVIDERS.map((x) => x.id).join(", ")})`,
      );
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
  /** Absolute range override (YYYY-MM-DD, inclusive). Disables Δ. */
  since?: string;
  until?: string;
}

function reportOptions(parsed: ParsedInvocation, defaultPeriod?: Period): ReportOptions {
  const explicitBy = flagString(parsed, "by");
  const showEmailRequested = flagBool(parsed, "show-email") || flagBool(parsed, "show-emails");
  // Emails key off accounts: --show-email implies --by account unless the user
  // picked a dimension explicitly.
  const groupByRaw = explicitBy ?? (showEmailRequested ? "account" : undefined);
  const period = resolvePeriod(defaultPeriod ?? flagString(parsed, "last"), "week");
  const groupBy = (groupByRaw ?? "model") as Dimension;
  if (!DIMENSIONS.includes(groupBy)) {
    throw new UserError(
      `invalid --by: ${groupBy} (valid: ${DIMENSIONS.join(", ")})`,
      "tokitoki report --by model",
    );
  }

  const sortRaw = flagString(parsed, "sort");
  let sort: ReportOptions["sort"];
  if (sortRaw !== undefined) {
    sort = resolveSortColumn(sortRaw);
    if (sort === undefined) {
      throw new UserError(
        `invalid --sort: ${sortRaw} (valid: requests, sessions, avg, input, output, cache, %cache, %share, cost, name)`,
        "tokitoki report --last week",
      );
    }
  }

  // --delta is the default; --no-delta disables Δ vs previous period.
  // Explicit --since/--until ranges also disable it (there is no "previous range").
  const delta = parsed.flags["no-delta"] === true ? false : flagBool(parsed, "delta") || parsed.flags["delta"] === undefined;

  const since = flagString(parsed, "since");
  const until = flagString(parsed, "until");
  for (const [label, value] of [["--since", since], ["--until", until]] as const) {
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new UserError(`invalid ${label}: ${value} (expected YYYY-MM-DD)`, "tokitoki report --since 2026-08-01");
    }
  }

  return {
    period,
    groupBy,
    json: flagBool(parsed, "json"),
    sort,
    asc: flagBool(parsed, "asc"),
    providers: flagStrings(parsed, "provider"),
    delta: delta && since === undefined,
    since,
    until,
  };
}

function runReport(parsed: ParsedInvocation): void {
  const opts = reportOptions(parsed);
  const showEmail = flagBool(parsed, "show-email") || flagBool(parsed, "show-emails");
  try {
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      // Explicit --since/--until overrides the rolling window (delta disabled).
      const sinceIso = opts.since !== undefined
        ? new Date(`${opts.since}T00:00:00`).toISOString()
        : sinceIsoFor(opts.period);
      const untilIso = opts.until !== undefined
        ? new Date(`${opts.until}T23:59:59.999`).toISOString()
        : undefined;
      const days = rangeDays(sinceIso, untilIso);
      const rows = cache.aggregate(sinceIso, opts.groupBy, opts.providers, untilIso);
      if (opts.json) {
        // Enriched shape: totals + burn + previous-window cost so the
        // menu-bar app needs a single spawn per period.
        const total = cache.totals(sinceIso, opts.providers);
        let prevTotalCost: number | undefined;
        if (opts.delta) {
          const prev = previousWindow(opts.period);
          prevTotalCost = cache.totals(prev.sinceIso, opts.providers, prev.untilIso).costUsd;
        }
        const mtd = cache.totals(monthStartIso(), opts.providers);
        return JSON.stringify(
          {
            period: opts.period,
            groupBy: opts.groupBy,
            rows,
            total,
            prevTotalCost,
            burn: burnProjection(mtd.costUsd),
          },
          null,
          2,
        );
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
      if (showEmail) {
        // Emails resolve live from harness stores (claude-code, codex); shown
        // only when the provider attribution for an accountKey is unambiguous.
        const providersByKey = new Map<string, Set<string>>();
        for (const [key, provider] of cache.accountProviders(sinceIso)) {
          let set = providersByKey.get(key);
          if (set === undefined) {
            set = new Set();
            providersByKey.set(key, set);
          }
          set.add(provider);
        }
        ctx.emailFor = accountEmailMap(providersByKey.keys(), providersByKey);
      }

      let text = renderTable(sortRows(rows, opts.sort, opts.asc), { ...ctx, avgDays: days });
      if (showEmail && opts.groupBy !== "account") {
        text += "\n\x1b[2mnote: emails render per account — rerun with --by account\x1b[0m";
      }
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

/** Whole days covered by a window, inclusive of both ends (min 1). */
function rangeDays(sinceIso: string, untilIso?: string): number {
  const start = new Date(sinceIso);
  const end = untilIso !== undefined ? new Date(untilIso) : new Date();
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / (24 * 3600_000)) + 1);
}

// ---------------------------------------------------------------- export

function runExport(parsed: ParsedInvocation): void {
  const opts = reportOptions(parsed);
  const format = flagString(parsed, "format") ?? "csv";
  if (format !== "csv" && format !== "json") {
    throw new UserError(`invalid --format: ${format} (valid: csv, json)`, "tokitoki export --format csv");
  }
  try {
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const sinceIso = opts.since !== undefined
        ? new Date(`${opts.since}T00:00:00`).toISOString()
        : sinceIsoFor(opts.period);
      const untilIso = opts.until !== undefined
        ? new Date(`${opts.until}T23:59:59.999`).toISOString()
        : undefined;
      const rows = sortRows(cache.aggregate(sinceIso, opts.groupBy, opts.providers, untilIso), opts.sort, opts.asc);
      if (format === "json") return JSON.stringify({ period: opts.period, groupBy: opts.groupBy, rows }, null, 2);
      const head = ["bucket", "requests", "sessions", "inputTokens", "outputTokens", "cacheReadTokens", "costUsd"];
      const lines = [head.join(",")];
      for (const r of rows) {
        lines.push([
          JSON.stringify(r.bucket),
          String(r.requests),
          String(r.sessions),
          String(r.inputTokens),
          String(r.outputTokens),
          String(r.cacheReadTokens),
          r.costUsd.toFixed(6),
        ].join(","));
      }
      return lines.join("\n");
    });
    const file = flagString(parsed, "out");
    if (file !== undefined) {
      Bun.write(file, out + "\n");
      console.log(`wrote ${file}`);
    } else {
      console.log(out);
    }
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
    const period = resolvePeriod(flagString(parsed, "last"), "week");
    const spark = flagBool(parsed, "spark");
    const by = flagString(parsed, "by");
    if (by !== undefined && !CHART_DIMENSIONS.includes(by as (typeof CHART_DIMENSIONS)[number])) {
      throw new UserError(
        `invalid --by for chart: ${by} (valid: ${CHART_DIMENSIONS.join(", ")})`,
        "tokitoki chart --last month",
      );
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
    const period = resolvePeriod(flagString(parsed, "last"), "week");
    const groupBy = (flagString(parsed, "by") ?? "provider") as Dimension;
    if (groupBy !== "provider" && groupBy !== "model") {
      throw new UserError(
        `invalid --by for pie: ${groupBy} (valid: provider, model)`,
        "tokitoki pie --last week",
      );
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

// ---------------------------------------------------------------- grid

const GRID_WINDOWS = { day: 1, week: 7, month: 30, quarter: 91, year: 365 } as const;

type GridWindow = keyof typeof GRID_WINDOWS;

function runGrid(parsed: ParsedInvocation): void {
  try {
    const windowRaw = flagString(parsed, "last") ?? "month";
    if (!(windowRaw in GRID_WINDOWS)) {
      throw new UserError(
        `invalid window: ${windowRaw} (valid: ${Object.keys(GRID_WINDOWS).join(", ")})`,
        "tokitoki grid --last month",
      );
    }
    const metricRaw = flagString(parsed, "metric") ?? "tokens";
    if (metricRaw !== "tokens" && metricRaw !== "cost" && metricRaw !== "requests") {
      throw new UserError(
        `invalid --metric: ${metricRaw} (valid: tokens, cost, requests)`,
        "tokitoki grid --last month",
      );
    }
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const days = GRID_WINDOWS[windowRaw as GridWindow];
      const daily = cache.dailyTotals(sinceIsoForDays(days));
      if (daily.length === 0) return "no usage recorded — run `tokitoki scan` first";
      const start = new Date(Date.now() - (days - 1) * 24 * 3600_000);
      return renderGrid(daily, start, { metric: metricRaw });
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
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
  handleError(err);
}

// ---------------------------------------------------------------- web

function runWeb(parsed: ParsedInvocation): void {
  try {
    const port = Number(flagString(parsed, "port") ?? "7788");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new UserError(`invalid --port: ${flagString(parsed, "port")}`, "tokitoki web --port 7788");
    }
    let server: Bun.Server<undefined>;
    try {
      server = startWebServer({ port });
    } catch (err) {
      if ((err as { code?: string }).code === "EADDRINUSE") {
        const alt = nextFreePort(port + 1);
        console.error(`error: port ${port} is already in use`);
        console.error(`\x1b[2mtry: tokitoki web --port ${alt}\x1b[0m`);
        console.error(`\x1b[2m     lsof -i :${port}   # see what holds the port\x1b[0m`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    console.log(`tokitoki dashboard → http://localhost:${server.port}`);
  } catch (err) {
    handleError(err);
  }
}

/** First free port >= from (probes by binding localhost). */
function nextFreePort(from: number): number {
  for (let p = from; p < from + 50; p++) {
    try {
      const probe = Bun.listen({
        port: p,
        hostname: "127.0.0.1",
        socket: { data() {}, close() {}, end() {} },
      });
      probe.stop(true);
      return p;
    } catch {
      // occupied — keep looking
    }
  }
  return from; // give up suggesting; caller prints it anyway
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

/** Friendly one-liners for common OS-level failures (no stack dumps). */
const SYSCALL_HINTS: Record<string, (err: unknown) => string> = {
  EACCES: () => "permission denied — check ownership/permissions on the path",
  EPERM: () => "operation not permitted — sandbox/permissions may be blocking this",
  ENOSPC: () => "disk full — free some space and retry",
  EISDIR: () => "expected a file but found a directory",
};

function handleError(err: unknown): void {
  if (err instanceof UserError) {
    console.error(`error: ${err.message}`);
    // The hint is the fix — never make the user re-read usage to find it.
    if (err.hint !== undefined) console.error(`\x1b[2mtry: ${err.hint}\x1b[0m`);
    process.exitCode = 1;
    return;
  }
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === "string" && SYSCALL_HINTS[code] !== undefined) {
    console.error(`error: ${SYSCALL_HINTS[code]!(err)}`);
    process.exitCode = 1;
    return;
  }
  throw err; // unexpected bug: keep the stack
}

main(process.argv.slice(2));
