import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const widget = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiWidget.qml", import.meta.url), "utf8");
const sparkline = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiSparkline.qml", import.meta.url), "utf8");
const dayClock = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiDayClock.qml", import.meta.url), "utf8");
const activityGrid = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiActivityGrid.qml", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiNotifications.qml", import.meta.url), "utf8");
const functions = (source: string) => [...source.matchAll(/^    function [\s\S]*?^    }/gm)].map((match) => match[0]).join("\n");
const makeWidget = () => {
  const context = createContext({
    // The vm realm has its own Date; share ours so setSystemTime pins "now".
    Date,
    payload: { schema: 1, app: "tokitoki" },
    hasPayload: true,
    hasLimits: false,
    shellName: "DMS",
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
  it("uses the shell host name when searching integration settings", () => {
    const ui = makeWidget();
    ui.shellName = "Quickshell";
    ui.searchText = "quickshell";
    expect(ui.cardSurvives("integration")).toBe(true);
    ui.searchText = "dms";
    expect(ui.cardSurvives("integration")).toBe(false);
  });

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
    expect(ui.buildStatusStripGroups()[0].lines[0]).toBe("5h 100% · 7d 20%");
  });

  it("renders provider-neutral windows with labels, pace, and run-out time", () => {
    setSystemTime(new Date(2026, 9, 18, 12, 30));
    const ui = makeWidget();
    const session = {
      kind: "day", label: "Session", scope: "session", windowMinutes: 300, usedPct: 80,
      pace: { expectedPercent: 50, deltaPercent: 30, status: "over", runsOutAt: new Date(2026, 9, 18, 13, 7).toISOString() },
    };
    const opus = { kind: "Opus weekly", label: "Opus weekly", scope: "model", model: "opus", windowMinutes: 10080, usedPct: 10 };
    const weekly = { kind: "week", label: "Weekly", scope: "weekly", windowMinutes: 10080, usedPct: 30, pace: { expectedPercent: 40, status: "on" } };
    const ordered = ui.orderedWindows([opus, { kind: "month" }, weekly, session]);
    expect(ordered.map((window: { kind: string }) => window.kind)).toEqual(["day", "week", "Opus weekly", "month"]);
    expect(ui.windowTitle(session)).toBe("Session");
    expect(ui.windowTitle({ kind: "week" })).toBe("Weekly");
    expect(ui.paceLabel(session)).toBe("Runs out ~13:07");
    expect(ui.paceLabel(weekly)).toBe("On pace");
    expect(ui.paceLabel({ kind: "week" })).toBe("");
    expect(ui.paceMarkerFraction(weekly)).toBeCloseTo(0.6);
    expect(ui.paceMarkerFraction(opus)).toBe(-1);
    expect(ui.extraUsageLabel({ enabled: true, usedUsd: 12.5, limitUsd: 50 })).toBe("Extra usage $12.50 / $50.00");
    expect(ui.extraUsageLabel({ enabled: false })).toBe("");
    ui.hasLimits = true;
    ui.payload.limits = [{ provider: "claude-code", accountKey: "default", windows: [opus, weekly, session] }];
    expect(ui.buildStatusStripGroups()[0].lines[0]).toBe("5h 20% · 7d 70% · Opus 90%");
  });

  it("includes usage-only harnesses in the bar and uses real token fields in fallback", () => {
    const ui = makeWidget();
    ui.payload.today = { rows: [{ bucket: "cursor", inputTokens: 120, costUsd: 2 }], total: { inputTokens: 120, costUsd: 2 } };
    expect(ui.buildStatusStripGroups()[0].lines).toEqual([]);
    expect(ui.barSummaryText()).not.toContain("$2.00");
  });

  it("keeps profiles separate, prefixes multiple profiles, and shows only countdowns in tooltips", () => {
    setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const ui = makeWidget();
    ui.hasLimits = true;
    ui.payload.limits = [
      { provider: "codex", accountKey: "evvi", label: "Evvi", windows: [
        { kind: "day", label: "Session", windowMinutes: 300, usedPct: 1, resetsAt: "2026-10-19T15:12:00Z" },
        { kind: "week", windowMinutes: 10080, usedPct: 36 },
      ] },
      { provider: "codex", accountKey: "jonas", label: "Jonas", windows: [
        { kind: "day", windowMinutes: 300, usedPct: 68 },
      ] },
    ];
    const group = ui.buildStatusStripGroups()[0];
    expect(group.lines).toEqual(["EV: 5h 99% · 7d 64%", "JO: 5h 32%"]);
    expect(group.profiles[0].rows[0]).toMatchObject({ label: "5h", value: "99%", resetsAt: "2026-10-19T15:12:00Z" });
    expect(ui.barCountdown(group.profiles[0].rows[0].resetsAt)).toBe("3h 12m");
    ui.barNow = Date.parse("2026-10-19T12:01:00Z");
    expect(ui.barCountdown(group.profiles[0].rows[0].resetsAt)).toBe("3h 11m");
    ui.barNow = undefined;
    expect(ui.barCountdown("bad")).toBe("");
    expect(ui.resetLabel("2026-10-19T15:12:00Z")).toBe("3h 12m");
    expect(ui.barWindowBucket({ windowMinutes: 43200, label: "Other Models" })).toBe("API");
    expect(ui.barWindowDuration({ kind: "day" })).toBe("");
    expect(ui.barCountdown("2026-10-19T11:00:00Z")).toBe("0m");
    expect(ui.barCountdown("2026-10-21T14:00:00Z")).toBe("2d 2h");
    expect(ui.barWindowDuration({ windowMinutes: 43200, kind: "month" })).toBe("1mo");
    expect(ui.barWindowDuration({ windowMinutes: 90 })).toBe("90m");
    ui.payload.uiPreview = { menubarHidden: ["codex:jonas"] };
    expect(ui.buildStatusStripGroups()[0].lines).toEqual(["5h 99% · 7d 64%"]);
  });

  it("disambiguates identical initials and protects profile identities", () => {
    const ui = makeWidget();
    ui.hasLimits = true;
    ui.payload.limits = ["Evvi", "Evan"].map((label) => ({
      provider: "codex", accountKey: label, label,
      windows: [{ kind: "week", usedPct: 20 }],
    }));
    expect(ui.buildStatusStripGroups()[0].lines).toEqual(["EV1: 7d 80%", "EV2: 7d 80%"]);
    ui.privacyHideIdentities = true;
    const group = ui.buildStatusStripGroups()[0];
    expect(group.lines).toEqual(["P1: 7d 80%", "P2: 7d 80%"]);
    expect(group.profiles.map((profile: { name: string }) => profile.name)).toEqual(["P1", "P2"]);
  });

  it("compacts Cursor buckets, shares the billing period, and shows on-demand dollars", () => {
    const ui = makeWidget();
    ui.hasLimits = true;
    ui.payload.limits = [{ provider: "cursor", accountKey: "default", windows: [
      { kind: "Cursor Models", label: "Cursor Models", windowMinutes: 43200, usedPct: 63 },
      { kind: "Other Models", label: "Other Models", windowMinutes: 43200, usedPct: 1 },
      { kind: "On-Demand", label: "On-Demand", windowMinutes: 43200, usedPct: 0, amountUsd: 2.5 },
      { kind: "0min", usedPct: 0 },
      { kind: "month", windowMinutes: 0, usedPct: 0 },
    ] }];
    const group = ui.buildStatusStripGroups()[0];
    expect(group.lines).toEqual(["1mo 37% · API 99% · OD $2.50"]);
    expect(group.profiles[0].rows.map((row: { label: string; value: string }) => [row.label, row.value])).toEqual([
      ["1mo · Cursor Models", "37%"], ["1mo · Other Models", "99%"], ["1mo · On-Demand", "$2.50"],
    ]);
    ui.payload.limits[0].windows[2].amountUsd = 0;
    expect(ui.buildStatusStripGroups()[0].lines[0]).toContain("OD $0.00");
  });

  it("shortest-window mode keeps every selected account and chooses by duration", () => {
    const ui = makeWidget();
    ui.hasLimits = true;
    ui.barSummaryMode = "shortest-window";
    ui.payload.limits = [
      { provider: "codex", accountKey: "evvi", label: "Evvi", windows: [
        { kind: "day", scope: "session", windowMinutes: 300, usedPct: 60 },
        { kind: "week", windowMinutes: 10080, usedPct: 99 },
      ] },
      { provider: "codex", accountKey: "global", label: "Global", windows: [{ kind: "5h", usedPct: 90 }] },
      { provider: "cursor", accountKey: "work", windows: [
        { kind: "month", windowMinutes: 43200, usedPct: 63, label: "Cursor Models" },
        { kind: "month", windowMinutes: 43200, usedPct: 99, label: "Other Models" },
      ] },
    ];
    const all = ui.buildStatusStripGroups();
    const selected = ui.shortestWindowGroups(all);
    expect(selected.map((group: { provider: string }) => group.provider)).toEqual(["codex", "cursor"]);
    expect(selected[0].lines).toEqual(["EV: 5h 40%", "GL: 5h 10%"]);
    expect(selected[1].lines).toEqual(["30d 37%"]);
    expect(all[0].profiles[0].rows.map((row: { value: string }) => row.value)).toEqual(["40%", "1%"]);
    expect(all[1].profiles[0].rows).toHaveLength(2);
    expect(ui.barSummaryText()).toContain("EV: 5h 40% · GL: 5h 10%");
    expect(ui.barSummaryText()).not.toContain("7d");
    ui.barSummaryMode = "lowest-session";
    expect(ui.isShortestWindowMode()).toBe(true);
    expect(ui.barSummaryText()).toContain("30d 37%");
    ui.payload.uiPreview = { menubarHidden: ["codex:global"] };
    expect(ui.shortestWindowGroups(ui.buildStatusStripGroups())[0].lines).toEqual(["5h 40%"]);
    ui.payload.limits = [{ provider: "cursor", windows: [] }];
    expect(ui.shortestWindowGroups(ui.buildStatusStripGroups())[0].lines).toEqual(["—"]);
    expect(ui.shortestWindowGroups([])).toEqual([]);
  });

  it("keeps derived daily budget windows in shortest selection and hover details", () => {
    const ui = makeWidget();
    ui.hasLimits = true;
    ui.barSummaryMode = "shortest-window";
    const daily = {
      kind: "day", source: "derived", usedPct: 40,
      windowStart: "2026-10-22T00:00:00Z", windowEnd: "2026-10-23T00:00:00Z",
    };
    ui.payload.limits = [{ provider: "codex", accountKey: "work", windows: [
      { kind: "week", usedPct: 20 }, daily,
    ] }];
    expect(ui.windowOrderMinutes(daily)).toBe(1440);
    expect(ui.barWindowDuration(daily)).toBe("1d");
    const groups = ui.buildStatusStripGroups();
    expect(ui.shortestWindowGroups(groups)[0].lines).toEqual(["1d 60%"]);
    expect(groups[0].profiles[0].rows.map((row: { label: string }) => row.label)).toEqual(["1d", "7d"]);
    expect(ui.barWindowDuration({ ...daily, windowEnd: "invalid" })).toBe("");
    expect(ui.barWindowDuration({ ...daily, windowEnd: daily.windowStart })).toBe("");
    expect(ui.barWindowDuration({ kind: "0min", usedPct: 0 })).toBe("");
    expect(ui.barWindowDuration({ kind: "day", source: "embedded", usedPct: 40 })).toBe("");
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
  expect(context.buildSamples("2026-10-17")).toEqual(samples);
});

it("sparkline and day clock roll the 30-day window over at local midnight", () => {
  setSystemTime(new Date(2026, 9, 17, 23, 59, 30));
  const clock = createContext({ Date, Math, String });
  runInContext(functions(dayClock), clock);
  const beforeKey = clock.localDayKey(new Date());
  expect(beforeKey).toBe("2026-10-17");
  expect(clock.nextCheckInterval(new Date())).toBe(31_000);
  expect(clock.nextCheckInterval(new Date(2026, 9, 17, 12))).toBe(600_000);

  const context = createContext({ Date, history: { days: ["2026-10-17", "2026-10-18"], series: [{ values: [4, 9] }] } });
  runInContext(functions(sparkline), context);
  expect(context.buildSamples(beforeKey).slice(-2)).toEqual([0, 4]);

  setSystemTime(new Date(2026, 9, 18, 0, 0, 1));
  const afterKey = clock.localDayKey(new Date());
  expect(afterKey).toBe("2026-10-18");
  expect(context.buildSamples(afterKey).slice(-2)).toEqual([4, 9]);
});

it("activity grid cells fit both the available width and height", () => {
  const context = createContext({ Math });
  runInContext(functions(activityGrid), context);
  for (const width of [300, 420, 640, 900, 1280]) {
    const layout = { width, height: 58, columns: 53, rows: 7, columnSpacing: Math.min(2, Math.max(0, (width - 53) / 52)), rowSpacing: 2 };
    const cell = context.cellSize(layout);
    expect(layout.rows * cell + (layout.rows - 1) * layout.rowSpacing).toBeLessThanOrEqual(layout.height);
    expect(layout.columns * cell + (layout.columns - 1) * layout.columnSpacing).toBeLessThanOrEqual(width);
    expect(cell).toBeGreaterThan(0);
  }
  expect(context.cellSize({ width: 300, height: 58, columns: 0, rows: 7, columnSpacing: 2, rowSpacing: 2 })).toBe(0);
});

it("other machines card excludes the local machine and stale heartbeats", () => {
  const ui = makeWidget();
  const now: number = runInContext("Date.now()", ui);
  const machines = ui.otherActiveMachines([
    { machineId: "this-host", host: "this-host", ts: now, local: true },
    { machineId: "desktop", host: "desktop", ts: now - 60_000 },
    { machineId: "old", host: "old", ts: now - 3_600_000 },
  ]);
  expect(machines.map((machine: { machineId: string }) => machine.machineId)).toEqual(["desktop"]);
  expect(ui.otherActiveMachines(undefined)).toEqual([]);
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
