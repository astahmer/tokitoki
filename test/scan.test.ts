import { describe, expect, it } from "bun:test";
import { mkdtempSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanProvider } from "../src/scan.ts";
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
