import { describe, expect, it } from "bun:test";

import { claudeCodeProvider } from "../src/providers/claude-code.ts";
import { codexProvider } from "../src/providers/codex.ts";
import { piProvider } from "../src/providers/pi.ts";
import { extractCodexToolName, firstCommandWord, formatToolName } from "../src/tools.ts";
import { squarify } from "../web/src/lib/treemap.ts";

function ctx(path = "/tmp/fake.jsonl") {
  return { path, state: {} as Record<string, unknown>, freshFile: true, machineId: "m1" };
}

describe("tool name helpers", () => {
  it("firstCommandWord skips env assignments and flags", () => {
    expect(firstCommandWord("rg -l foo")).toBe("rg");
    expect(firstCommandWord("FOO=bar cargo test --release")).toBe("cargo");
    expect(firstCommandWord("  pnpm -r build ")).toBe("pnpm");
    expect(firstCommandWord(undefined)).toBeUndefined();
    expect(firstCommandWord("   ")).toBeUndefined();
  });

  it("extractCodexToolName parses unified-exec one-liners", () => {
    expect(
      extractCodexToolName("exec", 'const r = await tools.exec_command({"cmd":"rtk sed -n \'1p\' file"});'),
    ).toBe("shell:rtk");
    expect(
      extractCodexToolName("exec", 'const r = await tools.codex_app__read_thread({threadId:"x"});'),
    ).toBe("codex_app__read_thread");
    expect(extractCodexToolName("update_plan", "")).toBe("update_plan");
  });

  it("formatToolName rolls up mcp namespaces", () => {
    expect(formatToolName("mcp__pencil__execute")).toBe("mcp:pencil");
    expect(formatToolName("mcp__deep__nested__tool")).toBe("mcp:deep");
    expect(formatToolName("Edit")).toBe("Edit");
    expect(formatToolName("shell:rg")).toBe("shell:rg");
  });
});

describe("claude-code tool extraction", () => {
  it("attributes the first tool_use block of a usage-bearing message", () => {
    const line = JSON.stringify({
      type: "assistant",
      sessionId: "s1",
      timestamp: "2026-08-23T10:00:00Z",
      cwd: "/repo",
      message: {
        id: "msg_1",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 20 },
        content: [
          { type: "thinking", thinking: "..." },
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a" } },
        ],
      },
    });
    const [event] = claudeCodeProvider.parseLine(line, ctx());
    expect(event?.tool).toBe("Edit");
  });

  it("collapses Bash calls to the command's first word", () => {
    const line = JSON.stringify({
      type: "assistant",
      sessionId: "s1",
      timestamp: "2026-08-23T10:00:00Z",
      message: {
        id: "msg_2",
        model: "m",
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [{ type: "tool_use", name: "Bash", input: { command: "rg -l pattern src" } }],
      },
    });
    const [event] = claudeCodeProvider.parseLine(line, ctx());
    expect(event?.tool).toBe("shell:rg");
  });

  it("leaves plain text turns unattributed", () => {
    const line = JSON.stringify({
      type: "assistant",
      sessionId: "s1",
      message: {
        id: "msg_3",
        model: "m",
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [{ type: "text", text: "done" }],
      },
    });
    const [event] = claudeCodeProvider.parseLine(line, ctx());
    expect(event?.tool).toBeUndefined();
  });
});

describe("codex tool extraction", () => {
  it("inherits the preceding custom_tool_call into the next token_count", () => {
    const c = ctx();
    expect(codexProvider.parseLine(JSON.stringify({
      type: "session_meta",
      payload: { session_id: "sess9", cwd: "/repo", model_provider: "openai" },
    }), c)).toEqual([]);
    expect(codexProvider.parseLine(JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-test" },
    }), c)).toEqual([]);
    expect(codexProvider.parseLine(JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", input: 'await tools.exec_command({"cmd":"cargo build"})' },
    }), c)).toEqual([]);

    const [event] = codexProvider.parseLine(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } },
      },
    }), c);
    expect(event?.tool).toBe("shell:cargo");

    // A following turn with no new tool call stays unattributed (cleared on use).
    const [next] = codexProvider.parseLine(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
      },
    }), c);
    expect(next?.tool).toBeUndefined();
  });

  it("reads CommandExecution items", () => {
    const c = ctx();
    codexProvider.parseLine(JSON.stringify({
      type: "response_item",
      payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "jj log"] } },
    }), c);
    const [event] = codexProvider.parseLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, output_tokens: 5 } } },
    }), c);
    expect(event?.tool).toBe("shell:jj");
  });
});

describe("pi tool extraction", () => {
  it("attributes toolCall blocks and collapses bash commands", () => {
    const base = {
      type: "message",
      id: "pi-1",
      timestamp: "2026-08-23T10:00:00Z",
      message: {
        role: "assistant",
        model: "gpt-test",
        provider: "opencode",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
      },
    };
    const withCall = {
      ...base,
      message: {
        ...base.message,
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la && cat x" } }],
      },
    };
    const [event] = piProvider.parseLine(JSON.stringify(withCall), ctx());
    expect(event?.tool).toBe("shell:ls");

    const withRead = {
      ...base,
      id: "pi-2",
      message: {
        ...base.message,
        content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "/x" } }],
      },
    };
    const [event2] = piProvider.parseLine(JSON.stringify(withRead), ctx());
    expect(event2?.tool).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// squarify layout math

describe("squarify", () => {
  it("covers the full area exactly once", () => {
    const items = [
      { label: "a", value: 500 },
      { label: "b", value: 300 },
      { label: "c", value: 150 },
      { label: "d", value: 50 },
    ];
    const placed = squarify(items, 10, 6);
    expect(placed.length).toBe(4);
    const totalArea = placed.reduce((s: number, p) => s + p.w * p.h, 0);
    expect(totalArea).toBeCloseTo(60, 5);
    // No overlaps: every rect within bounds
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x + p.w).toBeLessThanOrEqual(10 + 1e-9);
      expect(p.y + p.h).toBeLessThanOrEqual(6 + 1e-9);
    }
  });

  it("areas are proportional to values", () => {
    const items = [
      { label: "big", value: 900 },
      { label: "small", value: 100 },
    ];
    const placed = squarify(items, 10, 10);
    const byLabel = new Map(placed.map((p) => [p.item.label, p]));
    const big = byLabel.get("big")!;
    const small = byLabel.get("small")!;
    expect((big.w * big.h) / (small.w * small.h)).toBeCloseTo(9, 3);
  });

  it("handles empty and single-item inputs", () => {
    expect(squarify([], 10, 10)).toEqual([]);
    const single = squarify([{ label: "only", value: 7 }], 10, 10);
    expect(single.length).toBe(1);
    expect(single[0]!.w * single[0]!.h).toBeCloseTo(100, 5);
  });
});
