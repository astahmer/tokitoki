#!/usr/bin/env bun
import { parseArgs, type FlagValue, type ParsedInvocation } from "./args.ts";
import fs from "node:fs";
import path from "node:path";
import { localMachineId } from "./machine.ts";
import { appendEvents, eventsFile, saveProviderCursors } from "./store.ts";
import { PROVIDERS, getProvider } from "./providers/index.ts";
import { scanProviderCore, type ScanResult } from "./scan.ts";
import type { UsageEvent } from "./types.ts";
import { DIMENSIONS, EventCache, type AggRow, type Dimension, type SeriesBucket, type SessionSummary } from "./cache.ts";
import { renderTable, renderMiniProjects, renderMarkdownTable, resolveExtraFiles, resolveSortColumn, sinceIsoFor, sinceIsoForDays, previousWindow, monthStartIso, sortRows, formatDelta, deltaInfo, totalRow, totalTokens, planGaugeFn, renderBurnLine, burnProjection, type TableContext } from "./report.ts";
import { accountEmailMap } from "./accounts.ts";
import { computeLimits, dedupeAccountLimits, embeddedKind, groupBySharedCredential, mergeAliasLimits, type AccountLimits } from "./limits.ts";
import { accountIdentityFor } from "./accounts.ts";
import { opencodexAccountIdentities, opencodeCredentials, opencodexQuotas, piCredentials, pollQuotas, redactCredential } from "./poll.ts";
import {
  assertValidSurface,
  isCardVisibleOn,
  setMenubarProviders,
  setMenubarCards,
  setMenubarAccountOrder,
  setMenubarTabs,
  MENUBAR_TABS,
  setPollEnabled,
  setSurfaceVisibility,
  menubarCardLayout,
} from "./uiToggles.ts";
import { renderGrid } from "./grid.ts";
import { renderBlocks } from "./blocks.ts";
import { parseStatuslineStdin, renderStatusline } from "./statusline.ts";
import {
  installRebuiltMenubarBinary,
  resolveMenubarBin,
  startMenubar,
  stopMenubar,
  menubarStatus,
} from "./menubar-launch.ts";
import { runMcpStdio } from "./mcp-server.ts";
import { detectAnomalies, ANOMALY_METRICS, anomalyFooter } from "./anomalies.ts";
import { processBudgetAlerts, seedBudgetsConfig } from "./budgets.ts";
import { collectMachines } from "./presence.ts";
import { computeBudgetStatus, gaugesForMenubar } from "./budget-status.ts";
import { importCsv, IMPORT_SOURCES } from "./import.ts";
import { repoEfficiency } from "./report.ts";
import { bar, formatCost, humanCount, sparkline, formatInt, cachePct } from "./format.ts";
import { loadConfig, configPath } from "./config.ts";
import {
  buildSharePayload,
  describePayload,
  publishShare,
  readShareState,
  writeShareState,
  type ShareScope,
} from "./share.ts";
import { getSyncBackend, runSync } from "./sync/index.ts";
import type { SyncConfig } from "./sync/types.ts";
import { startWebServer } from "./web/server.ts";
import { UserError } from "./errors.ts";
import {
  calendarDayWindow,
  fmtLocal,
  parseDuration,
  resolveCalendarWindow,
  resolveTimeWindow,
  windowLine,
  type Period,
  type TimeWindow,
} from "./period.ts";
import { collectSources, renderSources } from "./sources.ts";
import { rebuildSessionIndex, searchSessions, updateSessionIndex } from "./sessionIndex.ts";

export { UserError } from "./errors.ts";

/**
 * Version lookup must not throw at module load: in `bun --compile` binaries
 * import.meta.url lives in the virtual $bunfs, which has no package.json.
 * Fall back to the repo layout (dist/..), then to a literal.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    if (typeof pkg.version === "string") return pkg.version;
  } catch { /* compiled binary: not in $bunfs */ }
  try {
    const besideBinary = path.join(path.dirname(process.execPath), "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(besideBinary, "utf8")) as { version?: string };
    if (typeof pkg.version === "string") return pkg.version;
  } catch { /* standalone deployment without repo layout */ }
  return "dev";
}

const VERSION = readVersion();
const CHART_DIMENSIONS = ["provider", "model", "tool"] as const;

const DIMENSION_LIST = "model|provider|account|machine|project|repo|tool";

export interface CommandHelp {
  usage: string;
  flags: string;
  example?: string;
}

export const COMMAND_HELP: Record<string, CommandHelp> = {
  scan: {
    usage: "tokitoki scan [--provider <id>]",
    flags: "  --provider <id>   only scan this harness (repeatable not allowed here)",
    example: "tokitoki scan",
  },
  sources: {
    usage: "tokitoki sources",
    flags: `  provenance per provider: store roots (w/ env overrides), file counts,
  cursor freshness, events, accounts (+emails) and models seen.`,
    example: "tokitoki sources",
  },
  report: {
    usage: "tokitoki report [--last <window>] [--from <date>] [--to <date>] [--by <dimension>]",
    flags: `  --last day|week|month|year ROLLING window ending now (day = last 24h).
                            Also accepts durations: 24h, 2days, 150m, 1w
  --from <date>             absolute start (YYYY-MM-DD or ISO timestamp)
  --to <date>               absolute end, defaults to now; mutually exclusive
                            with --last (aliases: --since/--until)
  --by ${DIMENSION_LIST}
  --sort requests|sessions|avg|input|output|cache|%cache|%share|cost|name
  --asc                     ascending sort
  --provider <id>           filter (repeatable)
  --delta / --no-delta      Δ vs previous window (named periods only;
                            default: delta)
  --show-email              render account rows as name <email> (implies --by account
                            unless an explicit --by is given)
  --json                    machine-readable output`,
    example: "tokitoki report --last week --by provider",
  },
  export: {
    usage: "tokitoki export [--format csv|json|md] [--out <file>]",
    flags: `  same window/filters/sorting as report (--last/--from/--to/--by/--provider/--sort)
  --format csv|json|md      output format (default: csv); md = markdown table
                            with period header
  --out <file>              write to file instead of stdout`,
    example: "tokitoki export --last month --by repo --format md --out usage.md",
  },
  today: {
    usage: "tokitoki today",
    flags: "  calendar day so far (local midnight → now), plus top projects MTD",
    example: "tokitoki today",
  },
  week: { usage: "tokitoki week", flags: "  shortcut for report --last week", example: "tokitoki week" },
  month: { usage: "tokitoki month", flags: "  shortcut for report --last month", example: "tokitoki month" },
  chart: {
    usage: "tokitoki chart [--last day|week|month|year|<duration>]",
    flags: `  --by provider|model   one sparkline row per bucket
  --spark               compact inline sparklines
  (rolling windows like report; default period: week)`,
    example: "tokitoki chart --last month --spark",
  },
  pie: {
    usage: "tokitoki pie [--last day|week|month|year|<duration>] [--by provider|model]",
    flags: "  share-of-tokens legend bars with cost (default period: week)",
    example: "tokitoki pie --last week",
  },
  grid: {
    usage: "tokitoki grid [--last month|quarter|year|<duration>]",
    flags: `  --metric tokens|cost|requests   cell intensity (default: tokens)
  trailing day-counts by name (month/quarter/year), durations (--last 90d)
  or absolute ranges (--from/--to). Default window: month.`,
    example: "tokitoki grid --last quarter",
  },
  anomalies: {
    usage: "tokitoki anomalies [--last month|quarter|year|<duration>] [--metric tokens|cost|requests]",
    flags: `  --last <window>           default: month (also durations/--from/--to)
  --metric tokens|cost|requests
  --json                    machine-readable output

A day is flagged when its metric exceeds 3× the trailing 14-day average
(2× when that stretch was mostly idle). Today is never flagged.`,
    example: "tokitoki anomalies --last quarter",
  },
  tools: {
    usage: "tokitoki tools [--last day|week|month|year|<duration>] [--top N] [--provider <id>] [--json]",
    flags: `  top tools by spend — which tool/command put the tokens in context.
  Names are provider-qualified; MCP servers roll up to mcp:<server>;
  shell commands collapse to their first word (shell:rg). Turns without a
  tool call land under '(unattributed)'.
  --top N                   show only the first N rows (default: all)
  --json                    machine-readable output (menubar/web contract)`,
    example: "tokitoki tools --last day --top 5",
  },
  budgets: {
    usage: "tokitoki budgets [--json] | tokitoki budgets init [--force]",
    flags: `  gauge state for the [budgets] caps in your config
  (~/.config/tokitoki/config.json), scoped to calendar day/week/month.
  init                      seed per-account caps from detected accounts
                            (codex/claude-code ≈ $200/mo, else $50/mo)
  --force                   with init: replace existing account entries
  --json                    machine-readable output (menubar/web contract)

Rows always show every configured scope×pattern; state is ok | warn (≥80%)
| exceeded. No config → empty output.`,
    example: 'tokitoki budgets --json · tokitoki budgets init',
  },
  repos: {
    usage: "tokitoki repos [--last day|week|month|year|<duration>] [--worst N] [--provider <id>]",
    flags: `  efficiency ranking per repo. Score = avg cost/request ×
  (1 − cache%). High score = expensive AND cache-hostile.
  --worst N                 show only the N worst (default: all)`,
    example: "tokitoki repos --worst 5",
  },
  import: {
    usage: "tokitoki import <file.csv> [--source anthropic|openai|openrouter] [--dry-run]",
    flags: `  backfill console usage exports. Source is auto-detected from headers.
  --source <id>             override detection
  --dry-run                 parse + summarize without writing`,
    example: "tokitoki import ~/Downloads/anthropic-usage.csv",
  },
  sessions: {
    usage: "tokitoki sessions [--search \"query\"] [--last day|week|month|year|<duration>] [--top N] [--by provider|repo]",
    flags: `  --search "query"          full-text search across ALL conversation content
                            (terms AND together; results ranked by relevance)
  --page N                  result page for --search (default 1, 50 per page)
  --last day|week|month|year rolling window (default: week); durations ok
  --top N                   leaderboard size (default: 10)
  --by provider|repo        group the leaderboard under section headers
  --session <id>            drill into one session: request timeline + running total
  --provider <id>           filter (repeatable)
  --json                    machine-readable output`,
    example: "tokitoki sessions --search \"kumo treemap\" --last month",
  },
  reindex: {
    usage: "tokitoki reindex",
    flags: `  force-rebuilds the full-text session index from every provider's raw
  stores. Incremental updates happen automatically on search; only needed
  after upgrading tokitoki or if results look stale.`,
    example: "tokitoki reindex",
  },
  sync: {
    usage: "tokitoki sync [--backend dir|git|atproto] [--push|--pull|--both]",
    flags: "  backend + remote come from the [sync] section of config.toml;\n  --backend overrides it for this run. Default mode: both.",
    example: "tokitoki sync --backend git --push",
  },
  share: {
    usage:
      "tokitoki share [--enable|--disable|--status] [--publish] [--scope week|month] [--include-repos]",
    flags:
      "  --status            current state + last published CID (default)\n" +
      "  --enable            allow public sharing\n" +
      "  --disable           stop sharing\n" +
      "  --publish           publish a sanitized aggregate record to your PDS now\n" +
      "  --scope week|month  window to publish (default week)\n" +
      "  --include-repos     add hashed repo names (raw names never leave)",
    example: "tokitoki share --publish --scope month",
  },
  config: {
    usage: "tokitoki config set <dot.path> <json>",
    flags: "  value parsed as JSON; bare words become strings",
    example: "tokitoki config set ui.stripMetric \"tokens\"",
  },
  "menubar-payload": {
    usage: "tokitoki menubar-payload --json",
    flags: "  internal: combined json snapshot consumed by the menu-bar app",
    example: "tokitoki menubar-payload --json",
  },
  ui: {
    usage: "tokitoki ui [--list] [--hide <provider[:account]>] [--show <provider[:account]>]\n                  [--menubar-only <provider>...] [--tabs <id,...>] [--surface menubar|dashboard]",
    flags:
      "  --list                show current visibility state\n" +
      "  --hide <target>       hide a provider or provider:account pair\n" +
      "  --show <target>       un-hide a previously hidden target\n" +
      "  --surface <s>         which surface (default: menubar)\n" +
      "  --menubar-only <p>    restrict menubar preview to these providers (repeatable; none = all)\n" +
      "  --tabs <id,...>       order popover tabs; first four stay visible, rest go under More",
    example: "tokitoki ui --hide codex:codex:plus --surface dashboard",
  },
  web: {
    usage: "tokitoki web [--port <n>]",
    flags: "  local dashboard, default port 7788",
    example: "tokitoki web",
  },
  blocks: {
    usage: "tokitoki blocks [--last <window>] [--account <key>]",
    flags: `  events partitioned into 5h billing blocks per account (ccusage
                            semantics); ▸ marks the active block, gauge shows
                            remaining minutes
  --last/--from/--to        window selectors (default --last day)
  --account <key>           only this account's blocks`,
    example: "tokitoki blocks",
  },
  statusline: {
    usage: "tokitoki statusline",
    flags: `  reads Claude Code statusline-hook stdin JSON ({session_id,
  model:{display_name}}) and prints ONE line: session cost, today, MTD and
  the active billing block. Register in Claude Code settings:
  {"statusLine":{"command":"bun /path/to/tokitoki/src/cli.ts statusline","padding":0}}`,
    example: "tokitoki statusline",
  },
  poll: {
    usage: "tokitoki poll [--json] [--provider <id>]",
    flags: `  opt-in: fetch provider-reported rate-limit windows from local auth stores
  (Codex, Claude, Copilot, OpenRouter, OpenCode Go, Cursor and Command Code).
  Results land in quota_snapshots and surface in limits,
  budgets and the menubar like embedded data.
  --provider <id>           only refresh this provider (repeatable)
  --json                    machine-readable result`,
    example: "tokitoki poll",
  },
  mcp: {
    usage: "tokitoki mcp",
    flags: `  local MCP server over stdio exposing every report surface as tools
  (usage_report, sessions_top, session_detail, tool_spend, budgets_status,
  quota_snapshot, scan_now, export_report, …). Register with your agent:
  claude mcp add tokitoki -- bun /path/to/tokitoki/src/cli.ts mcp`,
    example: "tokitoki mcp",
  },
  menubar: {
    usage: "tokitoki menubar [--stop | --status | --foreground | --rebuild]",
    flags: `  starts the native menu-bar app for this OS (macOS Swift app today,
  Electrobun on Linux later). Idempotent: no-op when already running.
  --status                  pid + running state
  --stop                    stop a running instance (launchctl-aware)
  --foreground              run attached instead of detached
  --rebuild                 rebuild, install the launchd binary, and restart it`,
    example: "tokitoki menubar",
  },
};

export function commandHelpText(id: string): string {
  const h = COMMAND_HELP[id];
  if (h === undefined) return `unknown command: ${id}`;
  return `${h.usage}\n\nFlags:\n${h.flags}${h.example !== undefined ? `\n\nExample:\n  ${h.example}` : ""}`;
}

export function printHelp(topic?: string): void {
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

export const GLOBAL_HELP = `tokitoki — unified coding-agent usage analytics

Usage: tokitoki <command> [options]

Commands:
  scan       incrementally scan harness stores into the local cache
  sources    where each provider's data comes from (roots, cursors, freshness)
  report     aggregate a rolling window (--last day|week|month|year|24h, default week)
  today      shortcut for report --last day (+ top projects MTD)
  week       shortcut for report --last week
  month      shortcut for report --last month
  chart      daily token evolution as ASCII bars / sparklines
  pie        share-of-tokens legend with cost bars
  grid       GitHub-style calendar heatmap (horizontal, weeks = columns)
  sessions   costliest/most token-heavy sessions (+ per-request drill-down)
  anomalies  unusual-activity days vs trailing baseline
  tools      spend attributed to the tool that caused each request
  repos      repo efficiency ranking (expensive AND cache-hostile)
  budgets    spending caps per account/scope (+ init to seed from detected accounts)
  share      opt-in sanitized public stats via atproto (--enable|--disable|--status)
  export     dump any report as json/csv/markdown
  config     set a config value by dotted path (value parsed as JSON)
  menubar-payload  combined json snapshot for the menu-bar app (internal)
  ui         show/hide providers per surface (menubar preview, dashboard)
  import     backfill usage CSVs from provider consoles
  reindex    force-rebuild the session search index (full-text)
  sync       push/pull events across machines (dir | git | atproto backends)
  web        local dashboard (default :7788)
  blocks     Claude 5-hour billing blocks (+ active block gauge)
  statusline one-line usage summary for editor statusline hooks (reads stdin JSON)
  mcp        local MCP server over stdio (register with your coding agent)
  menubar    start/stop the native menu-bar app (--stop/--status/--foreground)
  poll       fetch real provider quotas via stored logins (opt-in)

Run 'tokitoki help <command>' or 'tokitoki <command> --help' for details.

Window semantics: --last day|week|month|year are ROLLING (end at now); durations
like 24h/2days/150m/1w work too; --from/--to pin absolute ranges.

Version: tokitoki v${VERSION} (-v/--version)
`;

export async function main(argv: string[]): Promise<void> {
  // -h/--help wins over everything, including per-command validation.
  if (argv.includes("-h") || argv.includes("--help")) {
    const cmd = argv.find((a) => !a.startsWith("-") && a !== "help");
    printHelp(cmd);
    return;
  }
  // -v/--version right behind help.
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(`tokitoki v${VERSION}`);
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
      case "scan": await runScan(parsed); break;
      case "sources": runSources(parsed); break;
      case "report": runReport(parsed); break;
      case "export": runExport(parsed); break;
      case "today": case "week": case "month": runShortcut(parsed); break;
      case "chart": runChart(parsed); break;
      case "pie": runPie(parsed); break;
      case "grid": runGrid(parsed); break;
      case "sessions": runSessions(parsed); break;
      case "reindex": runReindex(parsed); break;
      case "anomalies": runAnomalies(parsed); break;
    case "budgets": runBudgets(parsed); break;
    case "menubar-payload": runMenubarPayload(parsed); break;
    case "ui": runUi(parsed); break;
    case "presence": runPresence(parsed); break;
    case "tools": runTools(parsed); break;
      case "repos": runRepos(parsed); break;
      case "import": runImport(parsed); break;
      case "sync": runSyncCommand(parsed); break;
      case "share": await runShare(parsed); break;
      case "web": runWeb(parsed); break;
      case "blocks": await runBlocks(parsed); break;
      case "statusline": await runStatusline(parsed); break;
      case "mcp": await runMcpStdio(); break;
      case "menubar": await runMenubar(parsed); break;
      case "poll": await runPoll(parsed); break;
      case "config": runConfigSet(parsed); break;
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
  "menubar-payload": ["json"],
  ui: ["list", "hide", "show", "surface", "menubar-only", "card-set", "account-order", "tabs"],
  scan: ["provider"],
  sources: [],
  report: ["last", "by", "json", "sort", "asc", "provider", "delta", "no-delta", "show-email", "show-emails", "since", "until", "from", "to"],
  today: ["provider", "json", "show-email", "show-emails"],
  week: ["provider", "json", "show-email", "show-emails"],
  month: ["provider", "json", "show-email", "show-emails"],
  chart: ["last", "by", "spark", "provider", "from", "to"],
  pie: ["last", "by", "provider", "from", "to"],
  grid: ["last", "metric", "since", "until", "from", "to"],
  sessions: ["last", "by", "top", "session", "json", "provider", "since", "until", "account", "from", "to", "search", "page"],
  anomalies: ["last", "metric", "json", "since", "until", "from", "to"],
  budgets: ["json"],
  tools: ["last", "from", "to", "since", "until", "top", "provider", "json"],
  repos: ["last", "worst", "provider", "from", "to"],
  import: ["source", "dry-run"],
  sync: ["backend", "push", "pull", "both", "sync-atproto"],
  blocks: ["last", "since", "until", "from", "to", "account", "json"],
  statusline: [],
  mcp: [],
  menubar: ["stop", "status", "foreground", "rebuild"],
  poll: ["json", "enable", "disable", "provider"],
  config: ["set"],
  share: ["enable", "disable", "status", "publish", "scope", "include-repos"],
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

function withCache<T>(fn: (cache: EventCache) => T): T {
  const cache = new EventCache();
  try {
    return fn(cache);
  } finally {
    cache.close();
  }
}

// ---------------------------------------------------------------- scan

/** Parallel provider scans cap: enough to overlap the big harness stores
 * without 12 workers each buffering multi-MB read chunks. */
const MAX_SCAN_WORKERS = 4;

interface ScanOutcome {
  result: ScanResult;
  events: UsageEvent[];
}

/**
 * Run one provider scan inside a Bun worker. Events stream back in batches;
 * the worker persists its own cursor shard so an interrupted scan resumes
 * instead of replaying gigabytes.
 */
function scanInWorker(providerId: string, machineId: string): Promise<ScanOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan-worker.ts", import.meta.url));
    const events: UsageEvent[] = [];
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data as
        | { type: "events"; events: UsageEvent[] }
        | { type: "done"; result: ScanResult }
        | { type: "error"; message: string };
      if (msg.type === "events") {
        events.push(...msg.events);
      } else if (msg.type === "done") {
        cleanup();
        resolve({ result: msg.result, events });
      } else {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      void worker.terminate();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ type: "scan", providerId, machineId });
  });
}

async function runScan(parsed: ParsedInvocation): Promise<void> {
  const only = flagString(parsed, "provider");
  if (only !== undefined && getProvider(only) === undefined) {
    throw new UserError(
      `unknown provider: ${only}`,
      `tokitoki scan (known: ${PROVIDERS.map((x) => x.id).join(", ")})`,
    );
  }
  const providerIds = only !== undefined ? [only] : PROVIDERS.map((p) => p.id);
  const machineId = localMachineId();

  // Direct cache handle for the ingest below — bypasses withCache's lazy sync
  // semantics: we insert exactly the freshly extracted events and mark the log
  // consumed, so the next report pays zero re-read cost.
  const cache = new EventCache();
  try {
    let cursor = 0;
    let printed = 0;
    const outcomes: ScanOutcome[] = [];
    const launchNext = (): Promise<void> => {
      if (cursor >= providerIds.length) return Promise.resolve();
      const id = providerIds[cursor++]!;
      return runWithWorkerFallback(id, machineId)
        .then((outcome) => {
          outcomes.push(outcome);
          // Single writer: batches are appended by this process only.
          appendEvents(outcome.events);
          cache.insert(outcome.events);
          const { provider, eventsEmitted, filesScanned } = outcome.result;
          if (eventsEmitted === 0 && filesScanned === 0) {
            // Nothing new on disk — one quiet italic line instead of a zero row.
            console.log(scanQuiet(`${provider} - no changes`));
          } else {
            console.log(
              `${provider}: ${scanAdded(`+${eventsEmitted} events (${filesScanned} files updated)`)}`,
            );
          }
          printed++;
        })
        .then(launchNext);
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_SCAN_WORKERS, providerIds.length) }, () => launchNext()),
    );
    void printed;
    // Mark everything appended above as already consumed so report-time
    // sync() skips re-reading the tail. Only safe because insert() just
    // ingested those exact events; a stale-extraction rebuild supersedes it.
    cache.recordLogOffsets([eventsFile()]);
  } finally {
    cache.close();
  }

  // Budget banners after scan output (ntfy pushes fire in the background).
  for (const line of budgetBanners()) console.log(line);
}

/** Worker-per-provider with inline fallback when workers are unavailable. */
async function runWithWorkerFallback(providerId: string, machineId: string): Promise<ScanOutcome> {
  try {
    return await scanInWorker(providerId, machineId);
  } catch {
    const provider = getProvider(providerId)!;
    const events: UsageEvent[] = [];
    const result = scanProviderCore(provider, machineId, {
      onEvents: (batch) => events.push(...batch),
      onSaveCursors: (cursors) => saveProviderCursors(provider.id, cursors),
    });
    return { result, events };
  }
}

/** Evaluate configured budgets against current windows; returns banner lines. */
function budgetBanners(): string[] {
  const cfg = loadConfig();
  if (cfg.budgets === undefined) return [];
  return withCache((cache) => {
    const snap = cache.spendSnapshot(sinceIsoFor("day"), sinceIsoFor("week"), monthStartIso());
    return processBudgetAlerts(
      cfg,
      { daily: snap.totals.day, weekly: snap.totals.week, monthly: snap.totals.month },
      snap.accounts.map((a) => ({ key: a.key, daily: a.day, weekly: a.week, monthly: a.month })),
    );
  });
}

// ---------------------------------------------------------------- sources

function runSources(parsed: ParsedInvocation): void {
  try {
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      return renderSources(collectSources(cache));
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- report

interface ReportOptions {
  /** Resolved --last/--from/--to window (rolling periods keep Δ support). */
  window: TimeWindow;
  groupBy: Dimension;
  json: boolean;
  sort?: ReturnType<typeof resolveSortColumn>;
  asc: boolean;
  providers: string[];
  delta: boolean;
}

function reportOptions(parsed: ParsedInvocation, defaultPeriod?: Period): ReportOptions {
  const explicitBy = flagString(parsed, "by");
  const showEmailRequested = flagBool(parsed, "show-email") || flagBool(parsed, "show-emails");
  // Emails key off accounts: --show-email implies --by account unless the user
  // picked a dimension explicitly.
  const groupByRaw = explicitBy ?? (showEmailRequested ? "account" : undefined);
  // --since/--until remain accepted as aliases of --from/--to.
  const from = flagString(parsed, "from") ?? flagString(parsed, "since");
  const to = flagString(parsed, "to") ?? flagString(parsed, "until");
  const window = resolveTimeWindow({
    last: flagString(parsed, "last"),
    from,
    to,
    fallbackPeriod: defaultPeriod ?? "week",
  });
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
  // Δ needs an equally-sized predecessor, so only named rolling periods get
  // it; duration (--last 24h) and absolute (--from/--to) windows disable it.
  const delta = parsed.flags["no-delta"] === true ? false : flagBool(parsed, "delta") || parsed.flags["delta"] === undefined;

  return {
    window,
    groupBy,
    json: flagBool(parsed, "json"),
    sort,
    asc: flagBool(parsed, "asc"),
    providers: flagStrings(parsed, "provider"),
    delta: delta && window.period !== undefined,
  };
}

function runReport(parsed: ParsedInvocation): void {
  const opts = reportOptions(parsed);
  const showEmail = flagBool(parsed, "show-email") || flagBool(parsed, "show-emails");
  try {
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const w = opts.window;
      const sinceIso = w.sinceIso;
      const untilIso = w.untilIso;
      const days = rangeDays(sinceIso, untilIso);
      const rows = cache.aggregate(sinceIso, opts.groupBy, opts.providers, untilIso);
      if (opts.json) {
        // Enriched shape: totals + burn + previous-window cost so the
        // menu-bar app needs a single spawn per period.
        const total = cache.totals(sinceIso, opts.providers, untilIso);
        let prevTotalCost: number | undefined;
        if (opts.delta && w.period !== undefined) {
          const prev = previousWindow(w.period);
          prevTotalCost = cache.hybridUsage(prev.sinceIso, opts.providers, prev.untilIso).costUsd;
        }
        const mtd = cache.hybridUsage(monthStartIso(), opts.providers);
        return JSON.stringify(
          {
            window: { since: sinceIso, until: untilIso ?? null, label: w.label },
            period: w.period ?? null,
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

      const ctx: TableContext = {};
      ctx.total = cache.totals(sinceIso, opts.providers, untilIso);
      if (opts.delta && w.period !== undefined) {
        const prev = previousWindow(w.period);
        const prevRows = cache.aggregate(prev.sinceIso, opts.groupBy, opts.providers, prev.untilIso);
        ctx.prevCostById = new Map(prevRows.map((r) => [r.bucket, r.costUsd]));
        ctx.totalPrevCost = cache.hybridUsage(prev.sinceIso, opts.providers, prev.untilIso).costUsd;
      }
      const cfg = loadConfig();
      if (cfg.plans !== undefined && Object.keys(cfg.plans).length > 0) {
        // Plan gauges read requests/cost only — rollup-safe.
        const mtdByAccount = new Map(
          cache.hybridAggregate(monthStartIso(), "account", opts.providers).map((r) => [r.bucket, r]),
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
      if (w.period === "month") {
        const mtd = ctx.total ?? totalRow(rows);
        text += `\n${renderBurnLine(mtd.costUsd, mtd.requests)}`;
      }
      // Repo efficiency columns when grouping by repo.
      if (opts.groupBy === "repo") {
        const prevMap = new Map<string, AggRow>();
        const prev = previousWindow(w.period!);
        // prev feeds only the cache-trend column (requests + cache sums) —
        // sessions never read → rollup-safe.
        for (const r of cache.hybridAggregate(prev.sinceIso, "repo", opts.providers, prev.untilIso)) {
          prevMap.set(r.bucket, r);
        }
        ctx.extraColumns = buildRepoExtras(rows, prevMap);
        text = renderTable(sortRows(rows, opts.sort, opts.asc), { ...ctx, avgDays: days });
      }
      // Spike flags inside the window.
      const anomalies = detectAnomalies(cache.dailyTotals(sinceIso), {});
      const footer = anomalyFooter(anomalies);
      if (footer.length > 0) text += `\n${footer}`;
      // Budget warnings last.
      for (const line of budgetBanners()) text += `\n${line}`;
      return `${windowLine(w)}\n${text}`;
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

/** Extra table columns for `--by repo`: efficiency metrics per bucket. */
function buildRepoExtras(
  rows: AggRow[],
  prevById: Map<string, AggRow>,
): NonNullable<TableContext["extraColumns"]> {
  void rows;
  return [
    {
      header: "avg $/req",
      cell: (row) => `$${(row.requests > 0 ? row.costUsd / row.requests : 0).toFixed(4)}`,
    },
    {
      header: "cache Δ",
      cell: (row) => {
        const eff = repoEfficiency(row, prevById.get(row.bucket));
        return `${eff.cacheTrendPts >= 0 ? "+" : ""}${eff.cacheTrendPts}pp`;
      },
    },
    {
      header: "tok/sess",
      cell: (row) => humanCount(repoEfficiency(row).tokensPerSession),
    },
  ];
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
  if (format !== "csv" && format !== "json" && format !== "md") {
    throw new UserError(
      `invalid --format: ${format} (valid: csv, json, md)`,
      "tokitoki export --format md",
    );
  }
  try {
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const w = opts.window;
      const rows = sortRows(
        cache.aggregate(w.sinceIso, opts.groupBy, opts.providers, w.untilIso),
        opts.sort,
        opts.asc,
      );
      const windowLabel = `${fmtLocal(w.sinceIso)} → ${w.untilIso === undefined ? "now" : fmtLocal(w.untilIso)} (${w.label})`;
      if (format === "json") {
        return JSON.stringify(
          { window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, groupBy: opts.groupBy, rows },
          null,
          2,
        );
      }
      if (format === "md") return renderMarkdownTable(rows, windowLabel);
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
    const w = calendarDayWindow();
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const sinceIso = w.sinceIso;
      const rows = cache.aggregate(sinceIso, "model", flagStrings(parsed, "provider"));
      const total = cache.totals(sinceIso, flagStrings(parsed, "provider"));
      let text = renderTable(sortRows(rows), { total });
      // Burn projection + top-3 projects this month
      const mtd = cache.hybridUsage(monthStartIso(), flagStrings(parsed, "provider"));
      text += `\n${renderBurnLine(mtd.costUsd, mtd.requests)}`;
      const projects = cache
        .aggregate(monthStartIso(), "project")
        .sort((a, b) => totalTokens(b) - totalTokens(a))
        .slice(0, 3);
      const mini = renderMiniProjects(projects);
      if (mini.length > 0) text += `\n\ntop projects (month-to-date):\n${mini}`;
      const footer = anomalyFooter(detectAnomalies(cache.dailyTotals(sinceIsoForDays(14)), {}));
      if (footer.length > 0) text += `\n${footer}`;
      for (const line of budgetBanners()) text += `\n${line}`;
      return `${windowLine(w)}\n${text}`;
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
    const w = resolveTimeWindow({ last: flagString(parsed, "last"), from: flagString(parsed, "from"), to: flagString(parsed, "to"), fallbackPeriod: "week" });
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
      if (spark) return `${windowLine(w)}\n${sparkSection(cache, w, by)}`;
      const sinceIso = w.sinceIso;
      const days = cache.dailyTotals(sinceIso, w.untilIso);
      if (days.length === 0) return `${windowLine(w)}\nno usage recorded in this window — run \`tokitoki scan\` first`;
      const max = Math.max(...days.map((d) => d.tokens));
      const bars = days
        .map((d) => `${d.day}  ${coloredBar(max > 0 ? d.tokens / max : 0, 30)}  ${humanCount(d.tokens)}`)
        .join("\n");
      // Δ vs the equally-sized previous window (total tokens) — only for
      // named rolling periods, where a predecessor exists.
      let deltaLine: string | null = null;
      if (w.period !== undefined) {
        const prevWin = previousWindow(w.period);
        const cur = cache.hybridUsage(sinceIso);
        const prevTotals = cache.hybridUsage(prevWin.sinceIso, undefined, prevWin.untilIso);
        const curTokens = cur.inputTokens + cur.outputTokens + cur.cacheReadTokens + cur.cacheWriteTokens;
        const prevTokens = prevTotals.inputTokens + prevTotals.outputTokens + prevTotals.cacheReadTokens + prevTotals.cacheWriteTokens;
        const d = deltaInfo(curTokens, prevTokens);
        deltaLine = d.kind === "" ? null : `Δ vs previous period: ${formatDelta(d)} (tokens)`;
      }
      return `${windowLine(w)}\n${deltaLine === null ? bars : `${bars}\n${deltaLine}`}`;
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- pie

function runPie(parsed: ParsedInvocation): void {
  try {
    const w = resolveTimeWindow({ last: flagString(parsed, "last"), from: flagString(parsed, "from"), to: flagString(parsed, "to"), fallbackPeriod: "week" });
    const groupBy = (flagString(parsed, "by") ?? "provider") as Dimension;
    if (groupBy !== "provider" && groupBy !== "model" && groupBy !== "tool") {
      throw new UserError(
        `invalid --by for pie: ${groupBy} (valid: provider, model, tool)`,
        "tokitoki pie --last week",
      );
    }

    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const rows = cache.aggregate(w.sinceIso, groupBy, flagStrings(parsed, "provider"), w.untilIso);
      return `${windowLine(w)}\n${renderPie(rows)}`;
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
    const w = resolveCalendarWindow({ last: flagString(parsed, "last"), from: flagString(parsed, "from") ?? flagString(parsed, "since"), to: flagString(parsed, "to") ?? flagString(parsed, "until") }, "month");
    const metricRaw = flagString(parsed, "metric") ?? "tokens";
    if (metricRaw !== "tokens" && metricRaw !== "cost" && metricRaw !== "requests") {
      throw new UserError(
        `invalid --metric: ${metricRaw} (valid: tokens, cost, requests)`,
        "tokitoki grid --last month",
      );
    }
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const daily = cache.dailyTotals(w.sinceIso, w.untilIso);
      if (daily.length === 0) return `${windowLine(w)}\nno usage recorded — run \`tokitoki scan\` first`;
      const start = new Date(new Date(w.sinceIso).getTime());
      return `${windowLine(w)}\n${renderGrid(daily, start, { metric: metricRaw })}`;
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- sessions

const SESSION_DIMENSIONS = ["provider", "repo"] as const;

function runSessions(parsed: ParsedInvocation): void {
  try {
    const drillId = flagString(parsed, "session");
    const searchQuery = flagString(parsed, "search");
    const topN = Math.max(1, Math.min(Number(flagString(parsed, "top") ?? (searchQuery !== undefined ? "50" : "10")) || 10, 100));
    const by = flagString(parsed, "by");
    if (by !== undefined && !(SESSION_DIMENSIONS as readonly string[]).includes(by)) {
      throw new UserError(
        `invalid --by: ${by} (valid: ${SESSION_DIMENSIONS.join(", ")})`,
        "tokitoki sessions --by provider",
      );
    }
    const json = flagBool(parsed, "json");
    const providers = flagStrings(parsed, "provider");

    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const w = resolveTimeWindow({ last: flagString(parsed, "last"), from: flagString(parsed, "from"), to: flagString(parsed, "to"), fallbackPeriod: "week" });
      const sinceIso = w.sinceIso;
      const filter = { sinceIso, untilIso: w.untilIso, providers: providers.length > 0 ? providers : undefined };

      if (drillId !== undefined) {
        return renderSessionDrill(cache, drillId, json);
      }

      if (searchQuery !== undefined && searchQuery.trim().length > 0) {
        const page = Math.max(1, Number(flagString(parsed, "page") ?? "1") || 1);
        const stats = updateSessionIndex(cache.database);
        const res = searchSessions(cache.database, {
          query: searchQuery,
          providers: providers.length > 0 ? providers : undefined,
          sinceIso,
          untilIso: w.untilIso,
          limit: topN,
          offset: (page - 1) * topN,
        });
        const header = `${windowLine(w)} · indexed ${stats.filesIndexed} changed file(s) in ${stats.durationMs}ms · search ${res.searchMs}ms`;
        if (json) {
          return JSON.stringify(
            { window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, query: searchQuery, page, hasMore: res.hasMore, rows: res.rows },
            null,
            2,
          );
        }
        if (res.rows.length === 0) {
          return `${header}\nno sessions match '${searchQuery}' — check the spelling or widen the window\ntry: tokitoki sessions --search "${searchQuery}" --last month`;
        }
        const lines = [
          header,
          `matches for '${searchQuery}'${res.hasMore ? ` · showing ${topN}, more pages exist (--page ${page + 1})` : ""}`,
        ];
        for (const r of res.rows) {
          lines.push(
            ``,
            `${r.startedAt.slice(0, 16).replace("T", " ")}  ${r.provider}  ${r.accountKey}  ${r.repos[0] ?? "(no repo)"}`,
            `  ${r.title.length > 0 ? r.title : "(no title)"}`,
            `  req ${formatInt(r.requests)} · tok ${humanCount(r.totalTokens)} · cache ${r.cachePct}% · cost ${formatCost(r.costUsd)}`,
            `  ${r.sessionId}`,
            `  ${r.snippet.replaceAll("[[", "\x1b[33m").replaceAll("]]", "\x1b[0m")}`,
          );
        }
        return lines.join("\n");
      }

      const rows = cache.topSessions({ ...filter, limit: topN });
      if (json) {
        return JSON.stringify({ window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, top: topN, rows }, null, 2);
      }
      if (rows.length === 0) {
        return `${windowLine(w)}\nno sessions recorded in this window — run \`tokitoki scan\` first`;
      }
      return `${windowLine(w)}\n${renderSessionLeaderboard(rows, { by: by as (typeof SESSION_DIMENSIONS)[number] | undefined })}`;
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

interface SessionColumn {
  header: string;
  align: "left" | "right";
  maxWidth?: number;
  render: (s: SessionSummary) => string;
}

const SESSION_COLUMNS: SessionColumn[] = [
  { header: "date", align: "left", render: (s) => s.startedAt.slice(0, 16).replace("T", " ") },
  { header: "provider", align: "left", render: (s) => s.provider },
  { header: "account", align: "left", render: (s) => s.accountKey },
  {
    header: "model(s)",
    align: "left",
    render: (s) => {
      const joined = s.models.join(",");
      return joined.length > 28 ? `${joined.slice(0, 27)}…` : joined;
    },
  },
  { header: "repo", align: "left", render: (s) => s.repos[0] ?? "(no repo)" },
  { header: "req", align: "right", render: (s) => formatInt(s.requests) },
  { header: "tokens", align: "right", render: (s) => humanCount(s.totalTokens) },
  { header: "%cache", align: "right", render: (s) => `${s.cachePct}%` },
  { header: "cost", align: "right", render: (s) => formatCost(s.costUsd) },
];

function sessionTable(rows: SessionSummary[]): string {
  const cells = rows.map((r) => SESSION_COLUMNS.map((c) => c.render(r)));
  const widths = SESSION_COLUMNS.map((c, i) =>
    Math.max(c.header.length, ...cells.map((row) => row[i]!.length)),
  );
  const pad = (text: string, width: number, align: "left" | "right") =>
    align === "left" ? text.padEnd(width) : text.padStart(width);
  const divider = widths.map((w) => "-".repeat(w)).join("  ");
  const out = [
    SESSION_COLUMNS.map((c, i) => pad(c.header, widths[i]!, c.align)).join("  "),
    divider,
  ];
  for (const row of cells) {
    out.push(row.map((cell, i) => pad(cell, widths[i]!, SESSION_COLUMNS[i]!.align)).join("  "));
  }
  return out.join("\n");
}

function renderSessionLeaderboard(
  rows: SessionSummary[],
  opts: { by?: (typeof SESSION_DIMENSIONS)[number] },
): string {
  if (opts.by === undefined) return sessionTable(rows);
  // Section per provider / repo, each with its own mini-leaderboard.
  const keyOf = (s: SessionSummary) =>
    opts.by === "provider"
      ? s.provider
      : s.repos.length > 1
        ? `${s.repos[0]} +${s.repos.length - 1}`
        : (s.repos[0] ?? "(no repo)");
  const groups = new Map<string, SessionSummary[]>();
  for (const r of rows) {
    const k = keyOf(r);
    let list = groups.get(k);
    if (list === undefined) {
      list = [];
      groups.set(k, list);
    }
    list.push(r);
  }
  const sections: string[] = [];
  for (const [key, list] of [...groups.entries()].sort(
    (a, b) => sumCost(b[1]) - sumCost(a[1]),
  )) {
    sections.push(`${key}  (${list.length} session${list.length === 1 ? "" : "s"})`);
    sections.push(sessionTable(list));
    sections.push("");
  }
  return sections.join("\n").trimEnd();
}

function sumCost(rows: SessionSummary[]): number {
  return rows.reduce((acc, r) => acc + r.costUsd, 0);
}

function renderSessionDrill(cache: EventCache, sessionId: string, json: boolean): string {
  const matches = cache.sessionProviders(sessionId);
  if (matches.length === 0) {
    throw new UserError(`no session '${sessionId}' in the local data`, "tokitoki scan && tokitoki sessions --top 25");
  }
  if (matches.length > 1) {
    throw new UserError(
      `session id exists under multiple providers: ${matches.join(", ")}`,
      `tokitoki sessions --session ${sessionId} --provider <one-of-them>`,
    );
  }
  const events = cache.sessionDetail(matches[0]!, sessionId);
  let runningTokens = 0;
  const detailRows = events.map((e, i) => {
    runningTokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    return { n: i + 1, ...e, runningTokens };
  });
  if (json) {
    return JSON.stringify({ provider: matches[0], sessionId, events: detailRows }, null, 2);
  }
  const header = `session ${sessionId} · ${matches[0]} · ${events.length} requests`;
  const widths = [4, 9, 22, 10, 10, 10, 8, 9, 11];
  const headers = ["#", "time", "model", "input", "output", "cache-rd", "%cache", "cost", "run.tok"];
  const lines = [header, headers.map((h, i) => (i <= 2 ? h.padEnd(widths[i]!) : h.padStart(widths[i]!).slice(0, widths[i]!))).join("  "), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of detailRows) {
    const cells = [
      String(r.n).padEnd(widths[0]!),
      r.ts.slice(11, 19).padEnd(widths[1]!),
      r.model.slice(0, 21).padEnd(widths[2]!),
      humanCount(r.inputTokens).padStart(widths[3]!),
      humanCount(r.outputTokens).padStart(widths[4]!),
      humanCount(r.cacheReadTokens).padStart(widths[5]!),
      `${cachePct(r.inputTokens, r.cacheReadTokens)}%`.padStart(widths[6]!),
      formatCost(r.costUsd).padStart(widths[7]!),
      humanCount(r.runningTokens).padStart(widths[8]!),
    ];
    lines.push(cells.join("  "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- sync

function runAnomalies(parsed: ParsedInvocation): void {
  try {
    const w = resolveCalendarWindow({ last: flagString(parsed, "last"), from: flagString(parsed, "from") ?? flagString(parsed, "since"), to: flagString(parsed, "to") ?? flagString(parsed, "until") }, "month");
    // Baseline needs trailing days: derive from the window length.
    const windowDays = Math.max(
      1,
      Math.round((Date.now() - new Date(w.sinceIso).getTime()) / 86_400_000),
    );
    const metricRaw = flagString(parsed, "metric") ?? "tokens";
    if (!ANOMALY_METRICS.includes(metricRaw as never)) {
      throw new UserError(
        `invalid --metric: ${metricRaw} (valid: ${ANOMALY_METRICS.join(", ")})`,
        "tokitoki anomalies --metric tokens",
      );
    }
    const json = flagBool(parsed, "json");
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const daily = cache.dailyTotals(w.sinceIso, w.untilIso);
      const found = detectAnomalies(daily, { metric: metricRaw as "tokens" | "cost" | "requests" });
      if (json) return JSON.stringify({ window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, metric: metricRaw, anomalies: found }, null, 2);
      if (found.length === 0) return `${windowLine(w)}\nno unusual activity in this window`;
      const header = ["date", "metric", "value", "baseline(14d)", "ratio"];
      const rows = found.map((a) => [
        a.day,
        a.metric,
        metricRaw === "cost" ? formatCost(a.value) : humanCount(a.value),
        metricRaw === "cost" ? formatCost(a.baseline) : humanCount(a.baseline),
        `${a.ratio.toFixed(1)}x`,
      ]);
      const widths = header.map((_, i) => Math.max(header[i]!.length, ...rows.map((r) => r[i]!.length)));
      const lines = [
        `${windowLine(w)}`,
        widths.map((w, i) => (i === 0 ? header[i]!.padEnd(w) : header[i]!.padStart(w))).join("  "),
        widths.map((w) => "-".repeat(w)).join("  "),
        ...rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ")),
      ];
      return lines.join("\n");
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- budgets

function runBudgets(parsed: ParsedInvocation): void {
  try {
    if (parsed.rest[0] === "init") {
      runBudgetsInit(parsed);
      return;
    }
    const json = flagBool(parsed, "json");
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const payload = computeBudgetStatus(cache, loadConfig().budgets);
      if (json) return JSON.stringify(gaugesForMenubar(payload), null, 2);
      if (!payload.configured) {
        return [
          "budgets · no [budgets] caps configured",
          "",
          "try adding to ~/.config/tokitoki/config.json:",
          '  "budgets": { "daily": 10, "weekly": 50, "monthly": 200 }',
        ].join("\n");
      }
      if (payload.rows.length === 0) return "budgets · configured, but nothing in window yet";
      const header = ["scope", "label", "used", "cap", "%used", "state", "left"];
      const rows = gaugesForMenubar(payload).map((g) => [
        g.scope,
        g.label,
        formatCost(g.used),
        formatCost(g.cap),
        `${Math.round(g.ratio * 100)}%`,
        g.state,
        `${g.daysLeft}d`,
      ]) as string[][];
      const widths = header.map((_, i) => Math.max(header[i]!.length, ...rows.map((r) => r[i]!.length)));
      const lines = [
        `budgets · calendar day/week/month caps`,
        widths.map((w, i) => (i <= 1 ? header[i]!.padEnd(w) : header[i]!.padStart(w))).join("  "),
        widths.map((w) => "-".repeat(w)).join("  "),
        ...rows.map((r) => r.map((c, i) => (i <= 1 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ")),
      ];
      const firing = payload.alerts.filter((a) => a.level === 100 || a.pct >= 0.8);
      if (firing.length > 0) lines.push(`\x1b[33m⚠ ${firing.length} budget(s) at or past a threshold — see rows above\x1b[0m`);
      return lines.join("\n");
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

/** Seed [budgets] from accounts actually present in the local cache. */
function runBudgetsInit(parsed: ParsedInvocation): void {
  try {
    const force = flagBool(parsed, "force");
    const cache = new EventCache();
    try {
      const detected = cache.detectedAccounts();
      if (detected.length === 0) {
        console.log("no accounts detected yet — run `tokitoki scan` first");
        return;
      }
      const result = seedBudgetsConfig(detected, { force });
      console.log(`config: ${result.configPathUsed}`);
      for (const a of result.added) console.log(`  + ${a.pattern}  monthly $${a.cap}`);
      for (const s of result.skipped) console.log(`  = ${s}  (already configured — use --force to replace)`);
      console.log("try: tokitoki budgets");
    } finally {
      cache.close();
    }
  } catch (err) {
    handleError(err);
  }
}

// -------------------------------------------------------------- presence

function runPresence(parsed: ParsedInvocation): void {
  try {
    const json = flagBool(parsed, "json");
    const machines = collectMachines(loadConfig());
    if (json) {
      console.log(JSON.stringify(machines, null, 2));
      return;
    }
    if (machines.length === 0) {
      console.log("no machines seen — heartbeats appear after `tokitoki sync --push` with a [sync] backend configured");
      return;
    }
    const lines = ["machine            host        state    last seen"];
    for (const m of machines) {
      const age = Math.round((Date.now() - m.ts) / 60_000);
      const ago = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      lines.push(
        m.machineId.padEnd(18) + m.host.slice(0, 11).padEnd(12) + m.state.padEnd(9) + ago,
      );
    }
    console.log(lines.join("\n"));
  } catch (err) {
    handleError(err);
  }
}

// ------------------------------------------------------------------ tools

function runTools(parsed: ParsedInvocation): void {
  try {
    const w = resolveTimeWindow({
      last: flagString(parsed, "last"),
      from: flagString(parsed, "from") ?? flagString(parsed, "since"),
      to: flagString(parsed, "to") ?? flagString(parsed, "until"),
      fallbackPeriod: "day",
    });
    const json = flagBool(parsed, "json");
    const topRaw = flagString(parsed, "top");
    const providers = flagStrings(parsed, "provider");
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const rows = cache.aggregate(w.sinceIso, "tool", providers, w.untilIso);
      rows.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests || b.inputTokens - a.inputTokens);
      const limited = topRaw !== undefined ? rows.slice(0, Math.max(1, Number.parseInt(topRaw, 10) || 5)) : rows;
      const totalTokensOf = (r: AggRow) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
      if (json) {
        return JSON.stringify(
          {
            period: { since: w.sinceIso, until: w.untilIso ?? new Date().toISOString() },
            tools: limited.map((r) => ({
              tool: r.bucket,
              requests: r.requests,
              tokens: totalTokensOf(r),
              costUsd: Math.round(r.costUsd * 1e4) / 1e4,
            })),
          },
          null,
          2,
        );
      }
      const header = ["tool", "req", "tokens", "%cache", "cost"];
      const body = limited.map((r) => [
        r.bucket,
        formatInt(r.requests),
        humanCount(totalTokensOf(r)),
        `${cachePct(r.inputTokens, r.cacheReadTokens)}%`,
        formatCost(r.costUsd),
      ]);
      if (body.length === 0) {
        return `${windowLine(w)}\nno tool-attributed usage in this window — try a wider one:\n  tokitoki tools --last week`;
      }
      const widths = header.map((_, i) => Math.max(header[i]!.length, ...body.map((r) => r[i]!.length)));
      const lines = [
        windowLine(w),
        widths.map((wdt, i) => (i === 0 ? header[i]!.padEnd(wdt) : header[i]!.padStart(wdt))).join("  "),
        widths.map((wdt) => "-".repeat(wdt)).join("  "),
        ...body.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ")),
      ];
      return lines.join("\n");
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- repos

function runRepos(parsed: ParsedInvocation): void {
  try {
    const worst = Math.max(1, Math.min(Number(flagString(parsed, "worst") ?? "0") || 0, 100));
    const providers = flagStrings(parsed, "provider");
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const w = resolveTimeWindow({ last: flagString(parsed, "last"), from: flagString(parsed, "from"), to: flagString(parsed, "to"), fallbackPeriod: "week" });
      const rows = cache.aggregate(w.sinceIso, "repo", providers.length > 0 ? providers : undefined, w.untilIso);
      if (rows.length === 0) return `${windowLine(w)}\nno usage recorded in this window — run \`tokitoki scan\` first`;
      let prevRows = new Map<string, AggRow>();
      if (w.period !== undefined) {
        const prev = previousWindow(w.period);
        prevRows = new Map(
          cache.aggregate(prev.sinceIso, "repo", providers.length > 0 ? providers : undefined, prev.untilIso).map((r) => [r.bucket, r]),
        );
      }
      const ranked = rows
        .map((r) => ({ row: r, eff: repoEfficiency(r, prevRows.get(r.bucket)) }))
        .sort((a, b) => b.eff.hostilityScore - a.eff.hostilityScore);
      const shown = worst > 0 ? ranked.slice(0, worst) : ranked;
      const header = ["repo", "req", "avg $/req", "%cache", "cache Δ", "tok/sess", "score"];
      const body = shown.map(({ row, eff }) => [
        row.bucket,
        formatInt(row.requests),
        `$${eff.avgCostPerReq.toFixed(4)}`,
        `${eff.cachePct}%`,
        `${eff.cacheTrendPts >= 0 ? "+" : ""}${eff.cacheTrendPts}pp`,
        humanCount(eff.tokensPerSession),
        eff.hostilityScore.toFixed(4),
      ]);
      const widths = header.map((_, i) => Math.max(header[i]!.length, ...body.map((r) => r[i]!.length)));
      const aligns: Array<"left" | "right"> = ["left", "right", "right", "right", "right", "right", "right"];
      const fmt = (cells: string[]): string => cells.map((c, i) => (aligns[i] === "left" ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
      return [
        `${windowLine(w)}`,
        `repo efficiency · score = avg $/req × (1 − cache%) — higher is worse`,
        "",
        fmt(header),
        widths.map((w) => "-".repeat(w)).join("  "),
        ...body.map(fmt),
      ].join("\n");
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- import

// ---------------------------------------------------------------- reindex

function runReindex(_parsed: ParsedInvocation): void {
  try {
    const out = withCache((cache) => {
      cache.sync(resolveExtraFiles(loadConfig()));
      const stats = rebuildSessionIndex(cache.database);
      return [
        `reindexed ${stats.docsIndexed} session(s) from ${stats.filesIndexed} file(s) in ${stats.durationMs}ms`,
        `try: tokitoki sessions --search "deploy" --last month`,
      ].join("\n");
    });
    console.log(out);
  } catch (err) {
    handleError(err);
  }
}

function runImport(parsed: ParsedInvocation): void {
  try {
    const file = parsed.rest[0];
    if (file === undefined || file.length === 0) {
      throw new UserError("import needs a CSV file", "tokitoki import ~/Downloads/usage.csv --dry-run");
    }
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      throw new UserError(`cannot read ${file}`, "tokitoki import ./usage.csv --dry-run");
    }
    const dryRun = flagBool(parsed, "dry-run");
    const result = importCsv(text, localMachineId());
    if (result.source === null) {
      throw new UserError(
        "could not recognize this CSV's columns",
        "try re-exporting from the provider console, or check README#backfill-imports",
      );
    }
    const sourceOverride = flagString(parsed, "source");
    if (sourceOverride !== undefined && sourceOverride !== result.source) {
      console.log(`note: headers look like '${result.source}' (asked for '${sourceOverride}')`);
    }
    const label = `${result.source}-import`;
    if (dryRun) {
      console.log(`dry-run: would import ${result.events.length} events from ${result.source} (${result.skipped} rows skipped)`);
      return;
    }
    // Insert into the append-log so cursors/cache treat them like any event.
    const written = appendEvents(result.events);
    withCache((cache) => cache.sync(resolveExtraFiles(loadConfig())));
    console.log(`imported ${written} events from ${file} as ${label} (${result.skipped} rows skipped)`);
  } catch (err) {
    handleError(err);
  }
}

function runShare(parsed: ParsedInvocation): Promise<void> {
  const scope = (flagString(parsed, "scope") ?? "week") as ShareScope;
  if (scope !== "week" && scope !== "month") {
    throw new UserError(
      `invalid --scope: ${scope} (valid: week, month)`,
      "tokitoki share --publish --scope month",
    );
  }
  if (flagBool(parsed, "enable")) {
    const state = readShareState();
    state.enabled = true;
    writeShareState(state);
    console.log("public sharing enabled — nothing published yet");
    console.log('publish now with: tokitoki share --publish --scope week');
    return Promise.resolve();
  }
  if (flagBool(parsed, "disable")) {
    const state = readShareState();
    state.enabled = false;
    writeShareState(state);
    console.log("public sharing disabled");
    return Promise.resolve();
  }
  if (!flagBool(parsed, "publish")) {
    runShareStatus();
    return Promise.resolve();
  }
  if (!readShareState().enabled) {
    throw new UserError(
      "public sharing is disabled",
      "tokitoki share --enable && tokitoki share --publish",
    );
  }
  const includeRepos = flagBool(parsed, "include-repos");
  const payload = buildSharePayload(scope, { includeRepos });
  for (const line of describePayload(payload, includeRepos)) console.log(`  ${line}`);
  return publishShare(scope, { includeRepos })
    .then((result) => {
      console.log(`published dev.tokitoki.share/${result.rkey} (cid ${result.cid})`);
    })
    .catch((err: unknown) => {
      throw err instanceof UserError
        ? err
        : new UserError(err instanceof Error ? err.message : String(err), "tokitoki share --status");
    });
}

function runShareStatus(): void {
  const state = readShareState();
  console.log(`public sharing: ${state.enabled ? "enabled" : "disabled"}`);
  if (state.lastPublished !== undefined) {
    const lp = state.lastPublished;
    console.log(`last publish: dev.tokitoki.share/${lp.rkey} at ${lp.at} (cid ${lp.cid})`);
  } else {
    console.log("nothing published yet");
  }
  console.log('enable/disable: tokitoki share --enable | --disable');
}

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

// ---------------------------------------------------------------- blocks / statusline / mcp / menubar

async function runPoll(parsed: ParsedInvocation): Promise<void> {
  const jsonOut = flagBool(parsed, "json");
  if (parsed.flags["enable"] !== undefined) {
    setPollEnabled(true);
    console.log("background quota polling enabled (menubar runs it every ~15 min)");
    return;
  }
  if (parsed.flags["disable"] !== undefined) {
    setPollEnabled(false);
    console.log("background quota polling disabled");
    return;
  }
  const cache = new EventCache();
  try {
    const config = loadConfig();
    const result = await pollQuotas({
      cache,
      providers: flagStrings(parsed, "provider"),
      // Manually registered opencode gateway keys (multi-account).
      manualKeys: (config.poll?.extraKeys ?? [])
        .filter((k) => k.key.length > 0)
        .map((k) => ({
          id: k.id,
          provider: (k.provider ?? "opencode-go") as "opencode-go" | "openrouter",
          key: k.key,
        })),
    });
    if (jsonOut) {
      console.log(JSON.stringify(result));
      return;
    }
    if (!result.ok) {
      console.log(`poll failed: ${result.reason ?? "unknown reason"}`);
      return;
    }
    for (const acc of result.accounts) {
      console.log(`${acc.accountKey}${acc.email !== undefined ? ` (${acc.email})` : ""}:`);
      for (const w of acc.windows) {
        console.log(`  ${w.windowMinutes}min window · ${w.usedPct}% used · resets ${new Date(w.resetsAtEpoch * 1000).toLocaleString()}`);
      }
      console.log(`  → ${acc.inserted} snapshot(s) stored${acc.error !== undefined ? ` · ${acc.error}` : ""}`);
    }
  } finally {
    cache.close();
  }
}

async function runBlocks(parsed: ParsedInvocation): Promise<void> {
  const w = resolveCalendarWindow(
    {
      last: flagString(parsed, "last"),
      from: flagString(parsed, "from") ?? flagString(parsed, "since"),
      to: flagString(parsed, "to") ?? flagString(parsed, "until"),
    },
    "day",
  );
  const account = flagString(parsed, "account");
  const out = withCache((cache) => {
    cache.sync(resolveExtraFiles(loadConfig()));
    return renderBlocks(cache.blockWindows(w.sinceIso, w.untilIso, account));
  });
  console.log(`${windowLine(w)}\n${out}`);
}

async function runStatusline(_parsed: ParsedInvocation): Promise<void> {
  let raw = "";
  try {
    if (!process.stdin.isTTY) raw = fs.readFileSync(0, "utf8");
  } catch {
    // no stdin provided — degrade to totals-only line
  }
  const input = parseStatuslineStdin(raw);
  const cache = new EventCache();
  try {
    cache.sync(resolveExtraFiles(loadConfig()));
    const line = await renderStatusline(input, cache);
    if (line.length > 0) console.log(line);
  } finally {
    cache.close();
  }
}

async function runMenubar(parsed: ParsedInvocation): Promise<void> {
  const stop = flagBool(parsed, "stop");
  const status = flagBool(parsed, "status");
  const rebuild = flagBool(parsed, "rebuild");
  const foreground = flagBool(parsed, "foreground");

  if (status) {
    const s = await menubarStatus();
    console.log(s.status === "running" ? `menubar running (pid ${s.pid})` : "menubar not running");
    return;
  }
  if (stop) {
    const s = await stopMenubar();
    console.log(s.status === "stopped" ? "menubar stopped" : "menubar not running");
    return;
  }

  let bin = resolveMenubarBin();
  if (bin === null && rebuild) throw new UserError("menubar app not found and --rebuild requested", "tokitoki menubar");
  if (bin === null) {
    if (rebuild) throw new UserError("cannot rebuild: app not found", "tokitoki menubar");
    if (process.platform === "darwin") {
      throw new UserError(
        "tokitoki-menubar binary not found",
        "build it: cd menubar/tokitoki-menubar && swift build -c release && cp .build/release/tokitoki-menubar ~/bin/",
      );
    }
    throw new UserError(`no menubar app for ${process.platform} yet`, "see plans/linux-menubar.md for status");
  }

  if (rebuild && bin !== null && bin.source === "repo-build") {
    const proc = Bun.spawnSync(["swift", "build", "-c", "release"], { cwd: "menubar/tokitoki-menubar", stdout: "inherit", stderr: "inherit" });
    if (!proc.success) throw new UserError("swift build failed", "tokitoki menubar --rebuild");
  }

  // A configured LaunchAgent does not execute the repo build selected above;
  // it executes its own ProgramArguments path (normally ~/bin). Keep those
  // two paths synchronized, then restart launchd so an already-running stale
  // process cannot survive a successful rebuild.
  let installedRebuild = false;
  if (rebuild && bin !== null && bin.source === "repo-build" && process.platform === "darwin") {
    installedRebuild = installRebuiltMenubarBinary(bin.path) !== null;
    if (installedRebuild) await stopMenubar();
  }

  if (foreground) {
    if (bin === null) throw new UserError("tokitoki-menubar binary not found", "tokitoki menubar");
    console.log(`${bin.path} (foreground, ctrl-c to quit)`);
    const proc = Bun.spawn([bin.path], { stdio: ["ignore", "inherit", "inherit"] });
    await proc.exited;
    return;
  }

  // startMenubar re-resolves internally and is idempotent.
  const result = await startMenubar({ envBin: process.env.TOKITOKI_MENUBAR_BIN });
  if (result.status === "running") console.log(`menubar already running (pid ${result.pid})`);
  else console.log(`menubar started (pid ${result.pid}, ${result.mode})`);
}

/**
 * Generic dotted-path config setter: `config set ui.previewHidden ["openai"]`.
 * The value MUST be valid JSON (strings quoted). Rejects unknown top-level
 * sections so typos can not invent config shape.
 */
function runConfigSet(parsed: ParsedInvocation): void {
  try {
    const rest = parsed.rest.filter((r) => r !== "set");
    const pathArg = rest[0] ?? flagString(parsed, "path");
    const valueArg = rest[1] ?? flagString(parsed, "value");
    if (pathArg === undefined || pathArg.length === 0 || valueArg === undefined) {
      throw new UserError("usage: tokitoki config set <dot.path> <json>", 'tokitoki config set ui.stripMetric "tokens"');
    }
  const allowed = new Set(["ui", "poll", "sync", "hidden", "plans", "budgets", "extraEventFiles", "experimental"]);
    const top = pathArg.split(".")[0]!;
    if (!allowed.has(top)) {
      throw new UserError(`unknown config section '${top}'`, "sections: ui, poll, plans, budgets");
    }
    let value: unknown;
    try {
      value = JSON.parse(valueArg);
    } catch {
      // convenience: bare words become strings ("tokens", "openai")
      value = valueArg;
    }
    const cfg = loadConfig() as Record<string, unknown>;
    const parts = pathArg.split(".");
    let node = cfg;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      if (node[key] === undefined || typeof node[key] !== "object" || node[key] === null) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = value;
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`${pathArg} = ${JSON.stringify(value)}`);
  } catch (err) {
    handleError(err);
  }
}

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
        handlePortInUse(port);
        return;
      }
      throw err;
    }
    console.log(`tokitoki dashboard → http://localhost:${server.port}`);

    // Graceful shutdown: without explicit handlers a stray keepalive/socket
    // can leave the process squatting on the port after Ctrl-C, forcing a
    // kill-port. stop(true) also drops live connections.
    const shutdown = (signal: string) => {
      console.log(`\n${signal} — closing dashboard`);
      try {
        server.stop(true);
      } catch {
        // already gone
      }
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    handleError(err);
  }
}

/** Port already bound: if it is another tokitoki dashboard, just open it;
 *  otherwise point at the culprit and suggest a free port. */
function handlePortInUse(port: number): void {
  const url = `http://localhost:${port}`;
  const probe = Bun.spawnSync(["curl", "-sfm", "2", `${url}/api/healthz`], { stdout: "pipe", stderr: "ignore" });
  const body = probe.stdout ? new TextDecoder().decode(probe.stdout) : "";
  let isTokitoki = false;
  try {
    isTokitoki = (JSON.parse(body) as { app?: string }).app === "tokitoki";
  } catch {
    isTokitoki = false;
  }
  if (isTokitoki) {
    console.log(`dashboard already running at ${url} — opening it`);
    Bun.spawnSync(["open", url]);
    return;
  }
  const alt = nextFreePort(port + 1);
  console.error(`error: port ${port} is already in use (not a tokitoki dashboard)`);
  console.error(`\x1b[2mtry: tokitoki web --port ${alt}\x1b[0m`);
  console.error(`\x1b[2m     lsof -i :${port}   # see what holds the port\x1b[0m`);
  process.exitCode = 1;
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
function sparkSection(cache: EventCache, w: TimeWindow, by: string | undefined): string {
  let series: SeriesBucket[];
  if (by === "model" || by === "provider") {
    series = cache.seriesDaily(w.sinceIso, by);
  } else {
    const days = cache.dailyTotals(w.sinceIso, w.untilIso);
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

/** git-diff addition green for changed providers — color only on a TTY. */
function scanAdded(text: string): string {
  return process.stdout.isTTY === true ? `\x1b[32m${text}\x1b[0m` : text;
}

/** Italic dim for unchanged providers — color only on a TTY. */
function scanQuiet(text: string): string {
  return process.stdout.isTTY === true ? `\x1b[2;3m${text}\x1b[0m` : text;
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

function captureStdoutJson(fn: () => void): unknown {
  const orig = console.log;
  const chunks: string[] = [];
  console.log = (...a: unknown[]) => { chunks.push(a.join(" ")); };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return JSON.parse(chunks.join("\n"));
}

function inv(command: string, flags: Record<string, FlagValue | string[]> = {}): ParsedInvocation {
  return { command, flags, rest: [] };
}

/** Local calendar date key (YYYY-MM-DD) offset by whole days. */
function localDateKey(offsetDays = 0): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function runMenubarPayload(parsed: ParsedInvocation): void {
  // Sequential single-process composition: the menu bar previously spawned
  // 7 CLIs at once (~1GB RSS each) and thrashed memory.
  const parts: Record<string, unknown> = {};
  const capture = (key: string, fn: () => void): void => {
    const orig = console.log;
    console.log = (...a: unknown[]) => { parts[key] = JSON.parse(a.map(String).join(" ")); };
    try {
      fn();
    } finally {
      console.log = orig;
    }
  };
  // "today" = local CALENDAR day, not a rolling 24h window — a rolling
  // window makes the hero number drift DOWN as yesterday's hours fall out.
  const todayKey = localDateKey(0);
  capture("today", () => runReport(inv("report", { by: "provider", json: true, from: todayKey, to: todayKey })));
  // Token Pulse intentionally uses a rolling 24-hour window: people use this
  // view to answer "what have I spent today?" even when yesterday evening's
  // activity is still within the current workday. Keep the calendar-day
  // payload above for the Home/report semantics.
  capture("rollingDay", () => runReport(inv("report", { last: "day", by: "provider", json: true })));
  capture("week", () => runReport(inv("report", { last: "week", by: "provider", json: true })));
  capture("reposMonth", () => runReport(inv("report", { last: "month", by: "repo", json: true })));
  capture("budgets", () => runBudgets(inv("budgets", { json: true })));
  capture("anomalies", () => runAnomalies(inv("anomalies", { json: true })));
  capture("topTools", () => runTools(inv("tools", { last: "day", top: "3", json: true })));
  capture("presence", () => runPresence(inv("presence", { json: true })));
  capture("history", () => {
    const config = loadConfig();
    withCache((cache) => {
      cache.sync(config.extraEventFiles ?? []);
      const sinceIso = new Date(Date.now() - 29 * 86_400_000).toISOString();
      const buckets = cache.seriesDaily(sinceIso, "provider", 6, "tokens");
      const days = [...new Set(buckets.flatMap((bucket) => bucket.days))].sort();
      console.log(JSON.stringify({
        days,
        series: buckets.map((bucket) => ({
          bucket: bucket.bucket,
          values: days.map((day) => {
            const index = bucket.days.indexOf(day);
            return index >= 0 ? bucket.values[index] ?? 0 : 0;
          }),
        })),
      }));
    });
  });
  capture("uiPreview", () => {
    const config = loadConfig();
    withCache((cache) => {
      console.log(
        JSON.stringify({
          previewLines: config.ui?.menubarPreviewLines ?? 3,
          previewMode: config.ui?.menubarPreviewMode ?? "inline",
          providers: [...new Set([
            ...cache.providerStats().keys(),
            // Cursor is a binary-store/search provider: it can be present
            // without token rows, so providerStats() alone would hide it.
            ...PROVIDERS.filter((provider) => provider.id === "cursor" && provider.discoverRoots().some((root) => provider.listFiles(root).length > 0)).map((provider) => provider.id),
          ])].sort(),
          menubarHidden: config.ui?.hidden?.menubar ?? [],
          previewHidden: config.ui?.previewHidden ?? [],
          stripMetric: config.ui?.stripMetric ?? "percent",
          stripExhausted: config.ui?.stripExhausted ?? "reset",
          cards: menubarCardLayout(config),
          tabs: config.ui?.menubarTabs ?? [...MENUBAR_TABS],
          syncBackend: config.sync?.backend,
          syncConfigured: config.sync?.backend !== undefined,
          syncPath: config.sync?.path,
          syncUrl: config.sync?.url,
          syncHandle: config.sync?.handle,
          pollAuto: config.poll?.enabled === true,
          pollIntervalMinutes: config.poll?.intervalMinutes ?? 15,
          pollAdaptive: config.poll?.adaptive === true,
        }),
      );
    });
  });
  capture("limits", () => {
    const config = loadConfig();
    withCache((cache) => {
      cache.sync(config.extraEventFiles ?? []);
      // FULL limits go over the wire — the app filters popover cards via
      // hidden.menubar and strip marks via previewHidden independently.
      const limits = computeLimits(cache, config);
      const poolIdentities = opencodexAccountIdentities();
      const poolQuotas = opencodexQuotas();
      const localCodexAccountId = accountIdentityFor("codex")?.accountId;
      // Attribute pooled Codex cards by the stable provider account ID. Reset
      // timestamps are quota data, not identity, and can drift independently.
      const limitsWithPoolEmails = limits.map((l) => {
        if (l.provider !== "codex") return l;
        const accountIds = cache.quotaAccountIds("codex", l.accountKey);
        const poolId = Object.entries(poolIdentities).find(([, identity]) =>
          identity.accountId !== undefined && accountIds.has(identity.accountId),
        )?.[0];
        const email = poolId !== undefined ? poolIdentities[poolId]?.email : undefined;
        return email !== undefined ? { ...l, email } : l;
      });
      // The pool adapter's opaque `chatgpt-<timestamp>` key can also exist
      // in old scanned logs. Once the same reset is refreshed into the
      // canonical `codex` card, hide that stale duplicate from the UI.
      const normalizedLimits = limitsWithPoolEmails.filter((l) => {
        if (l.provider !== "codex" || !l.accountKey.startsWith("codex:")) return true;
        const poolKey = l.accountKey.slice("codex:".length);
        if (poolQuotas[poolKey] === undefined) return true;
        // Keep a pool-backed card when its stable account ID is known. The
        // old reset-based rule hid the canonical work card and left its
        // personal email on the remaining __main__ card.
        const poolId = poolIdentities[poolKey]?.accountId;
        return poolId === undefined || cache.quotaAccountIds("codex", l.accountKey).has(poolId);
      });
      // Older runs wrote the active login through both openai:plus and the
      // opencodex codex alias. Once IDs are available, keep the canonical
      // live-poll key and discard that duplicate permanently.
      const withoutLocalCodexAliases = normalizedLimits.filter((l) => {
        if (l.provider !== "codex" || localCodexAccountId === undefined) return true;
        if (l.accountKey.startsWith("openai:")) return true;
        return !cache.quotaAccountIds("codex", l.accountKey).has(localCodexAccountId);
      });
      // Same provider + same embedded-quota signature = same underlying
      // account seen through different extraction eras. One card per account.
      const merged = mergeAliasLimits(withoutLocalCodexAliases);
      // Key-based harnesses: attach a redacted credential so accounts are
      // distinguishable without emails (pi / opencode auth is API-key only).
      // OpenRouter keys live in pi's auth store — same treatment.
      const creds = opencodeCredentials();
      const piKeys = piCredentials();
      const withCreds = merged.map((l) => {
        // opencodeCredentials() already returns a redacted display value;
        // piCredentials() returns the raw key. Do not redact the former a
        // second time (that collapsed it to just "…" and broke grouping).
        const opencodeCred = creds[l.accountKey];
        if (opencodeCred !== undefined) return { ...l, credential: opencodeCred };
        const piCred = l.provider === "pi" ? piKeys[l.accountKey] : undefined;
        return piCred !== undefined ? { ...l, credential: redactCredential(piCred) } : l;
      });
      // Accounts sharing one credential (pi + opencode on the same gateway
      // key) are ONE real account — collapse to a single card.
      const grouped = groupBySharedCredential(withCreds);
      // Origin provenance for the details disclosure: where did this
      // account's quota data come from? One tiny indexed query per account.
      const withOrigin = dedupeAccountLimits(grouped.map((l) => {
        try {
          const row = cache.database
            .query(
              `SELECT CASE WHEN event_id LIKE '%:opencodex' THEN 'opencodex'
                           ELSE 'polled' END AS origin
               FROM quota_snapshots
               WHERE provider = ? AND account_key = ? AND event_id LIKE 'poll:%'
               LIMIT 1`,
            )
            .get(l.provider, l.accountKey) as { origin?: string } | null;
          return { ...l, origin: row?.origin ?? "scan" };
        } catch {
          return { ...l, origin: "scan" };
        }
      }));
      // Detected-but-empty harnesses still deserve a card (commandcode etc.)
      // so users can see the harness is known — zero windows until data lands.
      if (config.experimental?.zeroStateCards !== false) {
        const known = new Set(withOrigin.map((l) => `${l.provider}@${l.accountKey}`));
        for (const [provider, accountKey, root] of [
          ["commandcode", "default", `${process.env.HOME ?? "~"}/.commandcode`],
        ] as Array<[string, string, string]>) {
          if (known.has(`${provider}@${accountKey}`)) continue;
          try {
            if (fs.existsSync(root)) {
              withOrigin.push({ provider, accountKey, origin: "scan", windows: [] });
            }
          } catch { /* probe only */ }
        }
      }
      // Manual provider keys get a card even with zero scanned events; the
      // poller stores OpenCode Go under pi/<id> and OpenRouter under
      // openrouter/<id>.
      for (const mk of config.poll?.extraKeys ?? []) {
        const provider = mk.provider ?? "opencode-go";
        const cardProvider = provider === "openrouter" ? "openrouter" : "pi";
        if (withOrigin.some((l) => l.provider === cardProvider && l.accountKey === mk.id)) continue;
        const snaps = cache.latestQuotaSnapshots(cardProvider, mk.id);
        const windows = snaps.map((snap) => ({
          kind: embeddedKind(snap.windowMinutes),
          source: "embedded" as const,
          tokens: 0,
          cost: 0,
          requests: 0,
          usedPct: Math.max(0, Math.min(100, snap.usedPct)),
          resetsAt: snap.resetsAt > 0 ? new Date(snap.resetsAt * 1000).toISOString() : undefined,
        }));
        withOrigin.push({
          provider: cardProvider,
          accountKey: mk.id,
          credential: redactCredential(mk.key),
          origin: "manual",
          windows,
        });
      }
      // Polled-only providers (Copilot/Cursor) may have no local event rows,
      // but their live quota must still appear as a card and strip group.
      try {
        const polled = cache.database
          .query("SELECT DISTINCT provider, account_key AS accountKey FROM quota_snapshots WHERE event_id LIKE 'poll:%'")
          .all() as Array<{ provider: string; accountKey: string }>;
        const known = new Set(withOrigin.map((l) => `${l.provider}@${l.accountKey}`));
        for (const p of polled) {
          const id = `${p.provider}@${p.accountKey}`;
          // pollQuotas mirrors a gateway quota under both pi and opencode;
          // grouping has already collapsed those into one card. Do not add
          // the mirrored snapshot back as a duplicate here.
          const mirroredInSharedGateway =
            (p.provider === "pi" || p.provider === "opencode") &&
            (known.has(`pi@${p.accountKey}`) || known.has(`opencode@${p.accountKey}`));
          if (known.has(id)) {
            const existingIndex = withOrigin.findIndex((l) => `${l.provider}@${l.accountKey}` === id);
            // Replace the earlier detected-but-empty placeholder once a
            // provider poll has produced real windows.
            if (existingIndex >= 0 && withOrigin[existingIndex]!.windows.length === 0) {
              withOrigin.splice(existingIndex, 1);
              known.delete(id);
            } else {
              continue;
            }
          }
          if (mirroredInSharedGateway) continue;
          const snaps = cache.latestQuotaSnapshots(p.provider, p.accountKey);
          const windows = snaps.map((snap) => ({
            kind: embeddedKind(snap.windowMinutes),
            source: "embedded" as const,
            tokens: 0,
            cost: 0,
            requests: 0,
            usedPct: Math.max(0, Math.min(100, snap.usedPct)),
            resetsAt: snap.resetsAt > 0 ? new Date(snap.resetsAt * 1000).toISOString() : undefined,
          }));
          const accountIds = cache.quotaAccountIds(p.provider, p.accountKey);
          if (
            p.provider === "codex" &&
            localCodexAccountId !== undefined &&
            !p.accountKey.startsWith("openai:") &&
            accountIds.has(localCodexAccountId)
          ) {
            // Already represented by the canonical openai:<plan> card.
            continue;
          }
          const poolIdentity = p.provider === "codex"
            ? Object.values(poolIdentities).find((identity) =>
                identity.accountId !== undefined && accountIds.has(identity.accountId),
              )
            : undefined;
          withOrigin.push({
            provider: p.provider,
            accountKey: p.accountKey,
            ...(poolIdentity?.email !== undefined ? { email: poolIdentity.email } : {}),
            origin: "polled",
            windows,
          });
        }
      } catch {
        // pre-migration cache: no quota snapshot table
      }
      // Drag-saved display order first, then the default (token-heavy) order.
      const savedOrder = config.ui?.menubarAccountOrder ?? [];
      const rank = (l: AccountLimits): number => {
        const i = savedOrder.indexOf(`${l.provider}@${l.accountKey}`);
        return i === -1 ? savedOrder.length : i;
      };
      withOrigin.sort((a, b) => rank(a) - rank(b));
      console.log(JSON.stringify(withOrigin));
    });
  });
  capture("spendPeriods", () => {
    const yFrom = new Date(Date.now() - 86_400_000);
    const yKey = `${yFrom.getFullYear()}-${String(yFrom.getMonth() + 1).padStart(2, "0")}-${String(yFrom.getDate()).padStart(2, "0")}`;
    const periods: Array<Record<string, unknown>> = [];
    const grab = (key: string, flags: Record<string, FlagValue>): void => {
      try {
        capture("rows", () => runReport(inv("report", { by: "provider", sort: "cost", json: true, ...flags })));
        const report = parts["rows"] as { rows?: unknown } | undefined;
        periods.push({ key, rows: report?.rows ?? [] });
      } catch {
        periods.push({ key, rows: [] });
      }
    };
    grab("today", { from: todayKey, to: todayKey });
    grab("yesterday", { from: yKey, to: yKey });
    grab("week", { last: "week" });
    grab("month", { last: "month" });
    grab("year", { last: "year" });
    console.log(JSON.stringify(periods));
  });
  console.log(JSON.stringify(parts));
}

function runUi(parsed: ParsedInvocation): void {
  const surfaceRaw = flagString(parsed, "surface") ?? "menubar";
  assertValidSurface(surfaceRaw);
  const hide = flagString(parsed, "hide");
  const show = flagString(parsed, "show");
  const menubarOnly = parsed.flags["menubar-only"];
  const tabs = flagString(parsed, "tabs");
  const cardSet = flagString(parsed, "card-set");
  if (cardSet !== undefined) {
    setMenubarCards(cardSet);
    console.log("card layout saved");
    return;
  }
  const accountOrder = flagString(parsed, "account-order");
  if (accountOrder !== undefined) {
    setMenubarAccountOrder(accountOrder.split(",").map((s) => s.trim()).filter(Boolean));
    console.log("account order saved");
    return;
  }
  if (tabs !== undefined) {
    const ids = tabs.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0 || ids.some((id) => !(MENUBAR_TABS as readonly string[]).includes(id))) {
      throw new UserError(`invalid tab id (valid: ${MENUBAR_TABS.join(", ")})`, "tokitoki ui --tabs overview,quotas,tokens,reports,sources,mcp,settings");
    }
    setMenubarTabs(ids);
    console.log("tab layout saved");
    return;
  }

  if (parsed.flags.list !== undefined || (hide === undefined && show === undefined && menubarOnly === undefined)) {
    const cfg = loadConfig();
    console.log(`surface visibility (config: ${configPath()})`);
    for (const s of ["menubar", "dashboard"] as const) {
      const hidden = cfg.ui?.hidden?.[s] ?? [];
      console.log(`  ${s}: hidden=[${hidden.join(", ")}]`);
    }
    console.log(`  menubarProviders: [${(cfg.ui?.menubarProviders ?? []).join(", ")}] (empty = all)`);
    return;
  }
  if (hide !== undefined) setSurfaceVisibility(hide, surfaceRaw, false);
  if (show !== undefined) setSurfaceVisibility(show, surfaceRaw, true);
  if (menubarOnly !== undefined) {
    const vals = Array.isArray(menubarOnly) ? menubarOnly : [String(menubarOnly)];
    if (!(vals.length === 1 && vals[0] === "all")) setMenubarProviders(vals.map(String));
    else setMenubarProviders([]);
  }
  console.log(`ok — run 'tokitoki ui --list' to inspect`);
}

// Only auto-run when executed directly — importing must stay side-effect
// free so tests can inspect the registry.
if (import.meta.main) void main(process.argv.slice(2));
