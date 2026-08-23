#!/usr/bin/env node
import { Command } from "commander";

import { localMachineId } from "./machine.ts";
import { PROVIDERS, getProvider } from "./providers/index.ts";
import { scanProvider } from "./scan.ts";
import { EventCache } from "./cache.ts";
import { sinceIsoFor, resolveExtraFiles } from "./report.ts";
import { loadConfig } from "./config.ts";

type Period = "day" | "week" | "month";
type Dimension = "model" | "project" | "account" | "machine" | "provider";

const DIMENSIONS: Dimension[] = ["model", "project", "account", "machine", "provider"];

const program = new Command();

program
  .name("tokitoki")
  .description("Unified coding-agent usage analytics across machines and harnesses")
  .version("0.1.0");

program
  .command("scan")
  .description("Incrementally scan harness session stores into the local event log")
  .option("--provider <id>", "only scan this provider")
  .action((opts: { provider?: string }) => {
    const machineId = localMachineId();
    const providers = opts.provider !== undefined ? [getProvider(opts.provider)] : PROVIDERS;
    for (const p of providers) {
      if (p === undefined) {
        console.error(
          `unknown provider: ${opts.provider} (known: ${PROVIDERS.map((x) => x.id).join(", ")})`,
        );
        process.exitCode = 1;
        return;
      }
      const result = scanProvider(p, machineId);
      console.log(`${result.provider}: +${result.eventsEmitted} events (${result.filesScanned} files updated)`);
    }
  });

program
  .command("report")
  .description("Aggregate usage over a rolling window")
  .requiredOption("--last <period>", "day | week | month")
  .option("--by <dimension>", "model | project | account | machine | provider", "model")
  .option("--json", "output JSON instead of a table")
  .action((opts: { last: string; by?: string; json?: boolean }) => {
    runReport(opts.last, opts.by ?? "model", opts.json === true);
  });

for (const [cmd, period] of [
  ["today", "day"],
  ["week", "week"],
  ["month", "month"],
] as const) {
  program
    .command(cmd)
    .description(`usage ${period === "day" ? "for today" : `over the last ${period}`}`)
    .option("--by <dimension>", "grouping dimension", "model")
    .option("--json", "output JSON instead of a table")
    .action((opts: { by?: string; json?: boolean }) => {
      runReport(period, opts.by ?? "model", opts.json === true);
    });
}

function runReport(period: string, groupBy: string, asJson: boolean): void {
  if (period !== "day" && period !== "week" && period !== "month") {
    console.error(`invalid period: ${period}`);
    process.exitCode = 1;
    return;
  }
  if (!DIMENSIONS.includes(groupBy as Dimension)) {
    console.error(`invalid --by: ${groupBy} (valid: ${DIMENSIONS.join(", ")})`);
    process.exitCode = 1;
    return;
  }

  const cache = new EventCache();
  try {
    cache.sync(resolveExtraFiles(loadConfig()));
    const rows = cache.aggregate(sinceIsoFor(period as Period), groupBy as Dimension);
    if (asJson) {
      console.log(JSON.stringify({ period, groupBy, rows }, null, 2));
    } else {
      printTable(rows);
    }
  } finally {
    cache.close();
  }
}

function printTable(rows: Awaited<ReturnType<EventCache["aggregate"]>>): void {
  if (rows.length === 0) {
    console.log("no usage recorded in this window — run `tokitoki scan` first");
    return;
  }
  const fmtInt = (n: number): string => n.toLocaleString("en-US");
  const header = ["bucket", "requests", "input", "output", "cache read", "cost $"];
  const body = rows.map((r) => [
    r.bucket,
    fmtInt(r.requests),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.cacheReadTokens),
    r.costUsd.toFixed(4),
  ]);
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i]?.length ?? 0)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w ?? 0)).join("  "));
  for (const cells of body) console.log(line(cells));
}

void program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
