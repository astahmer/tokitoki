import { describe, expect, it } from "bun:test";

import { codexProvider } from "../src/providers/codex.ts";
import { planCodexReplay, type CodexReplayPlan, type CodexReplaySource } from "../src/providers/codex-replay.ts";
import type { EntryContext } from "../src/providers/types.ts";

// Synthetic stock rust-v0.146.0 shapes; no local rollouts/accounts are read.
const record = (type: string, payload: unknown, timestamp = "2026-10-01T00:00:00Z") =>
  JSON.stringify({ timestamp, type, payload });
const meta = (id: string, extra: Record<string, unknown> = {}) => record("session_meta", {
  id, session_id: id, cwd: `/fixture/${id}`, model_provider: "openai", ...extra,
});
const turn = (turnId: string) => record("turn_context", { turn_id: turnId, model: "fixture-model" });
const usage = (total: number, last: number | null = 100) => record("event_msg", {
  type: "token_count",
  info: {
    total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: total / 10 },
    ...(last === null ? {} : { last_token_usage: { input_tokens: last, output_tokens: last / 10 } }),
  },
  rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1800000000 } },
});
const source = (id: string, lines: string[], scope = "/fixture/home"): CodexReplaySource => ({
  path: `/fixture/home/sessions/rollout-${id}.jsonl`, scope, lines,
});
const rewritten = (line: string) => JSON.stringify({ ...JSON.parse(line), timestamp: "2026-10-02T00:00:00Z", ordinal: 100 });
const parentLines = [meta("parent"), turn("parent-turn"), usage(100)];
const childLines = [meta("child", { forked_from_id: "parent" }), ...parentLines.map(rewritten),
  turn("child-turn"), usage(200)];
const parent = source("parent", parentLines);
const child = source("child", childLines);
const plan = () => planCodexReplay({ child, parent });
const context = (s: CodexReplaySource, replay?: CodexReplayPlan): EntryContext => ({
  path: s.path, state: { ...(replay ? { codexReplayPlan: replay } : {}) }, freshFile: true, machineId: "fixture",
});
const parse = (c: EntryContext, lines: Iterable<string>) => Array.from(lines).flatMap(line => codexProvider.parseLine(line, c));

describe("Codex lineage replay", () => {
  it("counts a parent and its rewritten copied prefix once, retaining equal new child usage", () => {
    const replay = plan();
    expect(replay).toMatchObject({ childThreadId: "child", parentThreadId: "parent", fromLine: 2, throughLine: 3 });
    const c = context(child, replay);
    const events = [...parse(context(parent), parent.lines), ...parse(c, child.lines)];
    expect(events).toHaveLength(2);
    expect(events.map(e => e.inputTokens)).toEqual([100, 100]);
    expect(events[0]!.id).not.toBe(events[1]!.id);
    expect(events[1]).toMatchObject({ sessionId: "child", projectDir: "/fixture/child" });
    expect(c.state.codexThreadId).toBe("child");
    expect(c.state.codexForkedFromId).toBe("parent");
  });

  it("reports proven legacy replay IDs after quota and baseline advancement", () => {
    const c = context(child, plan());
    const order: string[] = [];
    c.onQuota = () => order.push("quota");
    c.onReplayedUsage = id => {
      order.push(id);
      expect(c.state.codexCumulativeUsage).toMatchObject({ input_tokens: 100 });
    };
    parse(c, child.lines);
    expect(order).toEqual(["quota", "codex:openai:parent:line-3", "quota"]);
  });

  it("persists replay cutoff and cumulative baseline across mid-prefix and post-prefix restart", () => {
    const c = context(child, plan());
    expect(parse(c, childLines.slice(0, 3))).toEqual([]);
    const resumed = { ...c, state: JSON.parse(JSON.stringify(c.state)), freshFile: false };
    expect(parse(resumed, childLines.slice(3, 4))).toEqual([]);
    const resumedAgain = { ...resumed, state: JSON.parse(JSON.stringify(resumed.state)), freshFile: false };
    const events = parse(resumedAgain, [turn("child-turn"), usage(200, null)]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inputTokens: 100, outputTokens: 10, id: "codex:openai:parent:line-5" });
  });

  it("preserves historical session_id primary IDs while using id for lineage", () => {
    const lines = [meta("child", { session_id: "root", forked_from_id: "parent" }), ...parentLines,
      turn("new-turn"), usage(200)];
    const s = source("child", lines);
    const c = context(s, planCodexReplay({ child: s, parent }));
    const events = parse(c, lines);
    expect(c.state.codexThreadId).toBe("child");
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("codex:openai:parent:line-5");
    expect(events[0]!.sessionId).toBe("root");
  });

  it("retains the historical filename fallback when old stock metadata has only id", () => {
    const c = context(child);
    parse(c, [record("session_meta", { id: "actual-thread", model_provider: "openai" })]);
    const [event] = parse(c, [usage(100)]);
    expect(c.state.codexThreadId).toBe("actual-thread");
    expect(event!.id).toBe("codex:openai:child:line-1");
  });

  it("does not merge unrelated sessions with identical counters or turn IDs", () => {
    const unrelated = source("unrelated", [meta("unrelated"), turn("parent-turn"), usage(100)]);
    expect(planCodexReplay({ child: unrelated, parent })).toBeUndefined();
    const events = [...parse(context(parent), parent.lines), ...parse(context(unrelated), unrelated.lines)];
    expect(events).toHaveLength(2);
    expect(events[0]!.id).not.toBe(events[1]!.id);
  });

  it("requires explicit matching lineage, selected parent, scope and distinct paths", () => {
    expect(planCodexReplay({ child, parent: source("wrong", [meta("wrong"), ...parentLines.slice(1)]) })).toBeUndefined();
    expect(planCodexReplay({ child, parent: { ...parent, scope: "/different-account" } })).toBeUndefined();
    expect(planCodexReplay({ child, parent: { ...parent, path: child.path } })).toBeUndefined();
    const c = context(child); // Missing parent => scanner provides no plan.
    expect(parse(c, child.lines)).toHaveLength(2);
    const genericParent = source("child", [meta("child", { parent_thread_id: "parent" }), ...parentLines]);
    expect(planCodexReplay({ child: genericParent, parent })).toBeUndefined();
  });

  it("recognizes explicit thread_spawn lineage but not a generic parent relationship", () => {
    const spawned = source("child", [meta("child", {
      source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
    }), ...parentLines]);
    expect(planCodexReplay({ child: spawned, parent })).toBeDefined();
  });

  it("does not use equal counts as identity without an explicit copied turn ID", () => {
    const p = source("parent", [meta("parent"), record("turn_context", { model: "fixture-model" }), usage(100)]);
    const s = source("child", [meta("child", { forked_from_id: "parent" }), ...p.lines]);
    expect(planCodexReplay({ child: s, parent: p })).toBeUndefined();
    expect(parse(context(s), s.lines)).toHaveLength(1);
  });

  it("stops at divergence and never searches ahead for later equal snapshots", () => {
    const p = source("parent", [...parentLines, turn("parent-next"), usage(200)]);
    const s = source("child", [...childLines, usage(300)]);
    const replay = planCodexReplay({ child: s, parent: p });
    expect(replay!.throughLine).toBe(3);
    expect(parse(context(s, replay), s.lines)).toHaveLength(2);
  });

  it("requires full item equality, not just a matching turn ID or token totals", () => {
    const s = source("child", [childLines[0]!, parentLines[0]!, turn("parent-turn"),
      record("response_item", { type: "message", id: "different-response", role: "assistant", content: [] }), usage(100)]);
    expect(planCodexReplay({ child: s, parent })!.throughLine).toBe(2);
    expect(parse(context(s, planCodexReplay({ child: s, parent })), s.lines)).toHaveLength(1);
  });

  it("preserves quota-only observations and repeated snapshots inside a verified prefix", () => {
    const quotaOnly = record("event_msg", { type: "token_count", info: null,
      rate_limits: { primary: { used_percent: 15, window_minutes: 300 } } });
    const p = source("parent", [...parentLines, quotaOnly, usage(100)]);
    const s = source("child", [childLines[0]!, ...p.lines, turn("own"), usage(200)]);
    const c = context(s, planCodexReplay({ child: s, parent: p }));
    const quotas: unknown[] = []; c.onQuota = q => quotas.push(q);
    expect(parse(c, s.lines)).toHaveLength(1);
    expect(quotas).toHaveLength(4);
  });

  it("permits a selected archived parent but rejects plans for another child/path", () => {
    const archived = { ...parent, path: "/fixture/home/archived_sessions/rollout-parent.jsonl" };
    const replay = planCodexReplay({ child, parent: archived });
    expect(replay).toBeDefined();
    expect(parse(context(child, { ...replay!, childPath: "/another/path" }), child.lines)).toHaveLength(2);
    expect(parse(context(child, { ...replay!, childThreadId: "another-child" }), child.lines)).toHaveLength(2);
  });

  it("ignores JSON object key order but stops at malformed prefix records", () => {
    const s = source("child", [childLines[0]!, parentLines[0]!,
      record("turn_context", { model: "fixture-model", turn_id: "parent-turn" }), usage(100)]);
    expect(planCodexReplay({ child: s, parent })!.throughLine).toBe(3);
    const malformed = { ...s, lines: [childLines[0]!, parentLines[0]!, "not json", turn("parent-turn"), usage(100)] };
    expect(planCodexReplay({ child: malformed, parent })).toBeUndefined();
  });

  it("closes both streaming readers on divergence and metadata rejection", () => {
    for (const invalidMetadata of [false, true]) {
      const closed: string[] = [];
      function* lines(id: string, content: Iterable<string>) {
        try { yield* content; } finally { closed.push(id); }
      }
      const p = { ...parent, lines: lines("parent", [...parentLines, turn("parent-next"), usage(200)]) };
      const s = { ...child, lines: lines("child", invalidMetadata
        ? [meta("unrelated"), ...childLines.slice(1)] : childLines) };
      planCodexReplay({ child: s, parent: p });
      expect(closed.sort()).toEqual(["child", "parent"]);
    }
  });

  it("extends a partial copied prefix only after a newly verified plan", () => {
    const p = source("parent", [...parentLines, usage(200)]);
    const partial = source("child", [childLines[0]!, ...parentLines]);
    const c = context(partial, planCodexReplay({ child: partial, parent: p }));
    expect(parse(c, partial.lines)).toEqual([]);
    const complete = source("child", [...partial.lines, rewritten(usage(200)), turn("own"), usage(300)]);
    const resumed = { ...c, state: JSON.parse(JSON.stringify(c.state)), freshFile: false };
    resumed.state.codexReplayPlan = planCodexReplay({ child: complete, parent: p });
    expect(parse(resumed, Array.from(complete.lines).slice(4))).toHaveLength(1);
  });

  it("matches histories that omit the copied parent metadata", () => {
    const s = source("child", [childLines[0]!, ...parentLines.slice(1).map(rewritten), turn("own"), usage(200)]);
    const replay = planCodexReplay({ child: s, parent });
    expect(replay).toMatchObject({ fromLine: 1, throughLine: 2 });
    expect(parse(context(s, replay), s.lines)).toHaveLength(1);
  });
});
