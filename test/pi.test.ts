import { describe, expect, it } from "bun:test";

import { piProvider } from "../src/providers/pi.ts";
import type { EntryContext } from "../src/providers/types.ts";

const MACHINE = "test-mac";

function ctx(): EntryContext {
  return { path: "/tmp/pi-session.jsonl", state: {}, freshFile: true, machineId: MACHINE };
}

const SESSION_LINE = JSON.stringify({
  type: "session",
  version: 3,
  id: "01a02aa4-d3cd",
  timestamp: "2026-08-22T18:04:00.333Z",
  cwd: "/Users/me/dev/nixfiles",
});
const MODEL_LINE = JSON.stringify({
  type: "model_change",
  id: "d28b9c8a",
  timestamp: "2026-08-22T18:04:01.120Z",
  provider: "opencode-go",
  modelId: "ox-alpha-free",
});
const USAGE_LINE = JSON.stringify({
  type: "message",
  id: "c72c5875",
  timestamp: "2026-08-22T18:04:17.141Z",
  message: {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "opencode-go",
    model: "ox-alpha-free",
    usage: {
      input: 14425,
      output: 56,
      cacheRead: 704,
      cacheWrite: 0,
      totalTokens: 15185,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
});

describe("pi provider", () => {
  it("uses session header + model_change as context for usage lines", () => {
    const state = ctx().state;
    const s = { path: "/tmp/s.jsonl", state, freshFile: true, machineId: MACHINE };
    expect(piProvider.parseLine(SESSION_LINE, s)).toHaveLength(0);
    expect(piProvider.parseLine(MODEL_LINE, s)).toHaveLength(0);
    const events = piProvider.parseLine(USAGE_LINE, s);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe("pi:opencode-go:01a02aa4-d3cd:c72c5875");
    expect(e!.model).toBe("ox-alpha-free");
    expect(e!.accountKey).toBe("opencode-go");
    expect(e!.inputTokens).toBe(14425);
    expect(e!.outputTokens).toBe(56);
    expect(e!.cacheReadTokens).toBe(704);
    expect(e!.projectDir).toBe("/Users/me/dev/nixfiles");
    // pi reported a cost of 0 (free model) — must be kept, not re-estimated
    expect(e!.costUsd).toBe(0);
  });

  it("falls back to state-tracked model when the message omits it", () => {
    const line = JSON.parse(USAGE_LINE);
    delete line.message.model;
    delete line.message.provider;
    const events = piProvider.parseLine(JSON.stringify(line), ctx());
    expect(events[0]!.model).toBe("unknown"); // no prior state in fresh ctx
  });

  it("skips user messages and tool results without usage", () => {
    expect(
      piProvider.parseLine(
        JSON.stringify({ type: "message", id: "x", message: { role: "user", content: [] } }),
        ctx(),
      ),
    ).toHaveLength(0);
    expect(piProvider.parseLine("garbage {{{", ctx())).toHaveLength(0);
  });
});
