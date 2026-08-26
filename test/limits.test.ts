import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { EventCache } from "../src/cache.ts";
import type { UsageEvent } from "../src/types.ts";
import {
  computeLimits,
  groupBySharedCredential,
  nextLocalMidnight,
  nextMonthStart,
  nextWeekStart,
} from "../src/limits.ts";
import { isVisibleOn, parseToggleTarget, setSurfaceVisibility } from "../src/uiToggles.ts";

function makeEvent(overrides: Partial<UsageEvent> & Pick<UsageEvent, "id">): UsageEvent {
  return {
    ts: "2026-08-23T09:00:00.000Z",
    machineId: "mac-one",
    provider: "codex",
    accountKey: "openai:plus",
    model: "gpt-5.6-luna",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.01,
    ...overrides,
  };
}

// ---------------------------------------------------------------- reset math

describe("shared credential cards", () => {
  it("collapses pi and opencode mirrors into one card", () => {
    const windows = [{ kind: "week", source: "derived" as const, tokens: 10, cost: 1, requests: 1 }];
    const result = groupBySharedCredential([
      { provider: "pi", accountKey: "opencode-go", credential: "sk-a…z", windows },
      { provider: "opencode", accountKey: "opencode-go", credential: "sk-a…z", windows: [{ ...windows[0]!, tokens: 20 }] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.provider).toBe("opencode");
    expect(result[0]?.alsoOn).toEqual(["pi"]);
    expect(result[0]?.windows[0]?.tokens).toBe(30);
  });
});

describe("reset schedule math", () => {
  it("next local midnight is tomorrow 00:00 local", () => {
    const now = new Date(2026, 7, 24, 15, 30); // Aug 24 15:30 local
    const next = nextLocalMidnight(now);
    expect(next.getDate()).toBe(25);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });

  it("next week start is a Monday midnight (Sunday evening → tomorrow)", () => {
    // 2026-08-23 is a Sunday.
    const sunday = new Date(2026, 7, 23, 20, 0);
    const next = nextWeekStart(sunday);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getDate()).toBe(24);
    expect(next.getHours()).toBe(0);

    // Monday itself rolls to the NEXT Monday.
    const mondayNight = new Date(2026, 7, 24, 21, 0);
    const following = nextWeekStart(mondayNight);
    expect(following.getDay()).toBe(1);
    expect(following.getDate()).toBe(31);
  });

  it("next month start is the 1st at midnight", () => {
    const mid = new Date(2026, 7, 24, 12, 0);
    const next = nextMonthStart(mid);
    expect(next.getMonth()).toBe(8); // September
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(0);
  });

  it("crosses DST fall-back without drifting off local midnight", () => {
    // Europe/Paris DST ends 2026-10-25 (03:00→02:00). The night of Oct 24→25
    // is 25h long; the next-midnight after Oct 24 must still read Oct 25 00:00
    // local, and after Oct 25 must read Oct 26 00:00 (a normal 24h day).
    const before = new Date(2026, 9, 24, 12, 0);
    const n1 = nextLocalMidnight(before);
    expect([n1.getDate(), n1.getMonth(), n1.getHours()]).toEqual([25, 9, 0]);
    const n2 = nextLocalMidnight(n1);
    expect([n2.getDate(), n2.getMonth(), n2.getHours()]).toEqual([26, 9, 0]);
    const spanH = (n2.getTime() - n1.getTime()) / 3600_000;
    expect(spanH === 23 || spanH === 24 || spanH === 25).toBe(true); // tz-dependent but always whole hours
    // Week/month boundaries stay at local midnight too.
    expect(nextWeekStart(new Date(2026, 9, 24, 18, 0)).getHours()).toBe(0);
    expect(nextMonthStart(new Date(2026, 9, 24, 18, 0)).getHours()).toBe(0);
  });
});

// ------------------------------------------------------------- limits engine

function limitsCache(): EventCache {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-limits-"));
  return new EventCache(path.join(dir, "cache.db"));
}

describe("computeLimits", () => {
  it("derived windows sum per account and omit usedPct without plan caps", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({ id: "1", ts: "2026-08-24T08:00:00.000Z" }),
        makeEvent({ id: "2", inputTokens: 200, ts: "2026-08-24T08:30:00.000Z" }),
      ]);
      const limits = computeLimits(cache, {}, new Date(2026, 7, 24, 12, 0));
      const codex = limits.find((l) => l.provider === "codex" && l.accountKey === "openai:plus");
      expect(codex).toBeDefined();
      const codexDef = codex!;
      const kinds = codex!.windows.map((w) => w.kind);
      expect(kinds).toEqual(["day", "week", "month"]);
      for (const w of codexDef.windows) {
        expect(w.source).toBe("derived");
        expect(w.usedPct).toBeUndefined(); // no caps configured
        expect(w.resetsAt).toBeDefined();
      }
      const day = codexDef.windows.find((w) => w.kind === "day")!;
      expect(day.tokens).toBeGreaterThan(0);
    } finally {
      cache.close();
    }
  });

  it("prefers embedded quota over derived for the same window kind", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({
          id: "q",
          quota: {
            primary: { usedPct: 42.5, windowMinutes: 10080, resetsAtEpoch: 1788160164 },
            credits: { hasCredits: true, unlimited: false, balance: "2" },
          },
        }),
      ]);
      const limits = computeLimits(cache, {}, new Date(2026, 7, 24, 12, 0));
      const codex = limits.find((l) => l.provider === "codex")!;
      const week = codex.windows.find((w) => w.kind === "week")!;
      expect(week.source).toBe("embedded");
      expect(week.usedPct).toBeCloseTo(42.5);
      expect(week.resetsAt).toBe(new Date(1788160164 * 1000).toISOString());
      // derived day/month still present alongside the embedded week
      expect(codex.windows.filter((w) => w.source === "derived").map((w) => w.kind)).toEqual(["day", "month"]);
      // credits surface as banked resets
      expect(codex.bankedResets).toBe(2);
    } finally {
      cache.close();
    }
  });

  it("uses monthly plan caps as the denominator when configured", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({ id: "1", ts: "2026-08-05T09:00:00.000Z", costUsd: 10 }),
      ]);
      const config = { plans: { "openai:*": { monthlyCostCap: 200 } } };
      const limits = computeLimits(cache, config as never, new Date(2026, 7, 24, 12, 0));
      expect(limits.length).toBeGreaterThan(0);
      const month = limits[0]!.windows.find((w) => w.kind === "month")!;
      expect(month.usedPct).toBeCloseTo(5, 0); // $10 of $200
      // day window carries a pace gauge (>100% = burning hot), not raw share
      const day = limits[0]!.windows.find((w) => w.kind === "day")!;
      expect(day.usedPct).toBeUndefined(); // zero-cost day has no pace signal
    } finally {
      cache.close();
    }
  });

  it("latest snapshot wins per window length", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({ id: "old", ts: "2026-08-20T10:00:00.000Z", quota: { primary: { usedPct: 90, windowMinutes: 10080, resetsAtEpoch: 1 } } }),
        makeEvent({ id: "new", ts: "2026-08-24T10:00:00.000Z", quota: { primary: { usedPct: 5, windowMinutes: 10080, resetsAtEpoch: 1788160164 } } }),
      ]);
      const limits = computeLimits(cache, {}, new Date(2026, 7, 24, 12, 0));
      const week = limits[0]!.windows.find((w) => w.kind === "week")!;
      expect(week.usedPct).toBeCloseTo(5);
    } finally {
      cache.close();
    }
  });
});

// ------------------------------------------------------------------ toggles

describe("ui toggles", () => {
  it("parses provider and provider:account targets", () => {
    expect(parseToggleTarget("codex")).toEqual({ provider: "codex" });
    expect(parseToggleTarget("codex:openai:plus")).toEqual({ provider: "codex", accountKey: "openai:plus" });
  });

  it("isVisibleOn honors hidden lists and menubarProviders allowlist", () => {
    const base = {} as Parameters<typeof isVisibleOn>[0];
    const hiddenMenubar = { ui: { hidden: { menubar: ["codex:openai:plus"] } } } as never;
    expect(isVisibleOn(hiddenMenubar, "menubar", "codex", "openai:plus")).toBe(false);
    expect(isVisibleOn(hiddenMenubar, "menubar", "codex", "other")).toBe(true);
    expect(isVisibleOn(hiddenMenubar, "dashboard", "codex", "openai:plus")).toBe(true); // surface-scoped

    const allowlist = { ui: { menubarProviders: ["claude-code"] } } as never;
    expect(isVisibleOn(allowlist, "menubar", "codex", "x")).toBe(false);
    expect(isVisibleOn(allowlist, "menubar", "claude-code", "default")).toBe(true);
    expect(isVisibleOn(allowlist, "dashboard", "codex", "x")).toBe(true); // allowlist is menubar-only

    expect(isVisibleOn(base, "menubar", "anything", "anyone")).toBe(true);
  });

  it("setSurfaceVisibility writes canonical json config", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-ui-"));
    process.env.TOKITOKI_CONFIG = path.join(dir, "config.json");
    try {
      setSurfaceVisibility("codex:openai:plus", "menubar", false);
      setSurfaceVisibility("pi", "dashboard", false);
      // re-show removes the entry entirely
      setSurfaceVisibility("codex:openai:plus", "menubar", true);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cfg = JSON.parse(require("node:fs").readFileSync(process.env.TOKITOKI_CONFIG, "utf8"));
      expect(cfg.ui.hidden.menubar).toEqual([]);
      expect(cfg.ui.hidden.dashboard).toEqual(["pi"]);
    } finally {
      delete process.env.TOKITOKI_CONFIG;
    }
  });
});
