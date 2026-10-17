import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const widget = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiWidget.qml", import.meta.url), "utf8");
const sparkline = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiSparkline.qml", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiNotifications.qml", import.meta.url), "utf8");
const functions = (source: string) => [...source.matchAll(/^    function [\s\S]*?^    }/gm)].map((match) => match[0]).join("\n");
const makeWidget = () => {
  const context = createContext({
    payload: { schema: 1, app: "tokitoki" },
    hasPayload: true,
    hasLimits: false,
    searchText: "",
    selectedPeriod: "today",
    selectedMetric: "tokens",
    privacyHideIdentities: false,
    privacyHideRepoSessionNames: false,
    providerVisibility: "all",
    selectedProviders: "",
    Theme: { warning: "orange", success: "green", primary: "pink" },
    statusProcess: { running: false },
    pendingRefresh: false,
    pendingScan: false,
  });
  context.root = context;
  runInContext(functions(widget), context);
  return context;
};

afterEach(() => setSystemTime());

describe("DMS widget uses the existing payload without distorting totals", () => {
  it("search filters whole cards while preserving chart rows and totals", () => {
    const ui = makeWidget();
    ui.payload.today = { rows: [
      { bucket: "codex", inputTokens: 120, costUsd: 2 },
      { bucket: "cursor", inputTokens: 30, costUsd: 1 },
    ], total: { inputTokens: 150, costUsd: 3 } };
    ui.searchText = "codex";
    expect(ui.cardSurvives("usage")).toBe(true);
    expect(ui.cardSurvives("harness")).toBe(true);
    expect(ui.cardSurvives("spend")).toBe(false);
    expect(ui.rowsForPeriod("today")).toHaveLength(2);
    expect(ui.slicesTotal(ui.buildSlices("today", "tokens"))).toBe(150);
    expect(ui.metricTotal("today", "tokens")).toBe(150);
    ui.searchText = "tokens";
    expect(ui.cardSurvives("usage")).toBe(true);
    expect(ui.rowsForPeriod("today")).toHaveLength(2);
    expect(ui.cardSurvives("pulse")).toBe(true);
  });

  it("shows only matching visible quota accounts and respects private identities", () => {
    const ui = makeWidget();
    ui.hasLimits = true;
    ui.payload.limits = [
      { provider: "codex", accountKey: "a", email: "alice@example.test" },
      { provider: "cursor", accountKey: "b", email: "bob@example.test" },
    ];
    ui.searchText = "alice";
    expect(ui.filteredLimits()).toHaveLength(1);
    ui.privacyHideIdentities = true;
    expect(ui.filteredLimits()).toHaveLength(0);
    ui.searchText = "cursor";
    ui.payload.uiPreview = { menubarHidden: ["cursor:b"] };
    expect(ui.cardSurvives("limits")).toBe(false);
  });

  it("keeps repo names private in charts and search", () => {
    const ui = makeWidget();
    ui.payload.repoHistory = { days: ["2026-10-17"], series: [{ bucket: "secret-repo", values: [42] }] };
    ui.payload.reposMonth = { rows: [{ bucket: "secret-repo" }] };
    ui.searchText = "secret";
    expect(ui.cardSurvives("repoHistory")).toBe(true);
    ui.privacyHideRepoSessionNames = true;
    expect(ui.cardSurvives("repoHistory")).toBe(false);
    expect(ui.cardSurvives("repos")).toBe(false);
    expect(ui.privateRepoHistory().series[0].bucket).toBe("Private repository 1");
    expect(ui.privateRepoHistory().series[0].values).toEqual([42]);
  });

  it("ranks actual duration windows consistently and displays remaining percentage", () => {
    const ui = makeWidget();
    const kinds = ["month", "90min", "week", "5h", "day", "custom"];
    expect(ui.orderedWindows(kinds.map((kind) => ({ kind }))).map((window: { kind: string }) => window.kind))
      .toEqual(["90min", "5h", "day", "week", "month", "custom"]);
    expect(ui.remainingPercent({ usedPct: 0 })).toBe(100);
    expect(ui.hasUsedPercent({ usedPct: null })).toBe(false);
    ui.hasLimits = true;
    ui.payload.limits = [{ provider: "codex", accountKey: "a", windows: [
      { kind: "week", usedPct: 80 }, { kind: "5h", usedPct: 0 },
    ] }];
    ui.payload.today = { rows: [{ bucket: "codex", inputTokens: 120, costUsd: 2 }] };
    expect(ui.buildStatusStripGroups()[0].lines[0]).toBe("5h: 100% · 120 · $2.00");
  });

  it("includes usage-only harnesses in the bar and uses real token fields in fallback", () => {
    const ui = makeWidget();
    ui.payload.today = { rows: [{ bucket: "cursor", inputTokens: 120, costUsd: 2 }], total: { inputTokens: 120, costUsd: 2 } };
    expect(ui.buildStatusStripGroups()[0].lines[0]).toBe("120 · $2.00");
    expect(ui.barSummaryText()).toContain("120 · $2.00");
  });

  it("uses the selected period for token pulse and never loses a queued scan", () => {
    const ui = makeWidget();
    ui.payload.spendPeriods = [{ key: "month", rows: [{ inputTokens: 1000, costUsd: 5, requests: 3 }] }];
    ui.selectedPeriod = "month";
    expect(ui.tokenPulseTotal().tokens).toBe(1000);
    expect(ui.tokenPulseTotal().sessions).toBeNull();
    ui.statusProcess.running = true;
    ui.refresh(true);
    ui.refresh(false);
    expect(ui.pendingRefresh).toBe(true);
    expect(ui.pendingScan).toBe(true);
  });
});

it("live payloads retain recent sessions until a cached page replaces them", () => {
  const ui = makeWidget();
  ui.payload.recentSessions = { rows: [{ title: "cached session" }] };
  ui.accept(JSON.stringify({ schema: 1, app: "tokitoki", recentSessions: null }));
  expect(ui.payload.recentSessions.rows[0].title).toBe("cached session");
  ui.accept(JSON.stringify({ schema: 1, app: "tokitoki", recentSessions: { rows: [] } }));
  expect(ui.payload.recentSessions.rows).toEqual([]);
});

it("matching repositories and legend entries remain visible beyond the normal top-six cutoff", () => {
  const ui = makeWidget();
  const rows = Array.from({ length: 8 }, (_, index) => ({ bucket: `repo-${index}`, costUsd: 10 - index }));
  ui.searchText = "repo-7";
  expect(ui.rowsFromReport({ rows })[0].bucket).toBe("repo-7");
  const slices = rows.map((row) => ({ name: row.bucket, value: row.costUsd }));
  expect(ui.legendSlices(slices)[0].name).toBe("repo-7");
  expect(slices[0]?.name).toBe("repo-0");
});

it("sparkline sums providers by local calendar day and fills missing days", () => {
  setSystemTime(new Date(2026, 9, 17, 12));
  const context = createContext({ Date, history: {
    days: ["2026-10-15", "2026-10-17"],
    series: [{ values: [20, 5] }, { values: [2, 3] }, { values: [null, "bad"] }],
  } });
  runInContext(functions(sparkline), context);
  const samples = context.buildSamples();
  expect(samples).toHaveLength(30);
  expect(samples.slice(-3)).toEqual([22, 0, 8]);
});

it("notification writes are serialized and stale payloads do not discard pending edits", () => {
  const ui = createContext({
    settings: {}, optimisticSettings: {}, writeQueue: [], activeWrite: null,
    failedPaths: [], writeProcess: { running: false }, refreshRequested: () => {},
  });
  ui.root = ui;
  runInContext(functions(notifications), ui);
  ui.mergeIncomingSettings();
  ui.setSetting("enabled", "enabled", true);
  expect(ui.activeWrite.path).toBe("notifications.enabled");
  expect(ui.activeWrite.json).toBe("true");
  ui.setSetting("quotaCriticalPercent", "quotaCriticalPercent", 20);
  expect(ui.writeQueue).toHaveLength(1);
  ui.mergeIncomingSettings();
  expect(ui.notificationSettings.enabled).toBe(true);
  expect(ui.notificationSettings.quotaCriticalPercent).toBe(20);
  ui.writeProcess.running = false;
  ui.finishWrite("notifications.enabled", true);
  expect(ui.activeWrite.path).toBe("notifications.quotaCriticalPercent");
  ui.writeProcess.running = false;
  ui.finishWrite("notifications.quotaCriticalPercent", false);
  expect(ui.writeStatus()).toContain("could not be saved");
  ui.setSetting("quotaCriticalPercent", "quotaCriticalPercent", 20);
  expect(ui.activeWrite.path).toBe("notifications.quotaCriticalPercent");
});

it("notification category writes preserve other categories and custom thresholds", () => {
  const ui = createContext({
    settings: { quotaCriticalPercent: 12, disabledNotifications: ["futureCategory"] },
    optimisticSettings: {}, writeQueue: [], activeWrite: null,
    failedPaths: [], writeProcess: { running: false },
  });
  ui.root = ui;
  runInContext(functions(notifications), ui);
  ui.mergeIncomingSettings();
  expect(ui.optionsWithCurrent([5, 10, 20], ui.notificationSettings.quotaCriticalPercent)).toEqual([5, 10, 20, 12]);
  ui.setCategoryEnabled("quotaCritical", false);
  expect(ui.activeWrite.path).toBe("notifications.disabled");
  expect(JSON.parse(ui.activeWrite.json)).toEqual(["futureCategory", "quotaCritical"]);
});
