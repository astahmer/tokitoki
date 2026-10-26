import { afterEach, describe, expect, it } from "bun:test";
import { codexProvider } from "../src/providers/codex.ts";
import { setTableForTests } from "../src/pricing.ts";
import type { EntryContext } from "../src/providers/types.ts";

const ctx = (): EntryContext => ({ path: "/fixture/rollout.jsonl", state: { model: "fixture-model" }, freshFile: true, machineId: "test" });
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
function line(total?: unknown, last?: unknown): string {
  return JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", type: "event_msg", payload: {
    type: "token_count", info: { total_token_usage: total, last_token_usage: last },
    rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1800000000 } },
  } });
}
const parse = (c: EntryContext, total?: unknown, last?: unknown) => codexProvider.parseLine(line(total, last), c);
afterEach(() => setTableForTests(null));

describe("Codex cumulative accounting", () => {
  it("normalizes inclusive input and prices cache only once", () => {
    setTableForTests({ "fixture-model": { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, cacheWritePerMtok: 0 } });
    const [event] = parse(ctx(), usage(1000, 800, 100), usage(1000, 800, 100));
    expect(event).toMatchObject({ inputTokens: 200, cacheReadTokens: 800, outputTokens: 100, costSource: "estimated" });
    expect(event!.inputTokens + event!.cacheReadTokens! + event!.outputTokens).toBe(1100);
    expect(event!.costUsd).toBeCloseTo(0.0016, 10);
  });

  it("rejects repeated cumulative snapshots while still emitting quota observations", () => {
    const c = ctx(); const reports: unknown[] = []; c.onQuota = q => reports.push(q);
    expect(parse(c, usage(1000, 800, 100), usage(1000, 800, 100))).toHaveLength(1);
    expect(parse(c, usage(1000, 800, 100), usage(1000, 800, 100))).toEqual([]);
    expect(parse(c, usage(1000, 800, 100))).toEqual([]);
    expect(reports).toHaveLength(3);
  });

  it("advances the baseline on last usage before a totals-only delta", () => {
    const c = ctx();
    expect(parse(c, usage(1000, 800, 100), usage(1000, 800, 100))).toHaveLength(1);
    expect(parse(c, usage(1300, 900, 150))[0]).toMatchObject({ inputTokens: 200, cacheReadTokens: 100, outputTokens: 50 });
  });

  it("supports first totals-only usage and persisted restart", () => {
    const c = ctx();
    expect(parse(c, usage(1000, 800, 100))[0]).toMatchObject({ inputTokens: 200, cacheReadTokens: 800 });
    const restarted = { ...c, freshFile: false, state: JSON.parse(JSON.stringify(c.state)) };
    expect(parse(restarted, usage(1000, 800, 100))).toEqual([]);
    expect(parse(restarted, usage(1200, 900, 120))[0]).toMatchObject({ inputTokens: 100, cacheReadTokens: 100, outputTokens: 20 });
  });

  it("keeps two equal requests when cumulative usage advances or is absent", () => {
    const c = ctx(); const last = usage(100, 80, 10);
    const a = parse(c, last, last)[0]!;
    const b = parse(c, usage(200, 160, 20), last)[0]!;
    expect(b.inputTokens).toBe(a.inputTokens);
    expect(b.id).not.toBe(a.id);
    const noTotals = ctx();
    expect(parse(noTotals, undefined, last)).toHaveLength(1);
    expect(parse(noTotals, undefined, last)).toHaveLength(1);
  });

  it("reanchors resets without billing cumulative totals or negative deltas", () => {
    const c = ctx(); parse(c, usage(1000, 800, 100));
    expect(parse(c, usage(100, 50, 10))).toEqual([]);
    expect(parse(c, usage(200, 100, 20))[0]).toMatchObject({ inputTokens: 50, cacheReadTokens: 50, outputTokens: 10 });
    expect(parse(c, usage(10, 0, 1), usage(10, 0, 1))[0]).toMatchObject({ inputTokens: 10, outputTokens: 1 });
  });

  it("does not recover a last-only interval by charging the entire next total", () => {
    const c = ctx(); parse(c, usage(100, 0, 10));
    expect(parse(c, undefined, usage(100, 0, 10))).toHaveLength(1);
    expect(parse(c, usage(300, 0, 30))).toEqual([]);
    expect(parse(c, usage(400, 0, 40))[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it("rejects malformed counters and constrains overlapping cache", () => {
    expect(parse(ctx(), undefined, usage(-1, 0, 10))).toEqual([]);
    expect(parse(ctx(), undefined, { input_tokens: "100", output_tokens: 10 })).toEqual([]);
    expect(parse(ctx(), usage(100, 200, 10))[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 100 });
  });
});
