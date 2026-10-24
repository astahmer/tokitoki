import { describe, expect, it } from "bun:test";

import { codexProvider, parseCodexQuotaSnapshot } from "../src/providers/codex.ts";
import { isValidUsageEvent } from "../src/types.ts";
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
  const window = { used_percent: 12, window_minutes: 300, resets_at: 1788160164 };
  const quotaMessage = (rateLimits: unknown, usage: unknown = { input_tokens: 10, output_tokens: 5 }): string =>
    JSON.stringify({
      timestamp: "2026-07-29T10:38:27.434Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: usage }, rate_limits: rateLimits },
    });

  it("keeps same-plan logins distinct only when the source carries their account IDs", () => {
    const quotas = ["account-a", "account-b"].map((accountId) => {
      const c = ctx();
      const meta = JSON.parse(META);
      meta.payload.account_id = accountId;
      codexProvider.parseLine(JSON.stringify(meta), c);
      const [event] = codexProvider.parseLine(quotaMessage({ plan_type: "plus", primary: window }), c);
      expect(event?.accountKey).toBe("openai:plus");
      expect(isValidUsageEvent(event)).toBe(true);
      return event?.quota?.accountId;
    });
    expect(quotas).toEqual(["account-a", "account-b"]);

    const c = ctx();
    codexProvider.parseLine(META, c);
    const [unbound] = codexProvider.parseLine(quotaMessage({ plan_type: "plus", primary: window }), c);
    expect(unbound?.quota?.accountId).toBeUndefined();
  });

  it("keeps same-duration meter IDs and names separate from account identity", () => {
    const c = ctx();
    codexProvider.parseLine(META, c);
    for (const limitId of ["codex", "reviews"]) {
      const [event] = codexProvider.parseLine(quotaMessage({
        account_id: "account-a", limit_id: limitId, limit_name: `Meter ${limitId}`, primary: window,
      }), c);
      expect(event?.accountKey).toBe("openai");
      expect(event?.quota?.accountId).toBe("account-a");
      expect(event?.quota?.limitId).toBe(limitId);
      expect(event?.quota?.limitName).toBe(`Meter ${limitId}`);
      expect(event?.quota?.primary).toMatchObject({
        bucketId: limitId, windowId: "primary", windowMinutes: 300,
        label: `Meter ${limitId}`, observedAt: "2026-07-29T10:38:27.434Z",
      });
    }
  });

  it("preserves historical meter-fallback usage IDs on replay", () => {
    for (const planType of [undefined, null, "plus"]) {
      const c = ctx();
      codexProvider.parseLine(META, c);
      const [event] = codexProvider.parseLine(quotaMessage({
        limit_id: "review-meter", plan_type: planType, primary: window,
      }), c);
      const legacyAccount = planType === "plus" ? "openai:plus" : "review-meter";
      expect(event?.id).toBe(`codex:${legacyAccount}:019fad72-6b4e:line-1`);
      expect(event?.accountKey).toBe(planType === "plus" ? "openai:plus" : "openai");
    }
  });

  it("records complete null-secondary topology and explicit empty replacements", () => {
    const [event] = codexProvider.parseLine(quotaMessage({
      limit_id: "codex", primary: window, secondary: null,
    }), ctx());
    expect(event?.quota?.complete).toBe(true);
    expect(event?.quota?.secondary).toBeUndefined();
    const roundTripped = JSON.parse(JSON.stringify(event));
    expect(roundTripped.quota.complete).toBe(true);
    expect(parseCodexQuotaSnapshot({ rateLimits: { primary: null, secondary: null } })?.complete).toBe(true);
    expect(parseCodexQuotaSnapshot({ rateLimits: { primary: window } })?.complete).toBe(false);
  });

  it("rejects known invalid durations and keeps absent metadata unknown", () => {
    for (const duration of [0, -1, NaN, Infinity, -Infinity]) {
      expect(parseCodexQuotaSnapshot({ rateLimits: {
        primary: { ...window, window_minutes: duration },
      } })).toBeUndefined();
    }
    for (const duration of [undefined, null]) {
      const quota = parseCodexQuotaSnapshot({ rateLimits: {
        primary: { used_percent: 12, window_minutes: duration },
      } });
      expect(quota?.primary).toMatchObject({ usedPct: 12, windowMinutes: 0, resetsAtEpoch: 0 });
    }
    expect(parseCodexQuotaSnapshot({ rateLimits: {
      primary: { ...window, used_percent: Infinity },
    } })).toBeUndefined();
  });

  it("parses quota-only snapshots independently without phantom usage events", () => {
    for (const usage of [null, {}, { input_tokens: 0, output_tokens: 0 }]) {
      const line = quotaMessage({ primary: window, secondary: null }, usage);
      const c = ctx();
      const reports: unknown[] = [];
      c.onQuota = (report) => reports.push(report);
      expect(codexProvider.parseLine(line, c)).toEqual([]);
      expect(reports).toHaveLength(1);
      expect(parseCodexQuotaSnapshot({ rateLimits: JSON.parse(line).payload.rate_limits })?.primary?.usedPct).toBe(12);
    }
  });

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

  it("preserves banked-credit expiry metadata from Codex rate limits", () => {
    const c = ctx();
    codexProvider.parseLine(META, c);
    codexProvider.parseLine(TURN, c);
    const [event] = codexProvider.parseLine(JSON.stringify({
      timestamp: "2026-07-29T10:38:27.434Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        rate_limits: {
          primary: { used_percent: 1, window_minutes: 300, resets_at: 1788160164 },
          credits: { has_credits: true, unlimited: false, balance: "2", expires_at: 1788160164 },
        },
      },
    }), c);
    expect(event?.quota?.credits).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: "2",
      expiresAt: new Date(1788160164 * 1000).toISOString(),
    });
  });
});
