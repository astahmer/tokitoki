import { afterEach, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventCache } from "../src/cache.ts";
import { codexProvider } from "../src/providers/codex.ts";
import { scanProviderCore } from "../src/scan.ts";
import { appendEvents, eventsFile, saveProviderCursors } from "../src/store.ts";
import type { UsageEvent } from "../src/types.ts";
import { DirAdapter } from "../src/sync/dir.ts";
import { runSync } from "../src/sync/index.ts";

const previousData = process.env.TOKITOKI_DATA_DIR;
const folders: string[] = [];
afterEach(() => {
  if (previousData === undefined) delete process.env.TOKITOKI_DATA_DIR;
  else process.env.TOKITOKI_DATA_DIR = previousData;
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const entry = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", type, payload });
const meta = (id: string, parent?: string) => entry("session_meta", { id, session_id: id, model_provider: "openai", ...(parent ? { forked_from_id: parent } : {}) });
const turn = (id: string) => entry("turn_context", { turn_id: id, model: "gpt-5" });
const usage = (total: number) => entry("event_msg", { type: "token_count", info: {
  total_token_usage: { input_tokens: total, output_tokens: total / 10, cached_input_tokens: 0 },
  last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0 },
}, rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1800000000 } } });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "tokitoki-fork-scan-"));
  folders.push(dir);
  const sessions = join(dir, "home", "sessions");
  const archived = join(dir, "home", "archived_sessions");
  mkdirSync(sessions, { recursive: true }); mkdirSync(archived, { recursive: true });
  const data = join(dir, "data"); mkdirSync(data);
  process.env.TOKITOKI_DATA_DIR = data;
  const provider = { ...codexProvider, discoverRoots: () => [sessions, archived] };
  const cache = new EventCache(join(data, "cache.db"));
  let quotas = 0;
  const scan = () => scanProviderCore(provider, "fixture", {
    onEvents: events => { appendEvents(events); cache.restoreReplayedUsage(events.map(event => event.id)); cache.insert(events); },
    onQuotas: reports => { quotas += reports.length; cache.insertQuotaObservations(reports); },
    onReplayedUsage: ids => cache.excludeReplayedUsage(ids),
    onSaveCursors: cursors => saveProviderCursors("codex", cursors),
  });
  const write = (file: string, lines: string[]) => writeFileSync(file, lines.join("\n") + "\n");
  return { dir, sessions, archived, cache, scan, write, quotas: () => quotas };
};

it("deduplicates archived-parent fork history and retires old copied IDs without deleting history", async () => {
  const f = setup();
  try {
    const parent = [meta("parent"), turn("parent-turn"), usage(100)];
    const child = [meta("child", "parent"), ...parent, turn("child-turn"), usage(200)];
    const p = join(f.archived, "rollout-parent.jsonl"), c = join(f.sessions, "rollout-child.jsonl");
    f.write(p, parent); f.write(c, child);
    // Fixed output of the pre-fork parser: copied headers changed the legacy
    // namespace to the parent even for the child's new turn.
    const legacy: UsageEvent[] = [2, 3, 5].map(line => ({
      id: `codex:openai:parent:line-${line}`, ts: "2026-10-01T00:00:00Z", provider: "codex",
      accountKey: "openai", machineId: "fixture", sessionId: "parent", model: "gpt-5", inputTokens: 100, outputTokens: 10,
    }));
    appendEvents(legacy); f.cache.insert(legacy);
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(3);
    f.scan();
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(2);
    expect(f.cache.hybridUsage("2026-10-01T00:00:00Z").requests).toBe(2);
    expect(f.cache.count()).toBe(3);
    expect(f.cache.sessionEventCount("codex", "child")).toBe(1);
    expect(f.cache.sessionDetail("codex", "child")).toHaveLength(1);
    expect(f.quotas()).toBe(3);
    f.cache.rebuild([]);
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(2);
    expect(f.cache.count()).toBe(3);
    expect(f.scan().eventsEmitted).toBe(0);
    appendFileSync(c, [turn("new-child-turn"), usage(300)].join("\n") + "\n");
    f.scan();
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(3);
    expect(readFileSync(eventsFile(), "utf8")).toContain("codex:openai:parent:line-3");
    const replica = new EventCache(join(f.dir, "replica.db"));
    try {
      replica.sync([eventsFile()]);
      expect(replica.totals("2026-10-01T00:00:00Z").requests).toBe(3);
      expect(f.scan().eventsEmitted).toBe(0);
      expect(replica.totals("2026-10-01T00:00:00Z").requests).toBe(3);
    } finally { replica.close(); }
    const shared = join(f.dir, "shared");
    const sender = new DirAdapter("sender", shared);
    await sender.push(readFileSync(eventsFile(), "utf8").trim().split("\n"));
    const otherData = join(f.dir, "receiver"); mkdirSync(otherData);
    process.env.TOKITOKI_DATA_DIR = otherData;
    const result = await runSync(new DirAdapter("receiver", shared), "pull");
    expect(result.pulledInvalid).toBe(0);
    const received = new EventCache(join(otherData, "cache.db"));
    try { expect(received.totals("2026-10-01T00:00:00Z").requests).toBe(3); }
    finally { received.close(); }
  } finally { f.cache.close(); }
});

it("verifies copied prefixes again when the child grows, retaining new identical-sized requests", () => {
  const f = setup();
  try {
    const parent = [meta("parent"), turn("parent-1"), usage(100), turn("parent-2"), usage(200)];
    f.write(join(f.sessions, "rollout-parent.jsonl"), parent);
    const child = join(f.sessions, "rollout-child.jsonl");
    f.write(child, [meta("child", "parent"), ...parent.slice(0, 3)]);
    f.scan();
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(2);
    appendFileSync(child, parent.slice(3).join("\n") + "\n"); f.scan();
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(2);
    appendFileSync(child, [turn("child-new"), usage(300)].join("\n") + "\n"); f.scan();
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(3);
  } finally { f.cache.close(); }
});

it("retains independent requests when a parent is absent or lineage contains a cycle", () => {
  const f = setup();
  try {
    f.write(join(f.sessions, "rollout-a.jsonl"), [meta("a", "b"), turn("same"), usage(100)]);
    f.write(join(f.sessions, "rollout-b.jsonl"), [meta("b", "a"), turn("same"), usage(100)]);
    f.write(join(f.sessions, "rollout-orphan.jsonl"), [meta("orphan", "missing"), turn("same"), usage(100)]);
    f.scan();
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(3);
  } finally { f.cache.close(); }
});

it("retains a restored decision across log rebuilds and stale remote replay controls", () => {
  const f = setup();
  try {
    const row: UsageEvent = { id: "codex:openai:child:line-3", ts: "2026-10-01T00:00:00Z", provider: "codex", accountKey: "openai", model: "gpt-5", machineId: "fixture", sessionId: "child", inputTokens: 10, outputTokens: 2 };
    appendEvents([row]); f.cache.insert([row]);
    f.cache.excludeReplayedUsage([row.id]);
    const stale = readFileSync(eventsFile(), "utf8").trim().split("\n").find(line => JSON.parse(line).type === "usage-replay");
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(0);
    f.cache.restoreReplayedUsage([row.id]);
    appendFileSync(eventsFile(), stale + "\n");
    f.cache.rebuild([]);
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(1);
    const replica = new EventCache(join(f.dir, "restored.db"));
    try { replica.rebuild([]); expect(replica.totals("2026-10-01T00:00:00Z").requests).toBe(1); }
    finally { replica.close(); }
  } finally { f.cache.close(); }
});

it("protects a real parent request when a copied legacy ID collides with it", () => {
  const f = setup();
  try {
    const parent = [meta("parent"), turn("parent-turn"), usage(100), usage(200)];
    f.write(join(f.sessions, "rollout-parent.jsonl"), parent);
    f.write(join(f.sessions, "rollout-child.jsonl"), [meta("child", "parent"), ...parent, turn("child-new"), usage(300)]);
    f.scan();
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(3);
    expect(f.cache.sessionEventCount("codex", "parent")).toBe(2);
    f.cache.rebuild([]);
    expect(f.cache.totals("2026-10-01T00:00:00Z").requests).toBe(3);
    const replica = new EventCache(join(f.dir, "collision.db"));
    try { replica.rebuild([]); expect(replica.totals("2026-10-01T00:00:00Z").requests).toBe(3); }
    finally { replica.close(); }
  } finally { f.cache.close(); }
});
