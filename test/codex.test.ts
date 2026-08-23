import { describe, expect, it } from "bun:test";

import { codexProvider } from "../src/providers/codex.ts";
import type { EntryContext } from "../src/providers/types.ts";

const MACHINE = "test-mac";

function ctx(): EntryContext {
  return { path: "/tmp/rollout-x.jsonl", state: {}, freshFile: true, machineId: MACHINE };
}

function tokenCount(last: Record<string, number>, planType = "plus"): string {
  return JSON.stringify({
    timestamp: "2026-07-29T10:38:27.434Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 999999, cached_input_tokens: 1, output_tokens: 9999 },
        last_token_usage: last,
        model_context_window: 258400,
      },
      rate_limits: { limit_id: "codex", plan_type: planType },
    },
  });
}

const META = JSON.stringify({
  timestamp: "2026-07-29T10:38:11.692Z",
  type: "session_meta",
  payload: {
    session_id: "019fad72-6b4e",
    cwd: "/Users/me/dev/emi-healthfit",
    model_provider: "openai",
  },
});
const TURN = JSON.stringify({
  timestamp: "2026-07-29T10:38:12.000Z",
  type: "turn_context",
  payload: { model: "gpt-5.6-terra" },
});

describe("codex provider", () => {
  it("emits delta usage from last_token_usage, not cumulative totals", () => {
    const c = ctx();
    codexProvider.parseLine(META, c);
    codexProvider.parseLine(TURN, c);
    const events = codexProvider.parseLine(
      tokenCount({ input_tokens: 20244, cached_input_tokens: 11520, output_tokens: 316 }),
      c,
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e!.inputTokens).toBe(20244);
    expect(e!.outputTokens).toBe(316);
    expect(e!.cacheReadTokens).toBe(11520);
    expect(e!.model).toBe("gpt-5.6-terra");
    expect(e!.accountKey).toBe("openai:plus");
    expect(e!.sessionId).toBe("019fad72-6b4e");
    expect(e.id).toMatch(/:line-2$/);
  });

  it("line-index ids stay stable across incremental scans via persisted state", () => {
    // Simulate two scan runs sharing cursor state
    const runA = ctx();
    codexProvider.parseLine(META, runA);
    codexProvider.parseLine(TURN, runA);
    const first = codexProvider.parseLine(tokenCount({ input_tokens: 10, output_tokens: 5 }), runA);

    const resumedState = JSON.parse(JSON.stringify(runA.state));
    const runB: EntryContext = {
      path: runA.path,
      state: resumedState,
      freshFile: false,
      machineId: MACHINE,
    };
    const second = codexProvider.parseLine(tokenCount({ input_tokens: 20, output_tokens: 8 }), runB);

    expect(first[0]!.id).not.toBe(second[0]!.id);
    expect(second[0]!.id).toBe("codex:openai:plus:019fad72-6b4e:line-3");
  });

  it("ignores unknown event types", () => {
    expect(
      codexProvider.parseLine(
        JSON.stringify({ type: "event_msg", payload: { type: "agent_reasoning" } }),
        ctx(),
      ),
    ).toHaveLength(0);
  });
});
