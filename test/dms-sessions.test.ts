import { describe, expect, it } from "bun:test";
import fs from "node:fs";

const qml = fs.readFileSync(new URL("../integrations/dms/tokitoki/TokitokiSessionsView.qml", import.meta.url), "utf8");

const extractFunction = (name: string): string => {
  const start = qml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing QML function: ${name}`);
  const open = qml.indexOf("{", start);
  if (open < 0) throw new Error(`missing function body: ${name}`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < qml.length; index += 1) {
    const character = qml[index]!;
    if (quote.length > 0) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return qml.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
};

const qmlFunctions = (names: string[], root: unknown = {}) => {
  const definitions = names.map(extractFunction).join("\n");
  return new Function("root", `${definitions}\nreturn { ${names.join(", ")} };`)(root);
};

describe("DMS sessions QML helpers", () => {
  it("does not start background searches when its tab is hidden", () => {
    const root = { active: false, pendingSearch: false };
    qmlFunctions(["runSearch"], root).runSearch();
    expect(root.pendingSearch).toBe(true);
  });

  it("can mask account identities without hiding conversation titles", () => {
    const helpers = qmlFunctions(["timestampMillis", "timestampText", "sessionMeta"], {
      privacyHideNames: false,
      privacyHideIdentities: true,
    });
    expect(helpers.sessionMeta({ provider: "codex", accountKey: "private@example.test", startedAt: 1_700_000_000 }))
      .toContain("account hidden");
    expect(helpers.sessionMeta({ provider: "codex", accountKey: "private@example.test", startedAt: 1_700_000_000 }))
      .not.toContain("private@example.test");
  });

  it("formats numeric seconds, numeric milliseconds, and ISO timestamps", () => {
    const helpers = qmlFunctions(["timestampMillis", "timestampText", "eventTime"]);
    expect(helpers.timestampMillis(1_700_000_000)).toBe(1_700_000_000_000);
    expect(helpers.timestampText(1_700_000_000)).toBe("2023-11-14 22:13 UTC");
    expect(helpers.timestampText(1_700_000_000_000)).toBe("2023-11-14 22:13 UTC");
    expect(helpers.eventTime("2026-10-17T12:34:56.000Z")).toBe("12:34:56 UTC");
    expect(helpers.eventTime("invalid")).toBe("unknown time");
  });

  it("keeps the full conversation body and still honors privacy mode", () => {
    const helpers = qmlFunctions(["conversationBody"], {
      detail: { conversation: { body: "x".repeat(2501) } },
      privacyHideNames: false,
    });
    expect(helpers.conversationBody()).toHaveLength(2501);
    const privateHelpers = qmlFunctions(["conversationBody"], {
      detail: { conversation: { body: "private text" } },
      privacyHideNames: true,
    });
    expect(privateHelpers.conversationBody()).toBe("");
  });

  it("masks command errors when session names are private", () => {
    const helpers = qmlFunctions(["statusText"], {
      privacyHideNames: true,
      status: "Could not load conversation: no session 'private-session-id'",
    });
    expect(helpers.statusText()).toBe("Tokitoki request failed.");
  });

  it("uses cached CLI pages with explicit session event offsets", () => {
    const helpers = qmlFunctions(["searchArgs", "drillArgs"], {
      command: "tokitoki",
      query: "deploy",
      page: 2,
    });
    expect(helpers.searchArgs()).toEqual([
      "tokitoki",
      "sessions",
      "--cached",
      "--last",
      "month",
      "--top",
      "25",
      "--page",
      "2",
      "--json",
      "--search",
      "deploy",
    ]);
    expect(helpers.drillArgs({ provider: "codex", sessionId: "s-1", offset: 80 })).toEqual([
      "tokitoki",
      "sessions",
      "--cached",
      "--provider",
      "codex",
      "--session",
      "s-1",
      "--events-limit",
      "40",
      "--events-offset",
      "80",
      "--json",
    ]);
  });

  it("drops stale detail responses and appends event pages at the requested offset", () => {
    const root: {
      detailGeneration: number;
      detail: Record<string, unknown> | null;
      events: unknown[];
      status: string;
    } = {
      detailGeneration: 4,
      detail: { provider: "codex", sessionId: "s-1", conversation: null },
      events: [],
      status: "Loading conversation…",
    };
    const helpers = qmlFunctions(["safeNumber", "acceptDetail"], root);
    const request = { generation: 4, provider: "codex", sessionId: "s-1", offset: 0 };
    helpers.acceptDetail(
      JSON.stringify({
        provider: "codex",
        sessionId: "s-1",
        conversation: { body: "full body" },
        cacheDuration: { estimatedSeconds: null },
        events: [{ ts: "2026-10-17T12:00:00Z" }, { ts: "2026-10-17T12:01:00Z" }],
        eventsTotal: 3,
        eventsOffset: 0,
        eventsHasMore: true,
      }),
      request,
    );
    expect(root.events).toHaveLength(2);
    expect(root.detail?.["eventsHasMore"]).toBe(true);

    helpers.acceptDetail(
      JSON.stringify({
        provider: "codex",
        sessionId: "s-1",
        conversation: { body: "full body" },
        cacheDuration: { estimatedSeconds: null },
        events: [{ ts: "2026-10-17T12:02:00Z" }],
        eventsTotal: 3,
        eventsOffset: 2,
        eventsHasMore: false,
      }),
      { ...request, offset: 2 },
    );
    expect(root.events).toHaveLength(3);
    expect(root.detail?.["eventsHasMore"]).toBe(false);

    const staleRoot = { ...root, detailGeneration: 5, events: [] };
    const staleHelpers = qmlFunctions(["safeNumber", "acceptDetail"], staleRoot);
    staleHelpers.acceptDetail("not-json", request);
    expect(staleRoot.events).toEqual([]);
  });

  it("explains cache estimate evidence and handles insufficient data", () => {
    const helpers = qmlFunctions(["safeNumber", "intervalText", "cacheDurationText"]);
    expect(
      helpers.cacheDurationText({ estimatedSeconds: 90, confidence: "medium", samples: 8, busts: 2 }),
    ).toBe(
      "Estimated cache lifetime ≈ 2m · medium confidence. Based on 2 observed cache resets across 8 requests; an estimate, not a provider guarantee.",
    );
    expect(
      helpers.cacheDurationText({ estimatedSeconds: null, confidence: "low", samples: 0, busts: 0 }),
    ).toContain("not enough evidence · low confidence");
  });
});
