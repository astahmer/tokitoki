import { describe, expect, it } from "bun:test";
import { mkdtempSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanProvider, scanProviderCore } from "../src/scan.ts";
import { eventsFile, loadCursors } from "../src/store.ts";
import { walkJsonl } from "../src/providers/claude-code.ts";
import type { UsageEvent } from "../src/types.ts";
import type { EntryContext, Provider } from "../src/providers/types.ts";

const MACHINE = "scan-test-mac";

function assistantLine(id: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        model: "m1",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      requestId: `req_${id}`,
      uuid: `u_${id}`,
      timestamp: "2026-08-23T09:00:00.000Z",
      sessionId: "sess",
    }) + "\n"
  );
}

function fakeProvider(root: string): Provider {
  return {
    id: "fake",
    label: "fake",
    discoverRoots(): string[] {
      return [root];
    },
    listFiles(r: string): string[] {
      return walkJsonl(r);
    },
    parseLine(line: string, ctxArg: EntryContext): UsageEvent[] {
      return claudeCodeLikeParse(line, ctxArg);
    },
  };
}

// Minimal clone of the claude-code parser so the test is self-contained
function claudeCodeLikeParse(line: string, ctxArg: EntryContext): UsageEvent[] {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (entry.type !== "assistant") return [];
  const message = entry.message as { id?: string; model?: string; usage?: Record<string, number> } | undefined;
  const usage = (message?.usage ?? {}) as Record<string, number>;
  if ((usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0) return [];
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : "unknown";
  return [
    {
      id: `fake:default:${sessionId}:${message?.id ?? entry.uuid}`,
      ts: String(entry.timestamp),
      machineId: ctxArg.machineId,
      provider: "fake",
      accountKey: "default",
      model: String((entry.message as { model?: string }).model),
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      costUsd: 0,
      sessionId,
    },
  ];
}

function setup(): { sessions: string } {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "tk-scan-ws-"));
  const sessions = path.join(workspace, "sessions");
  mkdirSync(sessions);
  process.env.TOKITOKI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "tk-scan-data-"));
  return { sessions };
}

describe("scanProvider", () => {
  it("scans incrementally without duplicating events", () => {
    const env = setup();
    try {
      const file = path.join(env.sessions, "s.jsonl");
      writeFileSync(file, assistantLine("msg_1"));
      const p = fakeProvider(env.sessions);

      expect(scanProvider(p, MACHINE).eventsEmitted).toBe(1);
      // Rescan with no new data → nothing new
      expect(scanProvider(p, MACHINE).eventsEmitted).toBe(0);
      // Append another entry
      appendFileSync(file, assistantLine("msg_2"));
      expect(scanProvider(p, MACHINE).eventsEmitted).toBe(1);

      const log = readFileSync(eventsFile(), "utf8").trim().split("\n");
      expect(log).toHaveLength(2);
      const ids = log.map((l) => (JSON.parse(l) as UsageEvent).id);
      expect(new Set(ids).size).toBe(2);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("buffers partial trailing lines until complete", () => {
    const env = setup();
    try {
      const file = path.join(env.sessions, "s.jsonl");
      const full = assistantLine("msg_p");
      const cut = full.slice(0, Math.floor(full.length / 2));
      writeFileSync(file, cut);

      const p = fakeProvider(env.sessions);
      expect(scanProvider(p, MACHINE).eventsEmitted).toBe(0);
      // cursor stays at the start of the incomplete line
      expect(loadCursors()[file]!.offset).toBe(0);

      appendFileSync(file, full.slice(cut.length));
      expect(scanProvider(p, MACHINE).eventsEmitted).toBe(1);
      expect(loadCursors()[file]!.offset).toBe(full.length);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});

describe("cursor shards", () => {
  it("persists a per-provider shard and merges it into loadCursors", () => {
    const env = setup();
    try {
      const file = path.join(env.sessions, "s.jsonl");
      writeFileSync(file, assistantLine("msg_1"));
      const p = fakeProvider(env.sessions);
      scanProvider(p, MACHINE);

      const shard = path.join(process.env.TOKITOKI_DATA_DIR!, "cursors", "fake.json");
      expect(readFileSync(shard, "utf8").length).toBeGreaterThan(0);
      // merged view (legacy + shards) still resolves the cursor
      expect(loadCursors()[file]!.offset).toBe(assistantLine("msg_1").length);

      // incremental resume: append → only the new bytes are consumed
      appendFileSync(file, assistantLine("msg_2"));
      expect(scanProvider(p, MACHINE).eventsEmitted).toBe(1);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("shard saves are restricted to the scanning provider's own files", () => {
    const env = setup();
    try {
      // legacy cursors.json with an entry for another provider's file
      const foreign = path.join(env.sessions, "other.jsonl");
      writeFileSync(
        path.join(process.env.TOKITOKI_DATA_DIR!, "cursors.json"),
        JSON.stringify({ [foreign]: { offset: 123 } }),
      );
      const file = path.join(env.sessions, "s.jsonl");
      writeFileSync(file, assistantLine("msg_1"));
      scanProvider(fakeProvider(env.sessions), MACHINE);

      const shard = JSON.parse(
        readFileSync(path.join(process.env.TOKITOKI_DATA_DIR!, "cursors", "fake.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(shard)).not.toContain(foreign);
      expect(Object.keys(shard)).toContain(file);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("scanProviderCore streams batches through hooks", () => {
    const env = setup();
    try {
      const file = path.join(env.sessions, "s.jsonl");
      writeFileSync(file, assistantLine("msg_1") + assistantLine("msg_2"));
      let batchEvents = 0;
      let savedOffsets: Record<string, { offset: number }> | undefined;
      const result = scanProviderCore(fakeProvider(env.sessions), MACHINE, {
        onEvents: (events) => {
          batchEvents += events.length;
        },
        onSaveCursors: (cursors) => {
          savedOffsets = cursors as Record<string, { offset: number }>;
        },
      });
      expect(result.eventsEmitted).toBe(2);
      expect(batchEvents).toBe(2);
      expect(savedOffsets?.[file]?.offset).toBe((assistantLine("msg_1") + assistantLine("msg_2")).length);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});

describe("oversized lines", () => {
  it("consumes lines larger than the read chunk instead of stalling", () => {
    const env = setup();
    try {
      const file = path.join(env.sessions, "s.jsonl");
      // small line, then a >CHUNK_SIZE monster line, then a normal line
      const filler = " ".repeat(9 * 1024 * 1024);
      writeFileSync(
        file,
        assistantLine("msg_1") +
          JSON.stringify({ type: "assistant", message: { id: "msg_big", model: "m1", usage: { input_tokens: 1, output_tokens: 1 }, filler }, requestId: "req_big", uuid: "u_big", timestamp: "2026-08-23T09:00:01.000Z", sessionId: "sess" }) +
          "\n" +
          assistantLine("msg_2"),
      );
      const p = fakeProvider(env.sessions);
      const res = scanProvider(p, MACHINE);
      expect(res.eventsEmitted).toBe(3);
      expect(loadCursors()[file]!.offset).toBe(fsStatSize(file));
      // no stall → rescan finds nothing
      expect(scanProvider(p, MACHINE).eventsEmitted).toBe(0);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});

function fsStatSize(file: string): number {
  // eslint-disable-next-line -- local helper keeps imports minimal
  return require("node:fs").statSync(file).size as number;
}
