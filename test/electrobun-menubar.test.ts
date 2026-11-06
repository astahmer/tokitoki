import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  accountExtraLines,
  accountTitle,
  accountVendor,
  barTone,
  donutArcs,
  escapeHtml,
  formatCost,
  humanCount,
  providerName,
  remainingPercent,
  resetLabel,
  cardSetSpec,
  displayWindows,
  isLocalWindow,
  accountOrderCommand,
  orderedAccounts,
  orderedTabs,
  popupTabIds,
  reorderQuotaAccounts,
  importCommand,
  isSignInUrl,
  panelCommand,
  pollAuthStates,
  pollResult,
  privateTitle,
  serviceIncidents,
  signInUrl,
  systemTrayPopupFrame,
  dashboardUrl,
  tightestWindow,
  upstreamProvider,
  tokitokiCommandCandidates,
  tokenCount,
  toolEntries,
  windowStatusLabel,
  windowSummary,
} from "../menubar/electrobun/src/mainview/format.ts";
import { renderConversation } from "../menubar/electrobun/src/mainview/conversation.ts";
import { mcpIntegration } from "../menubar/electrobun/src/mainview/mcp.ts";
import { activeTrackedSources, parseTrackedSources } from "../menubar/electrobun/src/mainview/tracked-sources.ts";
import { configPathFromList, parseAlertHistory } from "../menubar/electrobun/src/mainview/settings-info.ts";
import { addStoredApiKey, maskApiKey, maskedApiKeys, readStoredApiKeys, removeStoredApiKey, storedApiKeyJson } from "../menubar/electrobun/src/mainview/api-keys.ts";
import {
  appendSessionEvents,
  cacheDurationText,
  eventDetailLines,
  parseSessionDetail,
  parseSessionList,
  sessionDetailArguments,
  sessionListArguments,
  sessionSnippet,
  sessionTitle,
} from "../menubar/electrobun/src/mainview/sessions.ts";
import {
  includesQuery,
  moveCard,
  orderedCards,
  polylinePoints,
  reorderCards,
  traySummaryText,
} from "../menubar/electrobun/src/mainview/panel.ts";

describe("electrobun menubar formatting", () => {
  test("formats tokens and cost the way the reports do", () => {
    expect(humanCount(18344)).toBe("18.34K");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(12.4)).toBe("$12");
  });

  test("escapes text that will be inserted into the page", () => {
    expect(escapeHtml(`a <b> & "c"`)).toBe("a &lt;b&gt; &amp; &quot;c&quot;");
  });

  test("names the harnesses the way the menubar does", () => {
    expect(providerName("claude-code")).toBe("Claude");
    expect(providerName("opencode")).toBe("OpenCode");
    expect(providerName("custom")).toBe("custom");
  });

  test("counts tokens from the payload parts or a precomputed total", () => {
    expect(tokenCount({ inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 })).toBe(10);
    expect(tokenCount({ tokens: 8, inputTokens: 100 })).toBe(8);
  });

  test("picks the quota window with the least time left", () => {
    const account = {
      provider: "claude-code",
      email: "ada@example.com",
      windows: [
        { label: "Week", source: "embedded", status: "current", usedPercent: 20 },
        { label: "Session", source: "embedded", status: "current", usedPercent: 91 },
        { label: "Today", source: "derived", usedPercent: 99 },
      ],
    };
    expect(tightestWindow(account)?.label).toBe("Session");
    expect(remainingPercent(account.windows[1]!)).toBe(9);
    expect(barTone(91)).toBe("critical");
    expect(barTone(70)).toBe("warn");
    expect(barTone(10)).toBe("ok");
    expect(accountTitle(account)).toBe("ada@example.com");
  });

  test("describes a reset as a short countdown", () => {
    const now = Date.parse("2026-11-05T18:00:00Z");
    expect(resetLabel("2026-11-05T18:30:00Z", now)).toBe("30m");
    expect(resetLabel("2026-11-05T17:00:00Z", now)).toBe("now");
    expect(resetLabel(undefined, now)).toBe("—");
  });

  test("builds donut arcs that cover the whole ring", () => {
    const arcs = donutArcs([1, 3]);
    expect(arcs.length).toBe(2);
    expect(arcs[0]?.portion).toBe(25);
    expect(arcs[1]?.offset).toBe(25);
    expect((arcs[0]?.portion ?? 0) + (arcs[1]?.portion ?? 0)).toBe(100);
  });

  test("looks for the Windows install before the repository CLI", () => {
    const candidates = tokitokiCommandCandidates({
      executableOverride: undefined,
      localApplicationData: "C:\\Users\\vincent\\AppData\\Local",
      pathSeparator: "\\",
      repositoryCli: "/repo/src/cli.ts",
      repositoryCliExists: true,
      bunExecutable: "/usr/bin/bun",
    });
    expect(candidates[0]).toEqual(["C:\\Users\\vincent\\AppData\\Local\\tokitoki\\tokitoki.exe"]);
    expect(candidates[1]).toEqual(["/usr/bin/bun", "/repo/src/cli.ts"]);
    expect(candidates[2]).toEqual(["tokitoki"]);
  });

  test("shows stale quota windows and local budget windows", () => {
    const account = {
      provider: "cursor",
      windows: [{ label: "Cursor Models", status: "stale", source: "embedded" }],
      budgetWindows: [{ label: "Today usage", cost: 0.31, tokens: 100 }],
    };
    expect(windowStatusLabel(account.windows[0]!)).toBe("stale");
    expect(displayWindows(account).length).toBe(2);
    expect(isLocalWindow({ source: "derived" })).toBe(true);
    expect(isLocalWindow({ id: "local:today" })).toBe(true);
    expect(isLocalWindow(account.windows[0]!)).toBe(false);
    expect(tightestWindow(account)).toBeUndefined();
  });

  test("keeps spend next to a stale quota status", () => {
    const now = Date.parse("2026-11-06T18:00:00Z");
    const summary = windowSummary(
      {
        label: "This week usage",
        status: "stale",
        tokens: 956195,
        cost: 2.03,
        requests: 202,
        resetsAt: "2026-11-09T08:00:00Z",
        observedAt: "2026-11-05T12:00:00Z",
      },
      now,
    );
    expect(summary.headline).toBe("stale");
    expect(summary.detail).toContain("$2.03");
    expect(summary.detail).toContain("956.2K tokens");
    expect(summary.detail).toContain("seen 30h ago");
    expect(summary.usedPercent).toBeUndefined();
  });

  test("anchors the popup on the tray icon", () => {
    const aboveIcon = systemTrayPopupFrame({
      trayBounds: { x: 1200, y: 760, width: 40, height: 32 },
      workArea: { x: 0, y: 0, width: 1280, height: 752 },
      popupWidth: 420,
      popupHeight: 640,
      gap: 8,
    });
    expect(aboveIcon.x + aboveIcon.width).toBe(1240);
    expect(aboveIcon.y + aboveIcon.height).toBeLessThanOrEqual(752);
    expect(aboveIcon.y).toBeLessThan(760);

    const fallback = systemTrayPopupFrame({
      trayBounds: undefined,
      workArea: { x: 0, y: 0, width: 1280, height: 752 },
      popupWidth: 420,
      popupHeight: 640,
      gap: 8,
    });
    expect(fallback.x).toBe(1280 - 420 - 8);
    expect(fallback.y).toBe(752 - 640 - 8);
    const lifted = systemTrayPopupFrame({
      trayBounds: undefined,
      workArea: { x: 0, y: 0, width: 1280, height: 752 },
      popupWidth: 420,
      popupHeight: 640,
      gap: 8,
      bottomInset: 88,
    });
    expect(lifted.y).toBe(752 - 640 - 8 - 88);
  });

  test("reads top tools from the widget payload shape", () => {
    const entries = toolEntries({ tools: [{ tool: "cursor/(unattributed)", costUsd: 0.31 }] });
    expect(entries[0]?.tool).toBe("cursor/(unattributed)");
  });

  test("filters, reorders, and charts the panel cards", () => {
    const cards = [
      { id: "week", title: "this week", text: "claude", html: "week" },
      { id: "today", title: "today", text: "cursor", html: "today" },
    ];
    const visible = orderedCards(cards, { hidden: ["today"], order: ["today", "week"] }, "");
    expect(visible.map((card) => card.id)).toEqual(["week"]);
    expect(reorderCards(["week", "today", "tools"], "tools", "week")).toEqual(["tools", "week", "today"]);
    expect(moveCard(["week", "today"], "today", -1)).toEqual(["today", "week"]);
    const points = polylinePoints([0, 10], 10, 10);
    expect(points.startsWith("0.0,")).toBe(true);
    expect(includesQuery("Claude Code", "claude")).toBe(true);
    expect(traySummaryText(103, 0.31)).toBe("tokitoki $103 this week");
  });

  test("only allows the settings and sign-in actions the panel can persist", () => {
    expect(signInUrl("claude-code")).toBe("https://claude.ai/login");
    expect(isSignInUrl("https://example.com")).toBe(false);
    expect(panelCommand({ action: "config", path: "notifications.enabled", value: "true" })).toEqual(["config", "set", "notifications.enabled", "true"]);
    expect(panelCommand({ action: "config", path: "notifications.burnWarningRatio", value: "0.8" })).toEqual(["config", "set", "notifications.burnWarningRatio", "0.8"]);
    expect(panelCommand({ action: "config", path: "poll.intervalMinutes", value: "15" })).toEqual(["config", "set", "poll.intervalMinutes", "15"]);
    expect(panelCommand({ action: "config", path: "poll.intervalMinutes", value: "7" })).toBeUndefined();
    expect(panelCommand({ action: "config", path: "notifications.disabled", value: '["quotaPace"]' })).toEqual(["config", "set", "notifications.disabled", '["quotaPace"]']);
    expect(panelCommand({ action: "config", path: "notifications.disabled", value: "[]" })).toEqual(["config", "set", "notifications.disabled", "[]"]);
    expect(panelCommand({ action: "config", path: "notifications.disabled", value: '["nope"]' })).toBeUndefined();
    expect(panelCommand({ action: "ui-hide", value: "codex:openai:abc" })).toEqual(["ui", "--hide", "codex:openai:abc", "--surface", "widget"]);
    expect(panelCommand({ action: "ui-show", value: "cursor:default" })).toEqual(["ui", "--show", "cursor:default", "--surface", "widget"]);
    expect(panelCommand({ action: "ui-hide", value: "not a target" })).toBeUndefined();
    expect(panelCommand({ action: "card-set", value: "spend:1,tools:0" })).toEqual(["ui", "--card-set", "spend:1,tools:0"]);
    expect(panelCommand({ action: "tabs", value: "reports,overview,quotas" })).toEqual(["ui", "--tabs", "reports,overview,quotas"]);
    expect(panelCommand({ action: "tabs", value: "reports,nope" })).toBeUndefined();
    expect(orderedTabs(["reports", "overview", "reports"])).toEqual(["reports", "overview", "quotas", "tokens", "sources", "mcp", "settings"]);
    expect(popupTabIds(["reports", "overview", "quotas", "tokens"])).toEqual(["reports", "overview", "quotas", "tokens", "sessions", "sources", "mcp", "settings"]);
    const ordered = orderedAccounts(
      [
        { provider: "cursor", accountKey: "default" },
        { provider: "codex", accountKey: "plus" },
        { provider: "copilot", accountKey: "default" },
      ],
      ["codex@plus", "cursor@default"],
      ["copilot:default"],
    );
    expect(ordered.map((account) => account.provider)).toEqual(["codex", "cursor"]);
    expect(cardSetSpec(["tools", "spend"], ["tools"])).toBe("tools:0,spend:1,limits:1,usage:1,harness:1,activity:1,anomalies:1,repos:1");
    expect(panelCommand({ action: "config", path: "sync.backend", value: "git" })).toEqual(["config", "set", "sync.backend", "git"]);
    expect(panelCommand({ action: "config", path: "sync.backend", value: "ftp" })).toBeUndefined();
    expect(panelCommand({ action: "config", path: "sync.path", value: "D:\\tokitoki-share" })).toEqual(["config", "set", "sync.path", "\"D:\\\\tokitoki-share\""]);
    expect(panelCommand({ action: "config", path: "sync.url", value: "bad\nurl" })).toBeUndefined();
    expect(panelCommand({ action: "sync" })).toEqual(["sync"]);
    expect(importCommand("C:\\Users\\vincent\\Downloads\\usage.csv")).toEqual(["import", "C:\\Users\\vincent\\Downloads\\usage.csv"]);
    expect(panelCommand({ action: "poll-all" })).toEqual(["poll", "--json"]);
    expect(panelCommand({ action: "config", path: "ui.showHarnessVariants", value: "true" })).toEqual(["config", "set", "ui.showHarnessVariants", "true"]);
    expect(panelCommand({ action: "config", path: "ui.showHarnessVariants", value: "yes" })).toBeUndefined();
    expect(panelCommand({ action: "config", path: "ui.stripMetric", value: "tokens" })).toEqual(["config", "set", "ui.stripMetric", "tokens"]);
    expect(panelCommand({ action: "config", path: "ui.stripMetric", value: "cost" })).toBeUndefined();
    expect(panelCommand({ action: "config", path: "ui.previewHidden", value: '["openai"]' })).toEqual(["config", "set", "ui.previewHidden", '["openai"]']);
    expect(panelCommand({ action: "config", path: "ui.previewHidden", value: '["Bad"]' })).toBeUndefined();
    expect(upstreamProvider("codex", "plus")).toBe("openai");
    expect(upstreamProvider("claude-code", "work")).toBe("claude");
    expect(upstreamProvider("t3code", "cursor")).toBe("cursor");
    expect(upstreamProvider("pi", "local")).toBeUndefined();
    expect(importCommand("notes.txt")).toBeUndefined();
    expect(importCommand("-usage.csv")).toBeUndefined();
    expect(dashboardUrl("/")).toBe("http://127.0.0.1:7788/");
    expect(dashboardUrl("/?view=sources")).toBe("http://127.0.0.1:7788/?view=sources");
    expect(dashboardUrl("/?view=reports&last=month")).toBe("http://127.0.0.1:7788/?view=reports&last=month");
    expect(dashboardUrl("/?view=sessions&provider=cursor&session=agent-15318750-c432-4ded-9056-64c6f80c977d")).toBe("http://127.0.0.1:7788/?view=sessions&provider=cursor&session=agent-15318750-c432-4ded-9056-64c6f80c977d");
    expect(dashboardUrl("/?view=sessions&provider=cursor&session=agent-1&extra=1")).toBeUndefined();
    expect(dashboardUrl("http://example.com/")).toBeUndefined();
    expect(dashboardUrl("/?view=settings")).toBeUndefined();
    expect(panelCommand({ action: "config", path: "sync.url", value: "true" })).toEqual(["config", "set", "sync.url", "\"true\""]);
    expect(panelCommand({ action: "poll", provider: "codex" })).toEqual(["poll", "--provider", "codex", "--json"]);
    const polled = pollResult('{"ok":false,"reason":"codex: login","accounts":[{"email":"person@example.com"}],"providerAuthStates":{"codex":"login-required","nope":"logged-in"}}');
    expect(polled.ok).toBe(false);
    expect(polled.detail).toBe("Quota refresh failed: codex: login");
    expect(polled.authJson).toBe('{"codex":"login-required"}');
    expect(polled.authJson).not.toContain("person@example.com");
    expect(pollAuthStates('{"cursor":"api-key-required"}')).toEqual({ cursor: "api-key-required" });
    expect(pollResult('{"ok":true}')).toEqual({ ok: true, detail: "Provider quotas refreshed", authJson: "{}" });
    expect(accountExtraLines({
      bankedResets: 2,
      bankedExpiresAt: "2026-11-07T18:00:00.000Z",
      extraUsage: { enabled: true, usedUsd: 4.5, limitUsd: 20 },
      credits: { unlimited: false, balance: "12.00" },
      balance: { currency: "USD", remaining: 3.25, total: 10 },
    }, Date.parse("2026-11-06T18:00:00.000Z"))).toEqual([
      "2 banked resets (expires 2026-11-07 18:00 · 24h)",
      "Extra usage $4.50 / $20",
      "Workspace credits 12.00",
      "Balance $3.25 / $10",
    ]);
    expect(accountVendor("codex", { codex: { vendor: "openai" } })).toBe("openai");
    expect(serviceIncidents({
      openai: { indicator: "none", description: "ok", url: "https://status.openai.com" },
      anthropic: { indicator: "major", description: "Elevated errors", url: "http://status.claude.com" },
      cursor: { indicator: "minor", description: "Degraded", url: "https://status.cursor.com" },
    })).toEqual([
      { vendor: "anthropic", indicator: "major", description: "Elevated errors", url: "" },
      { vendor: "cursor", indicator: "minor", description: "Degraded", url: "https://status.cursor.com" },
    ]);
    expect(panelCommand({ action: "poll", provider: "../codex" })).toBeUndefined();
    expect(panelCommand({ action: "poll-enabled", value: "false" })).toEqual(["poll", "--disable"]);
    expect(privateTitle("Codex · vincent@example.com", true)).toBe("Codex · hidden identity");
    expect(privateTitle("Codex · vincent@example.com", false)).toBe("Codex · vincent@example.com");
  });

  test("switches the MCP setup snippet by agent", () => {
    expect(mcpIntegration("cursor").snippet).toContain('"mcpServers"');
    expect(mcpIntegration("codex").snippet).toContain("[mcp_servers.tokitoki]");
    expect(mcpIntegration("claude-code").snippet).toBe("claude mcp add tokitoki -- tokitoki mcp");
    expect(mcpIntegration("vscode").snippet).toContain('"servers"');
    expect(mcpIntegration("vscode").snippet).not.toContain("mcpServers");
    expect(mcpIntegration("missing").title).toBe("Claude Desktop");
  });

  test("loads a month of sessions and appends the next event page", () => {
    expect(sessionListArguments("deploy", 2)).toEqual([
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
    expect(sessionDetailArguments("codex", "s-1", 40)).toEqual([
      "sessions",
      "--cached",
      "--provider",
      "codex",
      "--session",
      "s-1",
      "--events-limit",
      "40",
      "--events-offset",
      "40",
      "--json",
    ]);
    expect(sessionTitle({ title: "  Ship\nthe panel  " })).toBe("Ship the panel");
    expect(sessionSnippet({ title: "Ship the panel", snippet: "Ship the panel: [[quota]] windows" })).toBe("quota windows");
    expect(cacheDurationText({ estimatedSeconds: 90, confidence: "medium", samples: 8, busts: 2 })).toContain("≈ 2m · medium confidence");
    const page = parseSessionList(JSON.stringify({ page: 2, hasMore: true, rows: [{ provider: "codex", sessionId: "s-1", title: "Ship" }] }));
    expect(page.rows[0]?.sessionId).toBe("s-1");
    const first = parseSessionDetail(
      JSON.stringify({
        provider: "codex",
        sessionId: "s-1",
        conversation: { body: "hello" },
        events: [{ ts: "2026-11-06T10:00:00Z", model: "gpt", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 }],
        eventsTotal: 2,
        eventsOffset: 0,
        eventsHasMore: true,
      }),
      "codex",
      "s-1",
    );
    const second = parseSessionDetail(
      JSON.stringify({
        provider: "codex",
        sessionId: "s-1",
        events: [{ ts: "2026-11-06T10:01:00Z", model: "gpt", inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }],
        eventsTotal: 2,
        eventsOffset: 1,
        eventsHasMore: false,
      }),
      "codex",
      "s-1",
    );
    expect(appendSessionEvents(first.events, second, 1)).toHaveLength(2);
    expect(first.events[0]?.n).toBe(1);
    expect(second.events[0]?.n).toBe(2);
    expect(first.conversationTitle).toBe("");
    expect(eventDetailLines({ n: 4, ts: "2026-11-06T10:00:00Z", model: "gpt", description: "", tokenSource: "estimated", tokens: 1200, runningTokens: 4000, costUsd: 0.1 }).heading).toContain("Request 4");
    expect(() => appendSessionEvents(first.events, second, 0)).toThrow("unexpected event page");
  });

  test("renders a conversation the way the native menubar does", () => {
    const body = [
      "# Ship the panel",
      "",
      "### User · 2026-11-06 10:00:00",
      "",
      "Please **read** the file",
      "",
      "[tool:read]",
      "tools.read_file()",
      "",
      "### Assistant · 2026-11-06 10:00:02",
      "",
      "Done.",
      "",
      "- one",
      "- two",
      "",
      "> quoted",
      "",
      "```ts",
      "const value = 1",
      "```",
      "",
      "### Tool call · 2026-11-06 10:00:03",
      "",
      "ran it",
    ].join("\n");
    const markup = renderConversation(body, "Ship the panel");
    expect(markup).toContain("Tools used · 2");
    expect(markup).toContain("read · 1");
    expect(markup).toContain("tools.read_file · 1");
    expect(markup).not.toContain("[tool:read]");
    expect(markup).not.toContain("Ship the panel");
    expect(markup).toContain("conversation-role user");
    expect(markup).toContain("<strong>read</strong>");
    expect(markup).toContain("conversation-role assistant");
    expect(markup).toContain("quoted");
    expect(markup).toContain("const value = 1");
    expect(markup).toContain("ts");
    expect(markup).toContain("Tool call · 1 part");
    expect(markup).toContain("ran it");
    expect(markup).toContain("one");
    expect(markup).toContain("•");
    expect(renderConversation("[tool:read]", "").includes("No conversation body indexed.")).toBe(true);
  });

  test("reorders quota accounts without moving the bar or hidden slots", () => {
    const update = reorderQuotaAccounts(["codex@b", "codex@a"], ["hidden@x", "codex@a", "codex@b"], ["codex@b", "codex@a"], ["codex@a", "codex@b", "cursor@c"]);
    expect(update.quota).toEqual(["hidden@x", "codex@b", "codex@a", "cursor@c"]);
    expect(update.bar).toEqual(["codex@b", "codex@a", "cursor@c"]);
    expect(accountOrderCommand(JSON.stringify({ quota: update.quota, bar: update.bar }))).toEqual([
      "ui",
      "--account-order",
      "hidden@x,codex@b,codex@a,cursor@c",
      "--bar-account-order",
      "codex@b,codex@a,cursor@c",
    ]);
    expect(accountOrderCommand('{"quota":["bad id"],"bar":["codex@a"]}')).toBeUndefined();
    expect(panelCommand({ action: "account-order", value: '{"quota":["codex@a"],"bar":["codex@a,b"]}' })).toBeUndefined();
  });

  test("reads tracked harness stores from the sources report", () => {
    const report = [
      "claude-code — Claude Code",
      "  root: C:\\Users\\vincent\\.claude (`CLAUDE_CONFIG_DIR`)",
      "  files: 12 found · 10 tracked · 9 up-to-date",
      "  events: 1,234 · accounts: work <a@b.c>",
      "  models: claude-opus-4, claude-sonnet-4",
      "",
      "cursor — Cursor",
      "  files: 0 found · 0 tracked · 0 up-to-date",
      "  events: 0 · accounts: (none)",
      "  models: (none)",
    ].join("\n");
    const sources = parseTrackedSources(report);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.roots[0]?.envVar).toBe("CLAUDE_CONFIG_DIR");
    expect(sources[0]?.events).toBe(1234);
    expect(sources[0]?.models).toEqual(["claude-opus-4", "claude-sonnet-4"]);
    expect(activeTrackedSources(sources).map((source) => source.id)).toEqual(["claude-code"]);
    expect(parseTrackedSources("no providers registered")).toEqual([]);
    expect(parseTrackedSources("tokitoki was not found")).toEqual([]);
  });

  test("reads the config path and the newest alerts", () => {
    const listing = "surface visibility (config: C:\\Users\\vincent\\.config\\tokitoki\\config.json)\n  widget: hidden=[]\n";
    expect(configPathFromList(listing)).toBe("C:\\Users\\vincent\\.config\\tokitoki\\config.json");
    expect(configPathFromList("ok")).toBe("");
    const raw = JSON.stringify({
      history: [
        { at: "2026-11-01T10:00:00Z", title: "Older", body: "first", reason: "quota", kind: "quotaCritical" },
        { at: "2026-11-06T10:00:00Z", title: "Newer", body: "second", reason: "pace", kind: "quotaPace" },
      ],
    });
    const alerts = parseAlertHistory(raw);
    expect(alerts[0]?.title).toBe("Newer");
    expect(parseAlertHistory(JSON.stringify(alerts))[1]?.title).toBe("Older");
    expect(parseAlertHistory("not json")).toEqual([]);
  });

  test("masks provider API keys and keeps the other saved keys", () => {
    const secret = "test-key-value-abcdef";
    expect(maskApiKey(secret)).toBe("test…cdef");
    expect(maskApiKey("short-key")).toBe("…");
    const config = JSON.stringify({
      poll: {
        extraKeys: [
          { id: "work", label: "Work", provider: "opencode-go", key: secret },
          { id: "router", provider: "openrouter", key: "route-key-value-zzzz" },
        ],
      },
    });
    const stored = readStoredApiKeys(config);
    expect(maskedApiKeys(stored).map((key) => key.hint)).toEqual(["test…cdef", "rout…zzzz"]);
    expect(JSON.stringify(maskedApiKeys(stored))).not.toContain(secret);
    const added = addStoredApiKey(stored, { id: "home", label: "", provider: "openrouter", key: "another-key-value-1234" });
    expect(added).toHaveLength(3);
    expect(storedApiKeyJson(removeStoredApiKey(added, "work", "opencode-go"))).not.toContain(secret);
    expect(() => addStoredApiKey(stored, { id: "work", label: "", provider: "opencode-go", key: "another-key-value-1234" })).toThrow("already saved");
    expect(() => addStoredApiKey(stored, { id: "bad id", label: "", provider: "opencode-go", key: "another-key-value-1234" })).toThrow("without spaces");
  });

  test("loads the bundled view script from the page", () => {
    const page = readFileSync(new URL("../menubar/electrobun/src/mainview/index.html", import.meta.url), "utf8");
    expect(page).toContain('<script type="module" src="index.js"></script>');
    expect(page).toContain('id="search"');
    expect(page).not.toContain("Open web reports");
  });
});
