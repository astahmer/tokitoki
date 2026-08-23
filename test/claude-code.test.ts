import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeCodeProvider, walkJsonl } from "../src/providers/claude-code.ts";
import type { EntryContext } from "../src/providers/types.ts";

const MACHINE = "test-mac";

function ctx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    path: "/tmp/fake-session.jsonl",
    state: {},
    freshFile: true,
    machineId: MACHINE,
    ...overrides,
  };
}

const ASSISTANT_LINE = JSON.stringify({
  parentUuid: "p1",
  type: "assistant",
  message: {
    id: "msg_001",
    model: "claude-sonnet-5",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    usage: {
      input_tokens: 100,
      output_tokens: 42,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 1200,
    },
  },
  requestId: "req_001",
  uuid: "u1",
  timestamp: "2026-08-23T10:00:00.000Z",
  cwd: "/Users/me/dev/proj",
  sessionId: "sess-1",
});

describe("claude-code provider", () => {
  it("normalizes an assistant usage line", () => {
    const events = claudeCodeProvider.parseLine(ASSISTANT_LINE, ctx());
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe("claude-code:default:sess-1:msg_001");
    expect(e.machineId).toBe(MACHINE);
    expect(e.provider).toBe("claude-code");
    expect(e!.accountKey).toBe("default");
    expect(e!.model).toBe("claude-sonnet-5");
    expect(e!.inputTokens).toBe(100);
    expect(e!.outputTokens).toBe(42);
    expect(e!.cacheReadTokens).toBe(1200);
    expect(e.cacheWriteTokens).toBe(500);
    expect(e!.projectDir).toBe("/Users/me/dev/proj");
    expect(e!.sessionId).toBe("sess-1");
    // cost estimated (no costUSD on the line) and positive
    expect(e!.costUsd).toBeGreaterThan(0);
  });

  it("prefers reported costUSD over estimation", () => {
    const line = JSON.stringify({ ...JSON.parse(ASSISTANT_LINE), costUSD: 0.25 });
    const e = claudeCodeProvider.parseLine(line, ctx())[0];
    expect(e!.costUsd).toBe(0.25);
  });

  it("skips non-assistant and usage-less lines", () => {
    expect(claudeCodeProvider.parseLine(JSON.stringify({ type: "user" }), ctx())).toHaveLength(0);
    expect(
      claudeCodeProvider.parseLine(
        JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant" } }),
        ctx(),
      ),
    ).toHaveLength(0);
    expect(claudeCodeProvider.parseLine("not json at all", ctx())).toHaveLength(0);
  });

  it("produces identical ids for the same message on another machine", () => {
    const a = claudeCodeProvider.parseLine(ASSISTANT_LINE, ctx({ machineId: "mac-one" }))[0];
    const b = claudeCodeProvider.parseLine(ASSISTANT_LINE, ctx({ machineId: "mac-two" }))[0]!;
    // Same logical event → same dedupe id; machine attribution differs
    expect(a!.id).toBe(b.id);
    expect(a!.machineId).not.toBe(b!.machineId);
  });

  it("walkJsonl finds nested files sorted", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-claude-"));
    writeFileSync(path.join(dir, "b.jsonl"), "{}\n");
    mkdirSync(path.join(dir, "subagents"));
    writeFileSync(path.join(dir, "subagents", "a.jsonl"), "{}\n");
    const files = walkJsonl(dir);
    expect(files).toEqual([path.join(dir, "b.jsonl"), path.join(dir, "subagents", "a.jsonl")]);
  });
});
