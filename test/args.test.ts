import { describe, expect, it } from "bun:test";

import { parseArgs } from "../src/args.ts";
import { resolveSortColumn, sortRows, totalRow } from "../src/report.ts";
import type { AggRow } from "../src/cache.ts";

describe("parseArgs", () => {
  it("splits command, flags with values, booleans", () => {
    const p = parseArgs(["report", "--last", "week", "--by", "model", "--json"]);
    expect(p.command).toBe("report");
    expect(p.flags.last).toBe("week");
    expect(p.flags.by).toBe("model");
    expect(p.flags.json).toBe(true);
  });

  it("supports --key=value form", () => {
    const p = parseArgs(["pie", "--by=model"]);
    expect(p.flags.by).toBe("model");
  });

  it("accumulates repeatable --provider flags", () => {
    const p = parseArgs([
      "report",
      "--last",
      "month",
      "--provider",
      "pi",
      "--provider",
      "codex",
    ]);
    expect(p.flags.provider).toEqual(["pi", "codex"]);
  });

  it("treats %cache as a flag value, not a new flag", () => {
    const p = parseArgs(["report", "--sort", "%cache"]);
    expect(p.flags.sort).toBe("%cache");
  });

  it("collects extra bare tokens into rest", () => {
    const p = parseArgs(["scan", "stray"]);
    expect(p.rest).toEqual(["stray"]);
  });
});

function row(bucket: string, requests: number, cost: number, input = 100, cacheRead = 50): AggRow {
  return {
    bucket,
    requests,
    sessions: Math.max(1, Math.round(requests / 2)),
    costUsd: cost,
    inputTokens: input,
    outputTokens: 10,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
  };
}

describe("sortRows", () => {
  const rows = [row("a", 5, 1), row("b", 10, 3), row("c", 2, 3)];

  it("defaults to cost desc then requests desc", () => {
    expect(sortRows(rows).map((r) => r.bucket)).toEqual(["b", "c", "a"]);
  });

  it("sorts by resolved column with --asc semantics", () => {
    expect(sortRows(rows, "requests", true).map((r) => r.bucket)).toEqual(["c", "a", "b"]);
    // equal %cache everywhere → ties break by requests desc
    expect(sortRows(rows, resolveSortColumn("%cache"), false).map((r) => r.bucket)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts by bucket name ascending", () => {
    expect(sortRows(rows, "bucket", true).map((r) => r.bucket)).toEqual(["a", "b", "c"]);
  });
});

describe("totalRow", () => {
  it("sums every metric", () => {
    const t = totalRow([row("a", 5, 1), row("b", 10, 3)]);
    expect(t.bucket).toBe("TOTAL");
    expect(t.requests).toBe(15);
    expect(t.costUsd).toBe(4);
    expect(t.inputTokens).toBe(200);
  });
});
