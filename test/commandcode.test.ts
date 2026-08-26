import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandcodeProvider } from "../src/providers/commandcode.ts";
import type { EntryContext } from "../src/providers/types.ts";

const MACHINE = "test-mac";

function ctx(state: Record<string, unknown> = {}): EntryContext {
  return { path: "/tmp/cc-session.jsonl", state, freshFile: true, machineId: MACHINE };
}

const SESSION_LINE = JSON.stringify({
  type: "session",
  version: 3,
  id: "cc-1234",
  timestamp: "2026-08-26T09:00:00.000Z",
  cwd: "/Users/me/dev/fruit",
});
const MODEL_LINE = JSON.stringify({
  type: "model_change",
  id: "mc1",
  parentId: "cc-1234",
  timestamp: "2026-08-26T09:00:01.000Z",
  model: "claude-opus-4-8",
});
// usage rides on the ENTRY (command-code shape), not inside message.
const USAGE_LINE = JSON.stringify({
  type: "message",
  id: "m1",
  parentId: "cc-1234",
  timestamp: "2026-08-26T09:00:05.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  usage: {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 5000,
    cacheWriteTokens: 100,
    costUsd: 0.05,
  },
  model: "claude-opus-4-8",
});
const USER_LINE = JSON.stringify({
  type: "message",
  id: "m0",
  parentId: "cc-1234",
  timestamp: "2026-08-26T09:00:02.000Z",
  message: { role: "user", content: [{ type: "text", text: "fix the jj rebase" }] },
});
// tool_use block → tool attribution
const TOOL_LINE = JSON.stringify({
  type: "message",
  id: "m2",
  parentId: "cc-1234",
  timestamp: "2026-08-26T09:00:10.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "tool_use", name: "shell_command", input: { command: "rg foo" } },
    ],
  },
  usage: { inputTokens: 50, outputTokens: 10 },
  model: "claude-opus-4-8",
});

let rootDir: string;

beforeAll(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-commandcode-"));
  fs.mkdirSync(path.join(rootDir, "sessions"));
  fs.writeFileSync(
    path.join(rootDir, "sessions", "cc-1234.jsonl"),
    [SESSION_LINE, MODEL_LINE, USER_LINE, USAGE_LINE, TOOL_LINE].join("\n") + "\n",
  );
});

afterAll(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("commandcode provider", () => {
  it("discovers sessions under ~/.commandcode/sessions (env-overridable)", () => {
    const files = commandcodeProvider.listFiles(path.join(rootDir, "sessions"));
    expect(files).toEqual([path.join(rootDir, "sessions", "cc-1234.jsonl")]);
    // homePath default honors HOME
    const prev = process.env.HOME;
    process.env.HOME = rootDir;
    try {
      expect(commandcodeProvider.discoverRoots()).toEqual([path.join(rootDir, ".commandcode/sessions")]);
    } finally {
      process.env.HOME = prev!;
    }
  });

  it("parses entry-level usage with session/model context", () => {
    const state: Record<string, unknown> = {};
    expect(commandcodeProvider.parseLine(SESSION_LINE, ctx(state))).toHaveLength(0);
    expect(commandcodeProvider.parseLine(MODEL_LINE, ctx(state))).toHaveLength(0);

    const events = commandcodeProvider.parseLine(USAGE_LINE, ctx(state));
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe("commandcode:default:cc-1234:m1");
    expect(e.provider).toBe("commandcode");
    expect(e.accountKey).toBe("default");
    expect(e.model).toBe("claude-opus-4-8");
    expect(e.inputTokens).toBe(1200);
    expect(e.outputTokens).toBe(300);
    expect(e.cacheReadTokens).toBe(5000);
    expect(e.cacheWriteTokens).toBe(100);
    expect(e.costUsd).toBe(0.05); // reported wins over estimate
    expect(e.projectDir).toBe("/Users/me/dev/fruit");
    expect(e.sessionId).toBe("cc-1234");
    expect(new Date(e.ts).toISOString()).toBe("2026-08-26T09:00:05.000Z");
  });

  it("attributes tools from assistant content blocks", () => {
    const state: Record<string, unknown> = {};
    commandcodeProvider.parseLine(SESSION_LINE, ctx(state));
    const events = commandcodeProvider.parseLine(TOOL_LINE, ctx(state));
    expect(events).toHaveLength(1);
    expect(events[0]!.tool).toBe("shell:rg");
  });

  it("falls back to estimateCost when the transcript carries no costUsd", () => {
    const noCost = JSON.parse(USAGE_LINE) as Record<string, unknown>;
    delete (noCost.usage as Record<string, unknown>).costUsd;
    const state: Record<string, unknown> = {};
    commandcodeProvider.parseLine(SESSION_LINE, ctx(state));
    const events = commandcodeProvider.parseLine(JSON.stringify(noCost), ctx(state));
    expect(events).toHaveLength(1);
    expect((events[0]!.costUsd ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it("skips user messages and zero-usage entries", () => {
    const state: Record<string, unknown> = {};
    commandcodeProvider.parseLine(SESSION_LINE, ctx(state));
    expect(commandcodeProvider.parseLine(USER_LINE, ctx(state))).toHaveLength(0);
    const zero = JSON.parse(USAGE_LINE) as Record<string, unknown>;
    (zero.usage as Record<string, unknown>) = {};
    expect(commandcodeProvider.parseLine(JSON.stringify(zero), ctx(state))).toHaveLength(0);
  });

  it("extracts searchable session docs", () => {
    const file = path.join(rootDir, "sessions", "cc-1234.jsonl");
    const docs = commandcodeProvider.extractSessionDocs!(file);
    expect(docs).toHaveLength(1);
    const d = docs[0]!;
    expect(d.sessionId).toBe("cc-1234");
    expect(d.startedAt).toBe("2026-08-26T09:00:00.000Z");
    expect(d.title).toContain("fix the jj rebase");
    expect(d.body).toContain("fix the jj rebase");
  });

  it("is registered in the provider registry", async () => {
    const { PROVIDERS } = await import("../src/providers/index.ts");
    expect(PROVIDERS.some((p) => p.id === "commandcode")).toBe(true);
  });
});
