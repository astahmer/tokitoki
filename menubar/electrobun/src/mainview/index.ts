import { Electroview, type RPCSchema } from "electrobun/view";

import {
  accountExtraLines,
  accountTitle,
  accountVendor,
  ageLabel,
  formatCost,
  humanCount,
  barTone,
  dashboardUrl,
  donutArcs,
  escapeHtml,
  providerName,
  remainingPercent,
  resetLabel,
  sliceColor,
  tightestWindow,
  tokenCount,
  toolEntries,
  cardSetSpec,
  isLocalWindow,
  orderedAccounts,
  reorderQuotaAccounts,
  orderedTabs,
  popupTabIds,
  privateTitle,
  tabTitle,
  pollAuthStates,
  serviceIncidents,
  signInUrl,
  upstreamProvider,
  windowSummary,
  windowTitle,
  type QuotaAccount,
  type QuotaWindow,
  type ServiceIncident,
} from "./format.ts";
import {
  historyChart,
  joinCards,
  moveCard,
  orderedCards,
  reorderCards,
  shareMarkdown,
  trackingLines,
  traySummaryText,
  type HistoryBlock,
  type PanelCard,
  type PanelLayout,
} from "./panel.ts";
import { MCP_INTEGRATIONS, MCP_TOOLS, mcpIntegration } from "./mcp.ts";
import { activeTrackedSources, parseTrackedSources } from "./tracked-sources.ts";
import { parseAlertHistory, type AlertRecord } from "./settings-info.ts";
import type { MaskedApiKey } from "./api-keys.ts";
import { renderConversation } from "./conversation.ts";
import { glyph, tabGlyph } from "./icons.ts";
import { providerLogo } from "./logos.ts";
import {
  appendSessionEvents,
  cacheDurationText,
  eventClock,
  eventDetailLines,
  parseSessionDetail,
  parseSessionList,
  sessionClock,
  sessionSnippet,
  sessionStats,
  sessionTitle,
  type SessionDetailPage,
  type SessionEvent,
  type SessionListRow,
} from "./sessions.ts";

type AppRpc = {
  bun: RPCSchema<{
    requests: {
      loadPayload: { params: { cached: boolean }; response: { json: string } };
      loadSources: { params: Record<string, never>; response: { text: string } };
      loadSessions: { params: { query: string; page: number }; response: { json: string } };
      loadSession: { params: { provider: string; sessionId: string; offset: number }; response: { json: string } };
      reindexSessions: { params: Record<string, never>; response: { text: string } };
      loadSettingsInfo: { params: Record<string, never>; response: { configPath: string; alertsJson: string } };
      openConfig: { params: Record<string, never>; response: { ok: boolean; detail: string } };
      listApiKeys: { params: Record<string, never>; response: { json: string } };
      saveApiKey: { params: { id: string; label: string; provider: string; key: string }; response: { ok: boolean; detail: string } };
      removeApiKey: { params: { id: string; provider: string }; response: { ok: boolean; detail: string } };
      importCsv: { params: Record<string, never>; response: { ok: boolean; detail: string } };
      openDashboard: { params: { path: string }; response: { opened: boolean; detail: string; owned: boolean } };
      stopDashboard: { params: Record<string, never>; response: { detail: string; owned: boolean } };
      dashboardStatus: { params: Record<string, never>; response: { detail: string; owned: boolean } };
      // Not "apply": rpc.request is a function proxy, so that name is Function.prototype.apply.
      performAction: { params: { action: string; path?: string; value?: string; provider?: string; url?: string }; response: { ok: boolean; detail: string; authJson?: string } };
    };
    messages: {
      ready: { title: string };
      dismiss: { closed: boolean };
      summary: { text: string };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: Record<string, never>;
  }>;
};

interface MetricRow {
  bucket?: string;
  costUsd?: number;
  requests?: number;
  sessions?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  tokens?: number;
}

interface MetricReport {
  total?: MetricRow;
  rows?: MetricRow[];
}

interface PeriodBlock {
  key?: string;
  rows?: MetricRow[];
}

interface SessionRow {
  provider?: string;
  sessionId?: string;
  costUsd?: number;
  totalTokens?: number;
  requests?: number;
  lastRequestAt?: string;
  models?: string[];
  repos?: string[];
  cachePct?: number;
}

interface BudgetGauge {
  scope?: string;
  label?: string;
  used?: number;
  cap?: number;
  ratio?: number;
  state?: string;
  daysLeft?: number;
}

interface Anomaly {
  day?: string;
  metric?: string;
  value?: number;
  baseline?: number;
  ratio?: number;
}

interface ActivityCell {
  day?: string;
  tokens?: number;
}

interface TrackingPeriod {
  pricingCoveragePercent?: number;
  cachedInputPercent?: number;
  reportedTokens?: number;
  estimatedTokens?: number;
  unknownTokens?: number;
  unpricedModels?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  requests?: number;
  reportedRequests?: number;
  estimatedRequests?: number;
  unpricedRequests?: number;
  unknownRequests?: number;
  reportedTokens?: number;
  estimatedTokens?: number;
}

interface Payload {
  generatedAt?: string;
  stats?: { costUsd?: number; requests?: number; sessions?: number; tokens?: number; cachePct?: number };
  today?: MetricReport;
  limits?: QuotaAccount[];
  spendPeriods?: PeriodBlock[];
  modelPeriods?: PeriodBlock[];
  providerPeriods?: PeriodBlock[];
  reposMonth?: MetricReport;
  topTools?: { rows?: Array<{ tool?: string; costUsd?: number; requests?: number }>; tools?: Array<{ tool?: string; costUsd?: number; requests?: number }> } | Array<{ tool?: string; costUsd?: number }>;
  budgets?: BudgetGauge[];
  anomalies?: { anomalies?: Anomaly[] };
  spendHealth?: { state?: string; projected?: number; monthlyCap?: number; monthToDate?: number; perDay?: number; requests?: number };
  recentSessions?: { rows?: SessionRow[] };
  activityGrid?: { cells?: ActivityCell[] };
  history?: HistoryBlock;
  historyYear?: HistoryBlock;
  repoHistory?: HistoryBlock;
  blocks?: { rows?: Array<{ accountKey?: string; startIso?: string; endIso?: string; tokens?: number; costUsd?: number; requests?: number; isActive?: boolean }> };
  statuslinePreview?: { command?: string; preview?: string };
  t3codeActivity?: Array<{ key?: string; total?: MetricRow; rows?: MetricRow[] }>;
  trackingPeriods?: Record<string, TrackingPeriod>;
  presence?: Array<{ machine?: string; label?: string; lastSeen?: string }>;
  statusIncidents?: Record<string, { indicator?: string; description?: string; url?: string }>;
  providerRegistry?: Record<string, { vendor?: string }>;
  notifications?: {
    enabled?: boolean;
    resetAware?: boolean;
    quotaCriticalPercent?: number;
    burnWarnings?: boolean;
    burnWarningRatio?: number;
    disabledNotifications?: string[];
  };
  uiPreview?: {
    pollAuto?: boolean;
    pollIntervalMinutes?: number;
    pollAdaptive?: boolean;
    notificationsEnabled?: boolean;
    privacyHideIdentities?: boolean;
    previewEnabled?: boolean;
    previewLines?: number | string[];
    quotaResetNotifications?: boolean;
    burnWarningRatio?: number;
    disabledNotifications?: string[];
    cards?: Array<{ id?: string; hidden?: boolean }>;
    accountOrder?: string[];
    barAccountOrder?: string[];
    showHarnessVariants?: boolean;
    menubarHidden?: string[];
    tabs?: string[];
    syncBackend?: string;
    syncConfigured?: boolean;
    syncPath?: string;
    syncUrl?: string;
    syncHandle?: string;
    previewMode?: string;
    stripMetric?: string;
    stripExhausted?: string;
    previewHidden?: string[];
  };
}

const TOKEN_PERIODS = ["today", "yesterday", "week", "month", "year"];

const rpc = Electroview.defineRPC<AppRpc>({
  handlers: {
    requests: {},
    messages: {},
  },
});

const view = new Electroview({ rpc });
void view;

let payload: Payload | null = null;
let activeTab = "overview";
let mcpIntegrationId = "claude-desktop";
let tokenPeriod = "today";
let compositionSpan: "day" | "week" | "month" | "year" = "day";
let distributionMetric: "costUsd" | "tokens" = "costUsd";
let historySpan: "month" | "year" = "month";
let sourcesText = "";
let settingsConfigPath = "";
let settingsAlerts: AlertRecord[] = [];
let apiKeys: MaskedApiKey[] = [];
let apiKeyProvider = "opencode-go";
let apiKeyFormOpen = false;
let apiKeyNote = "";
let maintenanceNote = "";
let dashboardDetail = "";
let dashboardOwned = false;
let providerAuthStates: Record<string, string> = {};
let errorText = "";
let loading = true;
let refreshing = false;
let searchText = "";
let shareNote = "";
let layoutMode = false;
let collapsedAccounts = new Set<string>();
let detailAccounts = new Set<string>();
let sessionRows: SessionListRow[] = [];
let sessionPage = 1;
let sessionHasMore = false;
let sessionStatus = "";
let sessionLoading = false;
let sessionReindexing = false;
let sessionReindexNote = "";
let sessionGeneration = 0;
let sessionDetailGeneration = 0;
let sessionEventsLoading = false;
let sessionDetailRow: SessionListRow | null = null;
let sessionDetail: SessionDetailPage | null = null;
let sessionEvents: SessionEvent[] = [];
let selectedEventIndex: number | null = null;
let sessionSearchTimer: ReturnType<typeof setTimeout> | undefined;
let layout: PanelLayout = { hidden: [], order: [] };
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let lastCards: PanelCard[] = [];

let layoutFromStorage = false;

function readLayout(): PanelLayout {
  try {
    const raw = localStorage.getItem("tokitoki-panel-layout");
    if (raw === null) return { hidden: [], order: [] };
    layoutFromStorage = true;
    const parsed = JSON.parse(raw) as PanelLayout;
    const hidden = (parsed.hidden ?? []).filter((id) => !id.startsWith("account:"));
    const order = (parsed.order ?? []).filter((id) => !id.startsWith("account:"));
    return { hidden, order };
  } catch {
    return { hidden: [], order: [] };
  }
}

function saveLayout(): void {
  localStorage.setItem("tokitoki-panel-layout", JSON.stringify(layout));
}

function seedLayout(data: Payload): void {
  if (layoutFromStorage) return;
  if (layout.order.length > 0 || layout.hidden.length > 0) return;
  const saved = data.uiPreview?.cards ?? [];
  const order: string[] = [];
  const hidden: string[] = [];
  for (const entry of saved) {
    const id = entry.id ?? "";
    if (id.length === 0) continue;
    order.push(id);
    if (entry.hidden === true) hidden.push(id);
  }
  if (order.length === 0) return;
  layout = { order, hidden };
  layoutFromStorage = true;
}

function persistCards(): void {
  void applyAction({ action: "card-set", value: cardSetSpec(layout.order, layout.hidden) }, false);
}

layout = readLayout();

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing ${id}`);
  return found;
}

function periodRows(blocks: PeriodBlock[] | undefined, key: string): MetricRow[] {
  if (blocks === undefined) return [];
  for (const block of blocks) {
    if (block.key === key) return block.rows ?? [];
  }
  return [];
}

function toolRows(value: Payload["topTools"]): Array<{ tool?: string; costUsd?: number; requests?: number }> {
  return toolEntries(value);
}

function cardIcon(id: string): string {
  if (id === "spend") return "analytics";
  if (id === "usage" || id === "composition") return "pie";
  if (id === "tracking") return "check";
  if (id === "harness" || id === "models" || id === "upstream") return "chart";
  if (id === "history") return "analytics";
  return "";
}

function card(id: string, title: string, body: string, tone: "section" | "account" = "section", accountOrderId = ""): PanelCard {
  const controls = layoutMode && tone !== "account"
    ? `<span class="card-controls"><button type="button" data-move="-1" data-card-id="${escapeHtml(id)}">Up</button><button type="button" data-move="1" data-card-id="${escapeHtml(id)}">Down</button><button type="button" data-hide="${escapeHtml(id)}">Hide</button></span>`
    : "";
  const plain = body.replace(/<[^>]+>/g, " ");
  const accountAttribute = accountOrderId.length > 0 ? ` data-account-order="${escapeHtml(accountOrderId)}"` : "";
  const iconName = cardIcon(id);
  const icon = tone === "account" || iconName.length === 0 ? "" : glyph(iconName);
  const heading = tone === "account" ? "" : `<div class="card-title">${icon}<h2 class="grow">${escapeHtml(title)}</h2>${controls}</div>`;
  return {
    id,
    title,
    text: plain,
    html: `<section class="card${tone === "account" ? " account" : ""}" draggable="true" data-card="${escapeHtml(id)}"${accountAttribute}>${heading}${body}</section>`,
    accountOrderId: accountOrderId.length > 0 ? accountOrderId : undefined,
  };
}

function metricChips(): string {
  return `<div class="chips"><button type="button" data-metric="costUsd" class="${distributionMetric === "costUsd" ? "active" : ""}">Cost</button><button type="button" data-metric="tokens" class="${distributionMetric === "tokens" ? "active" : ""}">Tokens</button></div>`;
}

function shownCards(cards: PanelCard[]): string {
  lastCards = cards;
  const visible = orderedCards(cards, layout, searchText);
  if (visible.length === 0) return `<p class="muted">No matches</p>`;
  return joinCards(visible);
}

function tabOrder(cards: PanelCard[]): string[] {
  const ids: string[] = [];
  for (const card of cards) ids.push(card.id);
  const seeded: string[] = [];
  for (const id of layout.order) if (ids.includes(id) && !seeded.includes(id)) seeded.push(id);
  for (const id of ids) if (!seeded.includes(id)) seeded.push(id);
  return seeded;
}

function rememberOrder(next: string[], tabIds: string[]): void {
  const rest: string[] = [];
  for (const id of layout.order) if (!tabIds.includes(id) && !id.startsWith("account:")) rest.push(id);
  const stored: string[] = [];
  for (const id of next) if (!id.startsWith("account:")) stored.push(id);
  layout.order = rest.concat(stored);
  saveLayout();
}

function accountIdsOnTab(): string[] {
  const ids: string[] = [];
  for (const entry of lastCards) {
    if (entry.accountOrderId !== undefined && entry.accountOrderId.length > 0) ids.push(entry.accountOrderId);
  }
  return ids;
}

function accountOrderIdForCard(cardId: string): string {
  for (const entry of lastCards) {
    if (entry.id === cardId && entry.accountOrderId !== undefined) return entry.accountOrderId;
  }
  return "";
}

function persistAccountOrder(nextVisible: string[]): void {
  if (payload === null || nextVisible.length === 0) return;
  const saved = payload.uiPreview?.accountOrder ?? [];
  const accounts: string[] = [];
  for (const account of payload.limits ?? []) {
    const provider = account.provider ?? "";
    const accountKey = account.accountKey ?? "";
    if (provider.length === 0 || accountKey.length === 0) continue;
    const id = `${provider}@${accountKey}`;
    if (!accounts.includes(id)) accounts.push(id);
  }
  const update = reorderQuotaAccounts(nextVisible, saved, payload.uiPreview?.barAccountOrder, accounts);
  if (payload.uiPreview === undefined) payload.uiPreview = {};
  payload.uiPreview.accountOrder = update.quota;
  payload.uiPreview.barAccountOrder = update.bar;
  void applyAction({ action: "account-order", value: JSON.stringify({ quota: update.quota, bar: update.bar }) }, true);
}

function usageBar(used: number): string {
  const tone = barTone(used);
  const width = Math.max(0, Math.min(100, used));
  return `<div class="bar ${tone}"><span style="width:${width}%"></span></div>`;
}

function limitTone(remaining: number | undefined): string {
  if (remaining === undefined) return "blue";
  if (remaining < 20) return "critical";
  if (remaining < 50) return "warn";
  return "ok";
}

function resetCountdown(iso: string | undefined, now: number): string {
  if (iso === undefined || iso.length === 0) return "";
  const end = Date.parse(iso);
  if (!Number.isFinite(end)) return "";
  const delta = end - now;
  if (delta <= 0) return "now";
  const minutes = Math.max(1, Math.round(delta / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const hourRest = hours % 24;
  return hourRest === 0 ? `${days}d` : `${days}d ${hourRest}h`;
}

function paceLine(window: QuotaWindow): string {
  const pace = window.pace;
  if (pace === undefined) return "";
  if (pace.status === "over" && typeof pace.runsOutAt === "string" && pace.runsOutAt.length > 0) {
    const parsed = Date.parse(pace.runsOutAt);
    if (Number.isFinite(parsed)) {
      const date = new Date(parsed);
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      const clock = `${hours}:${minutes}`;
      const label = date.toDateString() === new Date().toDateString() ? clock : `${days[date.getDay()]} ${clock}`;
      return `Runs out ~${label}`;
    }
  }
  if (pace.status === "over") return "Over pace";
  if (pace.status === "under") return "Under pace";
  if (pace.status === "on" || pace.status === "even") return "On pace";
  return "";
}

function paceMarker(window: QuotaWindow): number {
  const expected = window.pace?.expectedPercent;
  if (window.pace === undefined || expected === undefined || !Number.isFinite(expected)) return -1;
  if (window.status !== undefined && window.status.length > 0 && window.status !== "current") return -1;
  return Math.max(0, Math.min(1, 1 - expected / 100));
}

function windowLine(window: QuotaWindow, now: number): string {
  const title = escapeHtml(windowTitle(window));
  const summary = windowSummary(window, now);
  const current = window.status === undefined || window.status.length === 0 || window.status === "current";
  const remaining = current && summary.usedPercent !== undefined ? Math.max(0, Math.min(100, 100 - summary.usedPercent)) : undefined;
  const hasPercent = remaining !== undefined;
  const tone = hasPercent ? limitTone(remaining) : "muted";
  const reported = window.source === "embedded" || window.source === "provider";
  let sourceText = "";
  let value = "Usage unknown";
  if (!current) {
    const seen = ageLabel(window.observedAt, now);
    const observed = seen === "—" ? "Observation time unknown" : seen === "just now" ? "Observed just now" : `Observed ${seen}`;
    value = `${window.status ?? "unknown"} · ${observed}`;
  } else if (typeof window.amountUsd === "number") {
    sourceText = reported ? "Reported" : "Estimated";
    value = formatCost(window.amountUsd);
  } else if (hasPercent) {
    sourceText = reported ? "Reported" : "Estimated";
    value = `${Math.round(remaining)}% left`;
  } else if (isLocalWindow(window) && (window.cost ?? 0) > 0) {
    sourceText = "Estimated";
    value = formatCost(window.cost ?? 0);
  } else if ((window.tokens ?? 0) > 0) {
    sourceText = "Estimated";
    value = `${humanCount(window.tokens ?? 0)} tokens`;
  }
  const width = hasPercent ? remaining : 0;
  const pace = current ? paceLine(window) : "";
  const paceClass = pace.startsWith("Runs out") || pace === "Over pace" ? "warn" : "";
  let resetText = "";
  if (!current) resetText = "Awaiting fresh observation";
  else {
    const reset = resetCountdown(window.resetsAt ?? window.windowEnd, now);
    if (reset.length > 0 && reset !== "now") resetText = `Resets in ${reset}`;
  }
  const marker = paceMarker(window);
  const markerHtml = marker < 0 ? "" : `<i class="pace-marker" style="left:${(marker * 100).toFixed(1)}%"></i>`;
  const sourceHtml = sourceText.length === 0 ? "" : `<span class="quota-source">${escapeHtml(sourceText)}</span>`;
  const footer = pace.length === 0 && resetText.length === 0 ? "" : `<div class="row quota-meta"><span class="grow pace ${paceClass}">${escapeHtml(pace)}</span><span class="reset">${escapeHtml(resetText)}</span></div>`;
  const localCompact = isLocalWindow(window) && !hasPercent;
  if (localCompact) {
    return `<div class="quota-window compact"><div class="row quota-meta"><span class="grow quota-name">${title}</span>${sourceHtml}<span class="quota-value ${tone}">${escapeHtml(value)}</span></div></div>`;
  }
  return `<div class="quota-window">
    <div class="row quota-meta"><span class="grow quota-name">${title}</span>${sourceHtml}<span class="quota-value ${tone}">${escapeHtml(value)}</span></div>
    <div class="quota-track"><span class="${tone}" style="width:${width}%"></span>${markerHtml}</div>
    ${footer}
  </div>`;
}

function donut(rows: MetricRow[], metric: "costUsd" | "tokens", centerCaption = ""): string {
  const ranked: Array<{ name: string; value: number; color: string }> = [];
  const limited = rows.slice(0, 8);
  for (let index = 0; index < limited.length; index += 1) {
    const row = limited[index];
    if (row === undefined) continue;
    const value = metric === "tokens" ? tokenCount(row) : (row.costUsd ?? 0);
    if (value <= 0) continue;
    ranked.push({ name: providerName(row.bucket ?? ""), value, color: sliceColor(index) });
  }
  ranked.sort((left, right) => right.value - left.value);
  const shown = ranked.slice(0, 6);
  const values: number[] = [];
  for (const entry of shown) values.push(entry.value);
  const arcs = donutArcs(values);
  let total = 0;
  for (const value of values) total += value;
  const circles: string[] = [];
  for (let index = 0; index < arcs.length; index += 1) {
    const arc = arcs[index];
    const entry = shown[index];
    if (arc === undefined || entry === undefined) continue;
    circles.push(`<circle cx="21" cy="21" r="15.9155" stroke="${entry.color}" stroke-dasharray="${arc.portion} ${100 - arc.portion}" stroke-dashoffset="${-arc.offset}" />`);
  }
  const legend: string[] = [];
  for (const entry of shown) {
    const shownValue = metric === "tokens" ? humanCount(entry.value) : formatCost(entry.value);
    legend.push(`<div class="row"><span class="swatch" style="background:${entry.color}"></span><span class="grow">${escapeHtml(entry.name)}</span><span class="muted">${escapeHtml(shownValue)}</span></div>`);
  }
  const center = metric === "tokens" ? humanCount(total) : formatCost(total);
  const caption = centerCaption.length === 0 ? "" : `<div class="tiny">${escapeHtml(centerCaption)}</div>`;
  return `<div class="split">
    <div class="donut-wrap">
      <svg class="donut" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.9155" stroke="#3a3a3a" />
        <g transform="rotate(-90 21 21)">${circles.join("")}</g>
      </svg>
      <div class="donut-center"><div class="strong">${escapeHtml(center)}</div>${caption}</div>
    </div>
    <div class="legend grow">${legend.join("")}</div>
  </div>`;
}

function rememberAuthStates(json: string, provider: string | undefined): void {
  const states = pollAuthStates(json);
  if (provider === undefined || provider.length === 0) {
    providerAuthStates = states;
    return;
  }
  const next: Record<string, string> = {};
  for (const key of Object.keys(providerAuthStates)) {
    if (key !== provider) next[key] = providerAuthStates[key] ?? "";
  }
  for (const key of Object.keys(states)) next[key] = states[key] ?? "";
  if (states[provider] === undefined) delete next[provider];
  providerAuthStates = next;
}

function authStateRow(provider: string): string {
  const state = providerAuthStates[provider];
  if (state !== "login-required" && state !== "api-key-required" && state !== "temporarily-unavailable") return "";
  let title = "Login required";
  let action = "Open sign-in";
  let kind = "login";
  if (state === "api-key-required") {
    title = "API key required";
    action = "Manage keys";
    kind = "api-key";
  } else if (state === "temporarily-unavailable") {
    title = "Provider unavailable";
    action = "Try again";
    kind = "retry";
  } else if (provider === "cursor") action = "Open Cursor sign-in";
  else if (provider === "claude-code") action = "Open Claude Code";
  else if (provider === "codex") action = "Sign in to Codex";
  else if (provider === "copilot") action = "Open GitHub login";
  return `<div class="row auth-row"><span class="grow">${escapeHtml(title)}</span><button type="button" data-auth="${kind}" data-provider="${escapeHtml(provider)}">${escapeHtml(action)}</button></div>`;
}

function accountIdentity(account: QuotaAccount): string {
  return `${account.provider ?? "account"}:${account.accountKey ?? accountTitle(account)}`;
}

function visibleAccountTitle(account: QuotaAccount): string {
  const hide = payload?.uiPreview?.privacyHideIdentities === true;
  return privateTitle(accountTitle(account), hide);
}

function incidentLine(account: QuotaAccount, incidents: ServiceIncident[], registry: Payload["providerRegistry"]): string {
  const vendor = accountVendor(account.provider ?? "", registry);
  let incident: ServiceIncident | undefined;
  for (const item of incidents) {
    if (item.vendor === vendor) incident = item;
  }
  if (incident === undefined) return "";
  const severe = incident.indicator === "major" || incident.indicator === "critical" ? " severe" : "";
  const link = incident.url.length > 0 ? `<button type="button" data-open="${escapeHtml(incident.url)}">Status</button>` : "";
  return `<div class="row incident-row${severe}"><span class="grow">${escapeHtml(incident.indicator)} · ${escapeHtml(incident.description)}</span>${link}</div>`;
}

function extraLines(account: QuotaAccount, now: number): string {
  const lines = accountExtraLines(account, now);
  if (lines.length === 0) return "";
  const rows: string[] = [];
  for (const line of lines) {
    const icon = line.includes("banked") ? "repeat" : line.startsWith("Extra") ? "card" : line.startsWith("Balance") ? "wallet" : "toll";
    const tone = line.includes("banked") ? " info" : "";
    rows.push(`<div class="extra-row${tone}">${glyph(icon)}<span>${escapeHtml(line)}</span></div>`);
  }
  return rows.join("");
}

function accountCard(account: QuotaAccount, now: number, incidents: ServiceIncident[], registry: Payload["providerRegistry"]): PanelCard {
  const id = `account:${accountIdentity(account)}`;
  const plan = account.plan ?? account.planLabel ?? "";
  const collapsed = collapsedAccounts.has(id);
  const detailsOpen = detailAccounts.has(id);
  const provider = account.provider ?? "";
  const accountKey = account.accountKey ?? "";
  const orderId = accountKey.length > 0 ? `${provider}@${accountKey}` : "";
  const freshness = account.freshness ?? "";
  const signIn = signInUrl(provider);
  const hideTarget = `${provider}:${account.accountKey ?? ""}`;
  const hideIdentities = payload?.uiPreview?.privacyHideIdentities === true;
  const subtitle = accountKey.length > 0 ? `<span class="account-key">${escapeHtml(privateTitle(accountKey, hideIdentities))}</span>` : "";
  const logo = providerLogo(provider);
  const logoMarkup = logo.length > 0 ? logo : `<span class="logo">${glyph("hub")}</span>`;
  const planPill = plan.length > 0 ? `<span class="plan-pill">${escapeHtml(plan.toUpperCase())}</span>` : "";
  const hideButton = hideTarget.length > provider.length + 1 ? `<button type="button" class="icon-button" data-hide-account="${escapeHtml(hideTarget)}" title="Hide account">${glyph("hide")}</button>` : "";
  const layoutButtons = layoutMode
    ? `<span class="card-controls"><button type="button" data-move="-1" data-card-id="${escapeHtml(id)}">Up</button><button type="button" data-move="1" data-card-id="${escapeHtml(id)}">Down</button></span>`
    : "";
  const heading = `<div class="account-head"><button type="button" class="icon-button" data-account="${escapeHtml(id)}" title="${collapsed ? "Show" : "Hide"}">${glyph(collapsed ? "chevron" : "expand")}</button>${logoMarkup}<span class="grow account-identity"><span class="account-name">${escapeHtml(visibleAccountTitle(account))}</span>${subtitle}</span><button type="button" class="icon-button" data-poll="${escapeHtml(provider)}" title="Refresh quota">${glyph("refresh")}</button>${hideButton}${planPill}${layoutButtons}</div>${authStateRow(provider)}${incidentLine(account, incidents, registry)}`;
  if (collapsed) return card(id, visibleAccountTitle(account), heading, "account", orderId);
  const providerWindows: QuotaWindow[] = [];
  const localWindows: QuotaWindow[] = [];
  for (const window of account.windows ?? []) {
    if (isLocalWindow(window)) localWindows.push(window);
    else providerWindows.push(window);
  }
  for (const window of account.budgetWindows ?? []) localWindows.push(window);
  const lines: string[] = [heading];
  if (providerWindows.length === 0) lines.push(`<p class="muted">No provider quota reported</p>`);
  for (const window of providerWindows) lines.push(windowLine(window, now));
  for (const window of localWindows) {
    if (window.usedPct === undefined && window.usedPercent === undefined && window.amountUsd === undefined) continue;
    lines.push(windowLine(window, now));
  }
  const extras = extraLines(account, now);
  if (extras.length > 0) lines.push(extras);
  lines.push(`<button type="button" class="text-button" data-details="${escapeHtml(id)}">${detailsOpen ? "Hide details" : "Details · source and reset dates"}</button>`);
  if (detailsOpen) {
    const origin = account.origin ?? "unknown";
    const observed = account.observedAt ?? "";
    lines.push(`<p class="tiny">source: ${escapeHtml(origin)}</p>`);
    if (observed.length > 0) lines.push(`<p class="tiny">last observed ${escapeHtml(observed.replace("T", " ").slice(0, 16))}${freshness === "stale" ? " · stale" : ""}</p>`);
    if (signIn !== undefined) lines.push(`<button type="button" class="text-button" data-open="${escapeHtml(signIn)}">Open sign-in</button>`);
    for (const window of providerWindows) {
      const reset = window.resetsAt ?? "";
      lines.push(`<div class="row"><span class="grow tiny">${escapeHtml(windowTitle(window))}</span><span class="tiny">${reset.length > 0 ? escapeHtml(reset.replace("T", " ").slice(0, 16)) : "—"}</span></div>`);
    }
  }
  return card(id, visibleAccountTitle(account), lines.join(""), "account", orderId);
}

function attention(accounts: QuotaAccount[], now: number): string {
  const lines: string[] = [];
  for (const account of accounts) {
    const window = tightestWindow(account);
    if (window === undefined) continue;
    const remaining = remainingPercent(window);
    if (remaining === undefined || remaining > 10) continue;
    const reset = resetLabel(window.resetsAt, now);
    const timing = reset === "now" ? "available now" : `resets in ${reset}`;
    lines.push(`<div class="row"><span class="grow">${escapeHtml(accountTitle(account))}</span><span class="muted">${escapeHtml(windowTitle(window))} · ${Math.round(remaining)}% left · ${escapeHtml(timing)}</span></div>`);
    if (lines.length === 3) break;
  }
  if (lines.length === 0) return "";
  return `<section class="attention"><h2 class="section-label">Needs attention</h2>${lines.join("")}</section>`;
}

function heatmap(cells: ActivityCell[] | undefined): string {
  if (cells === undefined || cells.length === 0) return `<p class="muted">No daily activity yet</p>`;
  const recent = cells.slice(-140);
  let max = 0;
  for (const cell of recent) max = Math.max(max, cell.tokens ?? 0);
  const squares: string[] = [];
  for (const cell of recent) {
    const tokens = cell.tokens ?? 0;
    const alpha = max <= 0 ? 0.08 : 0.12 + (0.88 * tokens) / max;
    squares.push(`<span class="cell" style="opacity:${alpha.toFixed(3)}" title="${escapeHtml(cell.day ?? "")}"></span>`);
  }
  return `<div class="grid">${squares.join("")}</div>`;
}

function periodChips(): string {
  const labels: Record<string, string> = { today: "Today", yesterday: "Yest", week: "Week", month: "Month", year: "Year" };
  const chips: string[] = [];
  for (const period of TOKEN_PERIODS) {
    chips.push(`<button type="button" data-period="${period}" class="${period === tokenPeriod ? "active" : ""}">${labels[period] ?? period}</button>`);
  }
  return `<div class="chips">${chips.join("")}</div>`;
}

function compositionRangeTitle(span: string): string {
  if (span === "week") return "7 days";
  if (span === "month") return "30 days";
  if (span === "year") return "1 year";
  return "last 24h";
}

function compositionChips(): string {
  const choices: Array<["day" | "week" | "month" | "year", string]> = [["day", "1 day"], ["week", "7 days"], ["month", "30 days"], ["year", "1 year"]];
  const chips: string[] = [];
  for (const choice of choices) {
    chips.push(`<button type="button" data-composition="${choice[0]}" class="${compositionSpan === choice[0] ? "active" : ""}">${choice[1]}</button>`);
  }
  return `<div class="chips">${chips.join("")}</div>`;
}

function controlRow(leading: string, trailing: string): string {
  return `<div class="chip-row">${leading}${trailing}</div>`;
}

function browserBar(): string {
  return `<div class="browser-bar">${glyph("language")}<button type="button" class="text-button grow" data-dashboard="/">Browser dashboard</button><button type="button" class="chip" data-dashboard="/?view=reports&amp;last=month">Reports</button><button type="button" class="chip" data-dashboard="/?view=sources">Sources</button></div>`;
}

function joinVisible(cards: PanelCard[]): string {
  const visible = orderedCards(cards, { hidden: layout.hidden, order: [] }, searchText);
  if (visible.length === 0) return "";
  return joinCards(visible);
}

function historyChips(): string {
  return `<div class="chips"><button type="button" data-history="month" class="${historySpan === "month" ? "active" : ""}">28 days</button><button type="button" data-history="year" class="${historySpan === "year" ? "active" : ""}">year</button></div>`;
}

function activityToday(data: Payload): string {
  const todayCost = data.today?.total?.costUsd ?? data.stats?.costUsd ?? 0;
  const requests = data.today?.total?.requests ?? data.stats?.requests ?? 0;
  const weekRows = periodRows(data.spendPeriods, "week");
  let weekCost = 0;
  for (const row of weekRows) weekCost += row.costUsd ?? 0;
  const health = data.spendHealth;
  return `<div class="hero-card"><div><div class="hero">${escapeHtml(formatCost(todayCost))}</div><div class="muted">${escapeHtml(humanCount(requests))} requests</div></div><div class="hero-side"><div><div class="tiny">this week</div><div class="strong">${escapeHtml(formatCost(weekCost))}</div></div><div><div class="tiny">month to date</div><div class="strong">${escapeHtml(formatCost(health?.monthToDate ?? 0))}</div></div><div><div class="tiny">burn · projected</div><div class="strong">${escapeHtml(formatCost(health?.perDay ?? 0))} → ${escapeHtml(formatCost(health?.projected ?? 0))}</div></div></div></div>`;
}

function harnessRows(rows: MetricRow[]): string {
  if (rows.length === 0) return `<p class="muted">No harness usage recorded</p>`;
  const lines: string[] = [];
  for (const row of rows.slice(0, 7)) {
    lines.push(`<div class="row"><span class="grow">${escapeHtml(providerName(row.bucket ?? ""))}</span><span class="tiny">${escapeHtml(humanCount(row.requests ?? 0))} req</span><span class="muted">${escapeHtml(formatCost(row.costUsd ?? 0))}</span></div>`);
  }
  return lines.join("");
}

function visibleAccounts(data: Payload): QuotaAccount[] {
  return orderedAccounts(data.limits ?? [], data.uiPreview?.accountOrder ?? [], data.uiPreview?.menubarHidden ?? []);
}

function renderOverview(data: Payload, now: number): string {
  const accounts = visibleAccounts(data);
  const todayRows = data.today?.rows ?? [];
  const distributionRows = periodRows(data.spendPeriods, tokenPeriod);
  const tools = toolRows(data.topTools);
  const incidents = serviceIncidents(data.statusIncidents);
  const accountCards: PanelCard[] = [];
  if (accounts.length === 0) accountCards.push(card("limits-empty", "Usage limits", `<p class="muted">No quota accounts yet</p>`));
  for (const account of accounts) accountCards.push(accountCard(account, now, incidents, data.providerRegistry));
  const otherCards: PanelCard[] = [];
  otherCards.push(card("spend", "Activity today", activityToday(data)));
  const distributionCaption = distributionMetric === "tokens" ? "Tokens" : "Cost";
  otherCards.push(card("usage", "Usage distribution", `${controlRow(periodChips(), metricChips())}${distributionRows.length === 0 ? `<p class="muted">No usage recorded for this period</p>` : donut(distributionRows, distributionMetric, distributionCaption)}`));
  if (todayRows.length > 0) otherCards.push(card("harness", "Today by harness", harnessRows(todayRows)));
  const anomaly = data.anomalies?.anomalies?.[0];
  if (anomaly !== undefined) {
    const ratio = anomaly.ratio === undefined ? "" : `${anomaly.ratio.toFixed(1)}×`;
    otherCards.push(card("anomalies", "Anomalies", `<div class="row"><span class="grow">${escapeHtml(anomaly.day ?? "")}</span><span class="muted">${escapeHtml(ratio)} ${escapeHtml(anomaly.metric ?? "")}</span></div>`));
  }
  const repoLines: string[] = [];
  for (const row of (data.reposMonth?.rows ?? []).slice(0, 5)) {
    repoLines.push(`<div class="row"><span class="grow">${escapeHtml(row.bucket ?? "")}</span><span class="muted">${escapeHtml(formatCost(row.costUsd ?? 0))}</span></div>`);
  }
  if (repoLines.length > 0) otherCards.push(card("repos", "Top repos", repoLines.join("")));
  if (tools.length > 0) {
    const lines: string[] = [];
    for (const tool of tools.slice(0, 5)) {
      lines.push(`<div class="row"><span class="grow">${escapeHtml(tool.tool ?? "tool")}</span><span class="muted">${escapeHtml(formatCost(tool.costUsd ?? 0))}</span></div>`);
    }
    otherCards.push(card("tools", "Top tools today", lines.join("")));
  }
  lastCards = accountCards.concat(otherCards);
  const attentionBlock = attention(accounts, now);
  return browserBar() + joinVisible(accountCards) + attentionBlock + joinVisible(otherCards);
}

function renderQuotas(data: Payload, now: number): string {
  const accounts = visibleAccounts(data);
  if (accounts.length === 0) return shownCards([card("quotas-empty", "Quotas", `<p class="muted">No quota accounts detected. Enable polling or scan a provider.</p>`)]);
  const cards: PanelCard[] = [];
  const incidents = serviceIncidents(data.statusIncidents);
  for (const account of accounts) cards.push(accountCard(account, now, incidents, data.providerRegistry));
  return shownCards(cards);
}

function percentLabel(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unavailable";
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function compositionDonut(period: TrackingPeriod | undefined): string {
  if (period === undefined) return `<p class="muted">No token composition for this range</p>`;
  const rows: MetricRow[] = [
    { bucket: "Input", tokens: period.inputTokens ?? 0 },
    { bucket: "Output", tokens: period.outputTokens ?? 0 },
    { bucket: "Cache read", tokens: period.cacheReadTokens ?? 0 },
    { bucket: "Cache write", tokens: period.cacheWriteTokens ?? 0 },
  ];
  const present: MetricRow[] = [];
  for (const row of rows) if ((row.tokens ?? 0) > 0) present.push(row);
  if (present.length === 0) return `<p class="muted">No token composition for this range</p>`;
  return donut(present, "tokens", "Tokens");
}

function trackingProse(period: TrackingPeriod | undefined): string {
  if (period === undefined || typeof period.requests !== "number") return trackingLines(period);
  const lines = [
    `${humanCount(period.totalTokens ?? 0)} tokens · ${humanCount(period.requests)} requests`,
    `Pricing coverage: ${percentLabel(period.pricingCoveragePercent)} · Cached input: ${percentLabel(period.cachedInputPercent)}`,
    `Cost sources: ${humanCount(period.reportedRequests ?? 0)} reported · ${humanCount(period.estimatedRequests ?? 0)} estimated · ${humanCount(period.unpricedRequests ?? 0)} unpriced · ${humanCount(period.unknownRequests ?? 0)} unknown`,
  ];
  if (typeof period.reportedTokens === "number") {
    lines.push(`Token counts: ${humanCount(period.reportedTokens)} reported · ${humanCount(period.estimatedTokens ?? 0)} estimated`);
  }
  if (typeof period.costUsd === "number") lines.push(`Known usage value: ${formatCost(period.costUsd)}`);
  const markup: string[] = [];
  for (const line of lines) markup.push(`<p class="tracking-line">${escapeHtml(line)}</p>`);
  return markup.join("");
}

function renderTokens(data: Payload): string {
  const rows = periodRows(data.spendPeriods, tokenPeriod);
  const models = periodRows(data.modelPeriods, tokenPeriod).slice(0, 8);
  const modelLines: string[] = [];
  for (const row of models) {
    const amount = distributionMetric === "costUsd" ? formatCost(row.costUsd ?? 0) : humanCount(tokenCount(row));
    modelLines.push(`<div class="row"><span class="grow">${escapeHtml(row.bucket ?? "")}</span><span class="muted">${escapeHtml(amount)}</span></div>`);
  }
  const upstream = periodRows(data.providerPeriods, tokenPeriod).slice(0, 8);
  const upstreamLines: string[] = [];
  for (const row of upstream) {
    const amount = distributionMetric === "costUsd" ? formatCost(row.costUsd ?? 0) : humanCount(tokenCount(row));
    upstreamLines.push(`<div class="row"><span class="grow">${escapeHtml(providerName(row.bucket ?? ""))}</span><span class="muted">${escapeHtml(amount)}</span></div>`);
  }
  let t3: { total?: MetricRow; rows?: MetricRow[] } | undefined;
  for (const block of data.t3codeActivity ?? []) if (block.key === tokenPeriod) t3 = block;
  const t3Tokens = t3?.total !== undefined ? tokenCount(t3.total) : 0;
  const history = historySpan === "year" ? data.historyYear : data.history;
  const tracking = data.trackingPeriods?.[compositionSpan];
  const range = compositionRangeTitle(compositionSpan);
  const caption = distributionMetric === "tokens" ? "Tokens" : "Cost";
  const cards: PanelCard[] = [
    card("usage", "Usage distribution", `${controlRow(periodChips(), metricChips())}${rows.length === 0 ? `<p class="muted">No usage recorded for this period</p>` : donut(rows, distributionMetric, caption)}`),
    card("composition", `Token composition · ${range}`, `${compositionChips()}${compositionDonut(tracking)}`),
    card("tracking", `Tracking quality · ${range}`, trackingProse(tracking)),
    card("upstream", "Upstream providers", upstreamLines.length === 0 ? `<p class="muted">No upstream breakdown</p>` : upstreamLines.join("")),
    card("models", "By model", modelLines.length === 0 ? `<p class="muted">No model breakdown</p>` : modelLines.join("")),
    card("history", "Usage history", `${historyChips()}${historyChart(history, 4)}`),
  ];
  if (t3Tokens > 0) cards.push(card("t3code", "Via T3 Code", `<div class="hero">${escapeHtml(humanCount(t3Tokens))}</div><p class="muted">${escapeHtml(formatCost(t3?.total?.costUsd ?? 0))}</p>`));
  return shownCards(cards);
}

function renderReports(data: Payload): string {
  const health = data.spendHealth;
  const healthText = health === undefined
    ? `<p class="muted">No spend pace yet</p>`
    : `<div class="row"><span class="grow">month to date</span><span class="muted">${escapeHtml(formatCost(health.monthToDate ?? 0))}</span></div><div class="row"><span class="grow">per day</span><span class="muted">${escapeHtml(formatCost(health.perDay ?? 0))}</span></div><div class="row"><span class="grow">projected</span><span class="muted">${escapeHtml(formatCost(health.projected ?? 0))}${health.monthlyCap !== undefined ? " / " + escapeHtml(formatCost(health.monthlyCap)) : ""}</span></div><div class="row"><span class="grow">${escapeHtml(health.state ?? "ok")}</span><span class="muted">${escapeHtml(humanCount(health.requests ?? 0))} requests</span></div>`;
  const budgetLines: string[] = [];
  for (const gauge of data.budgets ?? []) {
    const ratio = Math.round((gauge.ratio ?? 0) * 100);
    budgetLines.push(`<div><div class="row"><span class="grow">${escapeHtml(gauge.label ?? gauge.scope ?? "budget")}</span><span class="muted">${escapeHtml(formatCost(gauge.used ?? 0))} / ${escapeHtml(formatCost(gauge.cap ?? 0))}</span></div>${usageBar(ratio)}</div>`);
  }
  const anomalyLines: string[] = [];
  for (const anomaly of data.anomalies?.anomalies ?? []) {
    const ratio = anomaly.ratio === undefined ? "" : `${anomaly.ratio.toFixed(1)}×`;
    anomalyLines.push(`<div class="row"><span class="grow">${escapeHtml(anomaly.day ?? "")}</span><span class="muted">${escapeHtml(ratio)} ${escapeHtml(anomaly.metric ?? "")}</span></div>`);
  }
  const repoLines: string[] = [];
  for (const row of (data.reposMonth?.rows ?? []).slice(0, 12)) {
    const amount = distributionMetric === "tokens" ? humanCount(tokenCount(row)) : formatCost(row.costUsd ?? 0);
    repoLines.push(`<div class="row"><span class="grow">${escapeHtml(row.bucket ?? "")}</span><span class="muted">${escapeHtml(amount)}</span></div>`);
  }
  const blockLines: string[] = [];
  for (const block of data.blocks?.rows ?? []) {
    const state = block.isActive === true ? "active" : "closed";
    blockLines.push(`<div class="row"><span class="grow">${escapeHtml(block.startIso ?? "")}</span><span class="muted">${escapeHtml(state)} · ${escapeHtml(formatCost(block.costUsd ?? 0))}</span></div>`);
  }
  const incidentLines: string[] = [];
  for (const incident of serviceIncidents(data.statusIncidents)) {
    const link = incident.url.length > 0 ? `<button type="button" data-open="${escapeHtml(incident.url)}">Status</button>` : "";
    incidentLines.push(`<div class="row"><span class="grow">${escapeHtml(incident.vendor)} · ${escapeHtml(incident.indicator)}</span>${link}</div><p class="tiny">${escapeHtml(incident.description)}</p>`);
  }
  const machineLines: string[] = [];
  for (const machine of data.presence ?? []) {
    machineLines.push(`<div class="row"><span class="grow">${escapeHtml(machine.label ?? machine.machine ?? "machine")}</span><span class="muted">${escapeHtml(machine.lastSeen ?? "")}</span></div>`);
  }
  const preview = data.statuslinePreview?.preview ?? "";
  const tools = toolRows(data.topTools);
  const toolLines: string[] = [];
  for (const tool of tools.slice(0, 5)) {
    toolLines.push(`<div class="row"><span class="grow">${escapeHtml(tool.tool ?? "tool")}</span><span class="muted">${escapeHtml(formatCost(tool.costUsd ?? 0))}</span></div>`);
  }
  const cards: PanelCard[] = [card("spend", "activity today", activityToday(data))];
  const cells = data.activityGrid?.cells ?? [];
  if (cells.length > 0) cards.push(card("activity", "activity · last year", heatmap(cells)));
  if (repoLines.length > 0) cards.push(card("repos", "top repos this month", `${metricChips()}${repoLines.join("")}`));
  const repoSeries = data.repoHistory?.series ?? [];
  if (repoSeries.length > 0) cards.push(card("repo-history", "repo activity · 30 days", historyChart(data.repoHistory, 4)));
  if (blockLines.length > 0) cards.push(card("blocks", "billing blocks", blockLines.join("")));
  if (preview.length > 0) cards.push(card("statusline", "statusline preview", `<p>${escapeHtml(preview)}</p><p class="tiny">${escapeHtml(data.statuslinePreview?.command ?? "")}</p>`));
  if (toolLines.length > 0) cards.push(card("tools", "top tools today", toolLines.join("")));
  if (anomalyLines.length > 0) cards.push(card("anomalies", "anomalies", anomalyLines.join("")));
  if (budgetLines.length > 0) cards.push(card("budgets", "budget status", budgetLines.join("")));
  if (incidentLines.length > 0) cards.push(card("alerts", "service alerts", incidentLines.join("")));
  if (machineLines.length > 0) cards.push(card("machines", "other machines", machineLines.join("")));
  if (health !== undefined) cards.splice(1, 0, card("pace", "spend pace", healthText));
  return shownCards(cards);
}

function renderTimeline(): string {
  let maximum = 1;
  for (const event of sessionEvents) {
    if (event.tokens > maximum) maximum = event.tokens;
  }
  const selected = selectedEventIndex === null ? undefined : sessionEvents[selectedEventIndex];
  const detail = selected === undefined
    ? `<div id="timeline-detail" class="timeline-detail" hidden></div>`
    : `<div id="timeline-detail" class="timeline-detail">${timelineDetailMarkup(selected)}</div>`;
  const bars: string[] = [];
  const rows: string[] = [];
  for (let index = 0; index < sessionEvents.length; index += 1) {
    const event = sessionEvents[index];
    if (event === undefined) continue;
    const height = Math.max(3, Math.round((54 * event.tokens) / maximum));
    const active = selectedEventIndex === index ? " active" : "";
    bars.push(`<button type="button" class="timeline-bar${active}" data-event-index="${index}" style="height:${height}px"></button>`);
    rows.push(`<div class="row timeline-row"><span class="timeline-n">${event.n}</span><span class="tiny">${escapeHtml(eventClock(event.ts))}</span><span class="grow tiny">${escapeHtml(event.model)}</span><span class="tiny">${escapeHtml(`${humanCount(event.runningTokens)} · ${formatCost(event.costUsd)}`)}</span></div>`);
  }
  return `${detail}<div class="timeline">${bars.join("")}</div>${rows.join("")}`;
}

function timelineDetailMarkup(event: SessionEvent): string {
  const lines = eventDetailLines(event);
  return `<div class="strong">${escapeHtml(lines.heading)}</div><div>${escapeHtml(lines.description)}</div><div class="tiny">${escapeHtml(lines.meta)}</div>`;
}

function showTimelineDetail(index: number): void {
  const event = sessionEvents[index];
  const box = document.getElementById("timeline-detail");
  if (event === undefined || box === null) return;
  selectedEventIndex = index;
  box.hidden = false;
  box.innerHTML = timelineDetailMarkup(event);
  const bars = document.querySelectorAll(".timeline-bar");
  for (let barIndex = 0; barIndex < bars.length; barIndex += 1) {
    const bar = bars.item(barIndex);
    if (bar instanceof HTMLElement) bar.classList.toggle("active", barIndex === index);
  }
}

function renderSessionDetail(data: Payload): string {
  const row = sessionDetailRow;
  const title = row === null ? "Conversation" : sessionTitle(row);
  const hideIdentities = data.uiPreview?.privacyHideIdentities === true;
  const account = hideIdentities ? "account hidden" : row !== null && row.accountKey.length > 0 ? row.accountKey : "default";
  const provider = row === null ? "" : providerName(row.provider);
  const when = row === null ? "" : sessionClock(row.startedAt);
  const parts: string[] = [];
  parts.push(`<div class="row"><button type="button" data-session-back>Sessions</button><button type="button" id="open-session-web">Open in web UI</button></div>`);
  parts.push(`<div class="strong">${escapeHtml(title)}</div>`);
  parts.push(`<p class="tiny">${escapeHtml(`${provider} · ${account} · ${when}`)}</p>`);
  if (sessionStatus.length > 0) parts.push(`<p class="tiny">${escapeHtml(sessionStatus)}</p>`);
  if (sessionDetail !== null) {
    const duration = cacheDurationText(sessionDetail.cacheDuration);
    const estimate = sessionDetail.cacheDuration;
    if (estimate !== null && estimate.estimatedSeconds !== null && duration.length > 0) parts.push(`<p class="tiny">${escapeHtml(duration)}</p>`);
    if (!sessionEventsLoading || sessionDetail.conversationBody.length > 0) parts.push(renderConversation(sessionDetail.conversationBody, sessionDetail.conversationTitle));
    if (sessionEvents.length > 0) {
      parts.push(`<p class="section-label">request timeline · ${sessionDetail.eventsTotal}</p>`);
      parts.push(renderTimeline());
    }
    if (sessionDetail.eventsHasMore) {
      parts.push(`<button type="button" data-session-events>${sessionEventsLoading ? "Loading…" : "Load next 40 requests"}</button>`);
      parts.push(`<p class="tiny">Showing ${sessionEvents.length} of ${sessionDetail.eventsTotal} requests.</p>`);
    }
  }
  return parts.join("");
}

function renderSessions(data: Payload): string {
  if (sessionDetailRow !== null) return shownCards([card("session", "conversation", renderSessionDetail(data))]);
  const hideIdentities = data.uiPreview?.privacyHideIdentities === true;
  const lines: string[] = [];
  const status = sessionStatus.length > 0 ? sessionStatus : sessionLoading ? "Searching sessions…" : "";
  if (status.length > 0) lines.push(`<p class="tiny">${escapeHtml(status)}</p>`);
  lines.push(`<button type="button" id="reindex-sessions">${sessionReindexing ? "Reindexing…" : "Reindex conversations"}</button>`);
  if (!sessionLoading && sessionRows.length === 0 && sessionStatus === "No sessions found") {
    lines.push(`<p class="tiny">The local conversation index may be missing or stale.</p>`);
  }
  for (const row of sessionRows) {
    const account = hideIdentities ? "account hidden" : row.accountKey.length > 0 ? row.accountKey : "default";
    const shortId = row.sessionId.length > 8 ? row.sessionId.slice(0, 8) : row.sessionId;
    const meta = `${providerName(row.provider)} · ${account} · ${sessionClock(row.startedAt)} · ${shortId}`;
    lines.push(`<button type="button" class="session-row" data-session-provider="${escapeHtml(row.provider)}" data-session-id="${escapeHtml(row.sessionId)}"><div class="row"><span class="grow strong">${escapeHtml(sessionTitle(row))}</span><span class="tiny">${escapeHtml(sessionStats(row))}</span></div><div class="tiny">${escapeHtml(sessionSnippet(row))}</div><div class="tiny">${escapeHtml(meta)}</div></button>`);
  }
  if (sessionPage > 1 || sessionHasMore) {
    lines.push(`<div class="row"><button type="button" data-session-page="previous">Previous</button><span class="grow tiny">Page ${sessionPage}</span><button type="button" data-session-page="next">Next</button></div>`);
  }
  return shownCards([card("sessions", "find conversations", lines.join(""))]);
}

function renderSources(data: Payload): string {
  if (sourcesText.length === 0) return shownCards([card("sources", "tracked sources", `<p class="muted">Loading sources…</p>`)]);
  const parsed = parseTrackedSources(sourcesText);
  if (parsed.length === 0 && sourcesText !== "no providers registered") {
    return shownCards([card("sources", "tracked sources", `<pre>${escapeHtml(sourcesText)}</pre>`)]);
  }
  const hideIdentities = data.uiPreview?.privacyHideIdentities === true;
  const active = activeTrackedSources(parsed);
  const idle = parsed.length - active.length;
  const lines: string[] = [];
  lines.push(`<p class="muted">tokitoki reads local harness logs and keeps the dashboard projection in sync.</p>`);
  lines.push(`<div class="freshness"><span class="dot"></span><span>Payload updated ${escapeHtml(ageLabel(data.generatedAt, Date.now()))}</span></div>`);
  lines.push(`<button type="button" id="scan-sources">${refreshing ? "Scanning…" : "Scan local sources"}</button>`);
  if (active.length === 0) lines.push(`<p class="muted">No local harness stores detected</p>`);
  for (const source of active) {
    const files = `${source.upToDateFiles}/${source.filesFound} files up to date · ${source.trackedFiles} tracked`;
    const accounts = source.accounts.length > 0 ? privateTitle(source.accounts, hideIdentities) : "(none)";
    const shownModels = source.models.slice(0, 6);
    const extraModels = source.models.length - shownModels.length;
    const models = shownModels.length === 0 ? "(none)" : `${shownModels.join(", ")}${extraModels > 0 ? ` · +${extraModels}` : ""}`;
    lines.push(`<div class="window"><div class="row"><span class="grow strong">${escapeHtml(source.label)}</span><span class="tiny">${escapeHtml(source.id)}</span></div>`);
    lines.push(`<div class="tiny">${escapeHtml(files)} · ${escapeHtml(humanCount(source.events))} events</div>`);
    lines.push(`<div class="tiny">accounts ${escapeHtml(accounts)}</div>`);
    lines.push(`<div class="tiny">models ${escapeHtml(models)}</div>`);
    for (const root of source.roots) {
      const env = root.envVar.length > 0 ? ` · ${root.envVar}` : "";
      lines.push(`<div class="tiny">${escapeHtml(root.path)}${escapeHtml(env)}</div>`);
    }
    if (source.note.length > 0) lines.push(`<div class="tiny">${escapeHtml(source.note)}</div>`);
    lines.push(`</div>`);
  }
  if (idle > 0) lines.push(`<p class="tiny">${idle} other harnesses have no local store</p>`);
  return shownCards([card("sources", "tracked sources", lines.join(""))]);
}

function renderMcp(): string {
  const integration = mcpIntegration(mcpIntegrationId);
  const chips: string[] = [];
  for (const choice of MCP_INTEGRATIONS) {
    const active = choice.id === integration.id ? " active" : "";
    chips.push(`<button type="button" class="${active.trim()}" data-mcp-integration="${escapeHtml(choice.id)}">${escapeHtml(choice.title)}</button>`);
  }
  const steps: string[] = [];
  for (let index = 0; index < integration.steps.length; index += 1) {
    const step = integration.steps[index] ?? "";
    steps.push(`<div class="row"><span class="tiny">${index + 1}</span><span class="grow">${escapeHtml(step)}</span></div>`);
  }
  const toolLines: string[] = [];
  for (const tool of MCP_TOOLS) {
    toolLines.push(`<div class="row"><span class="grow">${escapeHtml(tool.name)}</span><span class="tiny">${escapeHtml(tool.inputs)}</span></div><p class="tiny">${escapeHtml(tool.summary)}</p>`);
  }
  const connect = `<p class="muted">Local usage stays on this machine. The agent starts tokitoki over stdio.</p><div class="chips">${chips.join("")}</div><p class="tiny">${escapeHtml(integration.location)}</p>${steps.join("")}<pre>${escapeHtml(integration.snippet)}</pre><button type="button" id="copy-mcp">Copy setup</button>`;
  const tools = `<p class="tiny">${MCP_TOOLS.length} tools. scan_now is the only one that writes.</p>${toolLines.join("")}`;
  return shownCards([card("mcp-connect", "connect tokitoki", connect), card("mcp-tools", "available tools", tools)]);
}

function settingRow(label: string, on: boolean, action: string, path: string): string {
  const next = on ? "false" : "true";
  const toggle = action === "poll-enabled"
    ? `<button type="button" data-poll-toggle="${next}">${on ? "On" : "Off"}</button>`
    : `<button type="button" data-config="${escapeHtml(path)}" data-value="${next}">${on ? "On" : "Off"}</button>`;
  return `<div class="row"><span class="grow">${escapeHtml(label)}</span>${toggle}</div>`;
}

function choiceChips(path: string, current: number, choices: Array<[number, string]>): string {
  const buttons: string[] = [];
  for (const choice of choices) {
    const value = choice[0];
    const label = choice[1];
    const active = value === current ? " active" : "";
    buttons.push(`<button type="button" class="${active.trim()}" data-config="${escapeHtml(path)}" data-value="${value}">${escapeHtml(label)}</button>`);
  }
  return `<div class="chips">${buttons.join("")}</div>`;
}

function previewLineCount(value: number | string[] | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return 3;
}

function textChips(path: string, current: string, choices: Array<[string, string]>): string {
  const buttons: string[] = [];
  for (const choice of choices) {
    const value = choice[0];
    const label = choice[1];
    const active = value === current ? " active" : "";
    buttons.push(`<button type="button" class="${active.trim()}" data-config="${escapeHtml(path)}" data-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`);
  }
  return `<div class="chips">${buttons.join("")}</div>`;
}

function previewCard(data: Payload, previewOn: boolean, lines: number): string {
  const preview = data.uiPreview;
  const mode = preview?.previewMode === "hover" ? "hover" : "inline";
  const metric = preview?.stripMetric === "tokens" || preview?.stripMetric === "smart" ? preview.stripMetric : "percent";
  const exhausted = preview?.stripExhausted === "show" || preview?.stripExhausted === "hide" ? preview.stripExhausted : "reset";
  const hidden = preview?.previewHidden ?? [];
  const providers: string[] = [];
  for (const account of data.limits ?? []) {
    const provider = upstreamProvider(account.provider ?? "", account.accountKey ?? "");
    if (provider !== undefined && !providers.includes(provider)) providers.push(provider);
  }
  const providerLines: string[] = [`<p class="section-label">Providers</p>`];
  if (providers.length === 0) providerLines.push(`<p class="muted">No quota providers detected</p>`);
  for (const provider of providers) {
    const enabled = !hidden.includes(provider);
    const next: string[] = [];
    for (const item of hidden) if (item !== provider) next.push(item);
    if (enabled) next.push(provider);
    providerLines.push(`<div class="row"><span class="grow">${escapeHtml(provider)}</span><button type="button" data-config="ui.previewHidden" data-value="${escapeHtml(JSON.stringify(next))}">${enabled ? "On" : "Off"}</button></div>`);
  }
  return `${settingRow("Show the tray preview", previewOn, "config", "ui.menubarPreviewEnabled")}<p class="tiny">Hide the compact provider usage strip without hiding the popover or quota cards.</p><p class="section-label">Display</p>${textChips("ui.menubarPreviewMode", mode, [["inline", "Always in the menubar"], ["hover", "Only while hovering"]])}<p class="section-label">Metric</p>${textChips("ui.stripMetric", metric, [["percent", "Remaining percent"], ["tokens", "Usage tokens"], ["smart", "Tightest quota window"]])}<p class="section-label">When a provider is exhausted</p>${textChips("ui.stripExhausted", exhausted, [["reset", "Show next reset"], ["hide", "Hide its mark"], ["show", "Keep showing 0%"]])}<p class="section-label">Preview lines</p>${choiceChips("ui.menubarPreviewLines", lines, [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"]])}${providerLines.join("")}`;
}

function dashboardCard(): string {
  const status = dashboardDetail.length === 0 ? "Checking local dashboard…" : dashboardDetail;
  const stop = dashboardOwned ? "" : " disabled";
  return `<p class="muted">The browser dashboard is local-only and starts on demand. Stopping it only affects a server launched by this panel.</p><p class="tiny">${escapeHtml(status)}</p><div class="chips"><button type="button" id="open-dashboard">Start / open</button><button type="button" id="stop-dashboard"${stop}>Stop</button></div>`;
}

function syncBackendChips(current: string): string {
  const choices: Array<[string, string]> = [
    ["none", "Off"],
    ["dir", "Shared folder"],
    ["git", "Private Git repo"],
    ["atproto", "AT Protocol"],
  ];
  const buttons: string[] = [];
  for (const choice of choices) {
    const value = choice[0];
    const label = choice[1];
    const active = value === current ? " active" : "";
    buttons.push(`<button type="button" class="${active.trim()}" data-config="sync.backend" data-value="${value}">${escapeHtml(label)}</button>`);
  }
  return `<div class="chips">${buttons.join("")}</div>`;
}

function syncSettingField(label: string, settingPath: string, value: string | undefined): string {
  return `<p class="section-label">${escapeHtml(label)}</p><input class="setting-input" id="sync-setting" data-sync-path="${escapeHtml(settingPath)}" value="${escapeHtml(value ?? "")}"><button type="button" id="save-sync">Save</button>`;
}

function apiKeyCard(): string {
  const lines: string[] = [];
  lines.push(`<p class="muted">Each key is polled separately and appears as its own quota account. The key itself stays out of this panel.</p>`);
  if (apiKeyNote.length > 0) lines.push(`<p class="tiny">${escapeHtml(apiKeyNote)}</p>`);
  if (apiKeys.length === 0) lines.push(`<p class="muted">No manual keys yet</p>`);
  for (const key of apiKeys) {
    const title = key.label.length > 0 ? key.label : key.id;
    lines.push(`<div class="row"><span class="grow"><span class="strong">${escapeHtml(title)}</span><br><span class="tiny">${escapeHtml(key.provider)} · ${escapeHtml(key.hint)}</span></span><button type="button" data-remove-api-key="${escapeHtml(key.id)}" data-api-provider="${escapeHtml(key.provider)}">Remove</button></div>`);
  }
  if (!apiKeyFormOpen) {
    lines.push(`<button type="button" id="add-api-key">Add API key</button>`);
    return lines.join("");
  }
  const choices: Array<[string, string]> = [
    ["opencode-go", "OpenCode Go"],
    ["openrouter", "OpenRouter"],
  ];
  const chips: string[] = [];
  for (const choice of choices) {
    const active = choice[0] === apiKeyProvider ? " active" : "";
    chips.push(`<button type="button" class="${active.trim()}" data-api-provider-choice="${choice[0]}">${escapeHtml(choice[1])}</button>`);
  }
  lines.push(`<div class="chips">${chips.join("")}</div>`);
  lines.push(`<input class="setting-input" id="api-key-id" placeholder="Stable id">`);
  lines.push(`<input class="setting-input" id="api-key-label" placeholder="Display name">`);
  lines.push(`<input class="setting-input" id="api-key-value" type="password" placeholder="API key" autocomplete="off">`);
  lines.push(`<button type="button" id="save-api-key">Add</button>`);
  return lines.join("");
}

function maintenanceCard(): string {
  const note = maintenanceNote.length > 0 ? `<p class="tiny">${escapeHtml(maintenanceNote)}</p>` : "";
  return `<p class="muted">Rebuild conversation search, or import a provider usage CSV.</p>${note}<button type="button" id="reindex-settings">Reindex conversations</button><button type="button" id="import-csv">Import CSV</button>`;
}

function syncCard(preview: Payload["uiPreview"]): string {
  const backend = preview?.syncBackend === "dir" || preview?.syncBackend === "git" || preview?.syncBackend === "atproto" ? preview.syncBackend : "none";
  let field = "";
  if (backend === "dir") field = syncSettingField("Shared folder", "sync.path", preview?.syncPath);
  else if (backend === "git") field = syncSettingField("Private Git URL", "sync.url", preview?.syncUrl);
  else if (backend === "atproto") field = syncSettingField("Bluesky handle", "sync.handle", preview?.syncHandle);
  const note = backend === "none"
    ? "Sync is off. Choose a backend, then save its folder, URL, or handle."
    : `Backend ${backend} is selected. Save its setting, then sync from here.`;
  const button = backend === "none" ? "" : `<button type="button" id="sync-now">Sync now</button>`;
  return `${syncBackendChips(backend)}${field}<p class="tiny">${escapeHtml(note)}</p>${button}`;
}

function renderSettings(data: Payload): string {
  const preview = data.uiPreview;
  const notifications = data.notifications;
  const pollingOn = preview?.pollAuto === true;
  const notificationsOn = notifications?.enabled === true || preview?.notificationsEnabled === true;
  const resetOn = notifications?.resetAware === true || preview?.quotaResetNotifications === true;
  const burnOn = notifications?.burnWarnings === true;
  const hideOn = preview?.privacyHideIdentities === true;
  const adaptiveOn = preview?.pollAdaptive === true;
  const previewOn = preview?.previewEnabled !== false;
  const critical = notifications?.quotaCriticalPercent ?? 10;
  const interval = preview?.pollIntervalMinutes ?? 15;
  const ratio = notifications?.burnWarningRatio ?? preview?.burnWarningRatio ?? 0.8;
  const lines = previewLineCount(preview?.previewLines);
  const health = data.spendHealth;
  const monthLine = health === undefined
    ? "Add a monthly budget to receive burn-rate warnings."
    : `This month ${formatCost(health.monthToDate ?? 0)} · ${formatCost(health.perDay ?? 0)}/day · projected ${formatCost(health.projected ?? 0)}`;
  const disabled = notifications?.disabledNotifications ?? preview?.disabledNotifications ?? [];
  const alerts: Array<[string, string]> = [
    ["quotaCritical", "Critical quota"],
    ["quotaReset", "Quota reset"],
    ["quotaPace", "Runs out before reset"],
    ["burnRate", "Burn-rate"],
    ["budget", "Budget threshold"],
  ];
  const alertLines: string[] = [`<p class="section-label">Alert categories</p>`];
  const allKinds: string[] = [];
  for (const alert of alerts) allKinds.push(alert[0]);
  const allOn = disabled.length === 0;
  alertLines.push(`<div class="row"><span class="grow">All alert categories</span><button type="button" data-config="notifications.disabled" data-value="${escapeHtml(allOn ? JSON.stringify(allKinds) : "[]")}">${allOn ? "On" : "Off"}</button></div>`);
  for (const alert of alerts) {
    const kind = alert[0];
    const label = alert[1];
    const enabled = !disabled.includes(kind);
    const next: string[] = [];
    for (const item of disabled) if (item !== kind) next.push(item);
    if (enabled) next.push(kind);
    alertLines.push(`<div class="row"><span class="grow">${escapeHtml(label)}</span><button type="button" data-config="notifications.disabled" data-value="${escapeHtml(JSON.stringify(next))}">${enabled ? "On" : "Off"}</button></div>`);
  }
  const hiddenLines: string[] = [];
  for (const id of layout.hidden) {
    hiddenLines.push(`<div class="row"><span class="grow">${escapeHtml(id)}</span><button type="button" data-show="${escapeHtml(id)}">Show</button></div>`);
  }
  const hiddenBody = hiddenLines.length === 0 ? `<p class="muted">No hidden cards</p>` : hiddenLines.join("");
  const hiddenAccountLines: string[] = [];
  for (const id of preview?.menubarHidden ?? []) {
    hiddenAccountLines.push(`<div class="row"><span class="grow">${escapeHtml(id)}</span><button type="button" data-show-account="${escapeHtml(id)}">Show</button></div>`);
  }
  const hiddenAccountBody = hiddenAccountLines.length === 0 ? `<p class="muted">No hidden accounts</p>` : hiddenAccountLines.join("");
  const configLine = settingsConfigPath.length === 0 ? "Looking up the config file…" : settingsConfigPath;
  const alertLinesShown: string[] = [];
  for (const alert of settingsAlerts) {
    alertLinesShown.push(`<div class="window"><div class="row"><span class="grow strong">${escapeHtml(alert.title)}</span><span class="tiny">${escapeHtml(sessionClock(alert.at))}</span></div><div class="tiny">${escapeHtml(alert.body)}</div><div class="tiny">Why: ${escapeHtml(alert.reason)}</div></div>`);
  }
  const recentAlerts = alertLinesShown.length === 0 ? `<p class="muted">No alerts have been emitted yet.</p>` : alertLinesShown.join("");
  return shownCards([
    card("config-file", "configuration file", `<p class="muted">Popover, preview, polling, and notification settings are stored here.</p><p class="tiny">${escapeHtml(configLine)}</p><button type="button" id="open-config">Open config file</button>`),
    card("recent-alerts", "recent alerts", recentAlerts),
    card("tabs", "popover tabs", `${tabOrderBody()}${settingRow("Detailed harness cards", preview?.showHarnessVariants === true, "config", "ui.showHarnessVariants")}<p class="tiny">Off groups accounts that share a credential. On shows one card per harness. The first four tabs stay in the header. Sessions stays under More, ahead of the rest.</p>`),
    card("privacy", "privacy", `${settingRow("Hide account identities", hideOn, "config", "privacy.hideIdentities")}<p class="tiny">Emails and account ids are replaced in this panel. The config file stays plain text.</p>`),
    card("notifications", "notifications and spend guard", `${settingRow("Allow notifications", notificationsOn, "config", "notifications.enabled")}<p class="tiny">Off until you want quota or spend interruptions.</p>${settingRow("Notify when a quota resets", resetOn, "config", "notifications.resetAware")}<p class="section-label">Alert when quota has</p>${choiceChips("notifications.quotaCriticalPercent", critical, [[5, "5% left"], [10, "10% left"], [20, "20% left"]])}${settingRow("Warn when projected spend reaches the cap", burnOn, "config", "notifications.burnWarnings")}<p class="section-label">Warn at</p>${choiceChips("notifications.burnWarningRatio", ratio, [[0.8, "80%"], [0.9, "90%"], [1, "100%"]])}<p class="tiny">${escapeHtml(monthLine)}</p>${alertLines.join("")}`),
    card("polling", "background quota polling", `${settingRow("Poll provider quotas automatically", pollingOn, "poll-enabled", "")}<p class="section-label">Check every</p>${choiceChips("poll.intervalMinutes", interval, [[5, "5 min"], [15, "15 min"], [30, "30 min"], [60, "60 min"]])}${settingRow("Adapt cadence near a reset", adaptiveOn, "config", "poll.adaptive")}<p class="tiny">Read-only checks do not send prompts. Providers may still rate-limit frequent checks.</p><button type="button" id="poll-now">Refresh quotas now</button>`),
    card("preview", "menubar preview", previewCard(data, previewOn, lines)),
    card("hidden-cards", "hidden cards", hiddenBody),
    card("hidden-accounts", "hidden accounts", hiddenAccountBody),
    card("api-keys", "provider API keys", apiKeyCard()),
    card("maintenance", "index and import", maintenanceCard()),
    card("sync", "sync", syncCard(preview)),
    card("dashboard", "local dashboard", dashboardCard()),
  ]);
}

function renderContent(): void {
  const content = element("content");
  if (errorText.length > 0 && payload === null) {
    content.innerHTML = `<div class="error">${escapeHtml(errorText)}</div>`;
    return;
  }
  if (loading || payload === null) {
    content.innerHTML = `<p class="muted">${refreshing ? "Scanning sources…" : "Loading usage…"}</p>`;
    return;
  }
  const now = Date.now();
  let html = "";
  if (activeTab === "overview") html = renderOverview(payload, now);
  else if (activeTab === "quotas") html = renderQuotas(payload, now);
  else if (activeTab === "tokens") html = renderTokens(payload);
  else if (activeTab === "reports") html = renderReports(payload);
  else if (activeTab === "sessions") html = renderSessions(payload);
  else if (activeTab === "sources") html = renderSources(payload);
  else if (activeTab === "mcp") html = renderMcp();
  else html = renderSettings(payload);
  if (errorText.length > 0) html = `<div class="error">${escapeHtml(errorText)}</div>` + html;
  content.innerHTML = html;
}

function moveTab(id: string, direction: number): string[] | undefined {
  const ids = orderedTabs(payload?.uiPreview?.tabs);
  const index = ids.indexOf(id);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= ids.length) return undefined;
  const next = ids.slice();
  const swapped = next[destination];
  next[destination] = id;
  next[index] = swapped ?? id;
  return next;
}

function tabOrderBody(): string {
  const ids = orderedTabs(payload?.uiPreview?.tabs);
  const lines: string[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (id === undefined) continue;
    const place = index < 4 ? "header" : "more";
    lines.push(`<div class="row"><span class="grow">${escapeHtml(tabTitle(id))}</span><span class="tiny">${place}</span><button type="button" data-tab-move="${id}" data-tab-direction="-1">Up</button><button type="button" data-tab-move="${id}" data-tab-direction="1">Down</button></div>`);
  }
  return lines.join("");
}

function renderChrome(): void {
  const tabs = element("tabs");
  const ids = popupTabIds(payload?.uiPreview?.tabs);
  const buttons: string[] = [];
  let moreSelected = false;
  const moreButtons: string[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (id === undefined) continue;
    const title = escapeHtml(tabTitle(id));
    if (index < 4) {
      buttons.push(`<button type="button" data-tab="${id}" class="${activeTab === id ? "active" : ""}">${tabGlyph(id)}<span>${title}</span></button>`);
    } else {
      if (activeTab === id) moreSelected = true;
      moreButtons.push(`<button type="button" data-tab="${id}">${tabGlyph(id)}<span>${title}</span></button>`);
    }
  }
  const moreLabel = moreSelected ? escapeHtml(tabTitle(activeTab)) : "More";
  const moreIcon = moreSelected ? tabGlyph(activeTab) : glyph("more");
  buttons.push(`<details class="menu${moreSelected ? " selected" : ""}"><summary>${moreIcon}<span>${moreLabel}</span>${glyph("expand")}</summary><div class="menu-panel">${moreButtons.join("")}</div></details>`);
  tabs.innerHTML = buttons.join("");

  const freshness = element("freshness");
  const age = ageLabel(payload?.generatedAt, Date.now());
  const freshnessLabel = payload?.generatedAt === undefined || payload.generatedAt.length === 0 ? "Waiting for a snapshot" : `Updated ${age}`;
  freshness.innerHTML = `<span class="dot"></span><span>${escapeHtml(freshnessLabel)}</span>`;
  const search = document.getElementById("search");
  if (search instanceof HTMLInputElement) {
    const placeholder = activeTab === "sessions" ? "Search conversations…" : "Search harness, account, repo…";
    if (search.placeholder !== placeholder) search.placeholder = placeholder;
  }
  const searchIcon = document.getElementById("search-icon");
  if (searchIcon !== null && searchIcon.childElementCount === 0) searchIcon.innerHTML = glyph("search");

  const footer = element("footer");
  footer.innerHTML = `<button type="button" id="refresh">${glyph("refresh")}<span>${refreshing ? "Scanning…" : "Refresh & scan"}</span></button><span class="footer-note grow">${escapeHtml(shareNote)}</span><button type="button" id="share">${glyph("share")}<span>Share</span></button><button type="button" id="layout-mode" class="${layoutMode ? "active" : ""}">${glyph("layout")}<span>${layoutMode ? "Done" : "Layout"}</span></button><button type="button" data-dashboard="/">${glyph("open")}<span>Open</span></button>`;
}

function paint(): void {
  renderChrome();
  renderContent();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSessionList(): Promise<void> {
  sessionGeneration += 1;
  const generation = sessionGeneration;
  const query = searchText.trim();
  const page = sessionPage;
  sessionLoading = true;
  if (sessionDetailRow === null && !sessionReindexing) sessionStatus = "Searching sessions…";
  paint();
  try {
    const response = await rpc.request.loadSessions({ query, page }, { maxRequestTime: 60_000 });
    if (generation !== sessionGeneration) return;
    const parsed = parseSessionList(response.json);
    sessionRows = parsed.rows;
    sessionHasMore = parsed.hasMore;
    sessionPage = parsed.page;
    if (sessionDetailRow === null) {
      const summary = parsed.rows.length === 0 ? "No sessions found" : `${parsed.rows.length} sessions · page ${parsed.page}`;
      sessionStatus = sessionReindexNote.length > 0 ? `${sessionReindexNote} · ${summary}` : summary;
      sessionReindexNote = "";
    }
  } catch (error) {
    if (generation !== sessionGeneration) return;
    sessionRows = [];
    sessionHasMore = false;
    sessionReindexNote = "";
    if (sessionDetailRow === null) sessionStatus = `Session search failed: ${errorMessage(error)}`;
  }
  sessionLoading = false;
  paint();
}

function scheduleSessionSearch(): void {
  if (sessionSearchTimer !== undefined) clearTimeout(sessionSearchTimer);
  sessionSearchTimer = setTimeout(() => {
    void loadSessionList();
  }, 350);
}

function openSessionRow(provider: string, sessionId: string): void {
  let match: SessionListRow | null = null;
  for (const row of sessionRows) {
    if (row.provider === provider && row.sessionId === sessionId) match = row;
  }
  sessionDetailRow = match ?? {
    sessionId,
    provider,
    accountKey: "",
    startedAt: "",
    title: "",
    snippet: "",
    requests: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  sessionDetail = null;
  sessionEvents = [];
  selectedEventIndex = null;
  sessionStatus = "Loading conversation…";
  void loadSessionDetail(0);
}

async function loadSessionDetail(offset: number): Promise<void> {
  const row = sessionDetailRow;
  if (row === null) return;
  sessionDetailGeneration += 1;
  const generation = sessionDetailGeneration;
  const provider = row.provider;
  const sessionId = row.sessionId;
  sessionEventsLoading = true;
  paint();
  try {
    const response = await rpc.request.loadSession({ provider, sessionId, offset }, { maxRequestTime: 60_000 });
    if (generation !== sessionDetailGeneration || sessionDetailRow === null) return;
    if (sessionDetailRow.provider !== provider || sessionDetailRow.sessionId !== sessionId) return;
    const page = parseSessionDetail(response.json, provider, sessionId);
    sessionEvents = appendSessionEvents(offset === 0 ? [] : sessionEvents, page, offset);
    sessionDetail = page;
    sessionStatus = "";
  } catch (error) {
    if (generation !== sessionDetailGeneration) return;
    sessionStatus = `Could not load conversation: ${errorMessage(error)}`;
  }
  sessionEventsLoading = false;
  paint();
}

async function reindexSessionList(): Promise<void> {
  if (sessionReindexing) return;
  sessionReindexing = true;
  sessionStatus = "Reindexing conversations…";
  sessionPage = 1;
  paint();
  try {
    const response = await rpc.request.reindexSessions({}, { maxRequestTime: 180_000 });
    const line = response.text.trim().split("\n")[0] ?? "";
    sessionReindexNote = line.length > 0 ? line : "Reindex complete";
    sessionStatus = sessionReindexNote;
  } catch (error) {
    sessionStatus = `Reindex failed: ${errorMessage(error)}`;
  }
  sessionReindexing = false;
  await loadSessionList();
}

async function reindexFromSettings(): Promise<void> {
  maintenanceNote = "Reindexing conversations…";
  paint();
  try {
    const response = await rpc.request.reindexSessions({}, { maxRequestTime: 180_000 });
    const line = response.text.trim().split("\n")[0] ?? "";
    maintenanceNote = line.length > 0 ? line : "Reindex complete";
  } catch (error) {
    maintenanceNote = `Reindex failed: ${errorMessage(error)}`;
  }
  paint();
}

async function importUsageCsv(): Promise<void> {
  maintenanceNote = "Choose a CSV…";
  paint();
  try {
    const response = await rpc.request.importCsv({}, { maxRequestTime: 180_000 });
    maintenanceNote = response.detail;
    if (response.ok) await loadPayload(true);
  } catch (error) {
    maintenanceNote = `Import failed: ${errorMessage(error)}`;
  }
  paint();
}

async function loadApiKeys(): Promise<void> {
  try {
    const response = await rpc.request.listApiKeys({}, { maxRequestTime: 20_000 });
    const parsed = JSON.parse(response.json) as unknown;
    const keys: MaskedApiKey[] = [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as { id?: unknown; label?: unknown; provider?: unknown; hint?: unknown };
        if (typeof record.id !== "string" || typeof record.hint !== "string") continue;
        keys.push({
          id: record.id,
          label: typeof record.label === "string" ? record.label : "",
          provider: typeof record.provider === "string" ? record.provider : "",
          hint: record.hint,
        });
      }
    }
    apiKeys = keys;
  } catch (error) {
    apiKeyNote = errorMessage(error);
  }
  paint();
}

async function saveApiKey(id: string, label: string, key: string): Promise<void> {
  apiKeyNote = "Saving…";
  paint();
  try {
    const response = await rpc.request.saveApiKey({ id, label, provider: apiKeyProvider, key }, { maxRequestTime: 20_000 });
    apiKeyNote = response.detail;
    apiKeyFormOpen = false;
    await loadApiKeys();
  } catch (error) {
    apiKeyNote = errorMessage(error);
    paint();
  }
}

async function removeApiKey(id: string, provider: string): Promise<void> {
  apiKeyNote = "Removing…";
  paint();
  try {
    const response = await rpc.request.removeApiKey({ id, provider }, { maxRequestTime: 20_000 });
    apiKeyNote = response.detail;
    await loadApiKeys();
  } catch (error) {
    apiKeyNote = errorMessage(error);
    paint();
  }
}

async function loadSettingsInfo(): Promise<void> {
  try {
    const response = await rpc.request.loadSettingsInfo({}, { maxRequestTime: 20_000 });
    settingsConfigPath = response.configPath;
    settingsAlerts = parseAlertHistory(response.alertsJson);
  } catch (error) {
    settingsConfigPath = errorMessage(error);
    settingsAlerts = [];
  }
  paint();
}

async function openConfigFile(): Promise<void> {
  try {
    const response = await rpc.request.openConfig({}, { maxRequestTime: 20_000 });
    shareNote = response.detail;
  } catch (error) {
    shareNote = errorMessage(error);
  }
  paint();
}

async function loadSources(force = false): Promise<void> {
  if (!force && sourcesText.length > 0) return;
  try {
    const response = await rpc.request.loadSources({}, { maxRequestTime: 60_000 });
    sourcesText = response.text.trim();
  } catch (error) {
    sourcesText = error instanceof Error ? error.message : String(error);
  }
}

async function loadPayload(cached: boolean): Promise<void> {
  refreshing = !cached;
  errorText = "";
  if (payload === null) loading = true;
  paint();
  try {
    const response = await rpc.request.loadPayload({ cached }, { maxRequestTime: cached ? 120_000 : 600_000 });
    payload = JSON.parse(response.json) as Payload;
    seedLayout(payload);
    loading = false;
    refreshing = false;
    const weekRows = periodRows(payload.spendPeriods, "week");
    let weekCost = 0;
    for (const row of weekRows) weekCost += row.costUsd ?? 0;
    rpc.send.summary({ text: traySummaryText(weekCost, payload.today?.total?.costUsd ?? payload.stats?.costUsd ?? 0) });
    scheduleRefresh();
  } catch (error) {
    loading = false;
    refreshing = false;
    errorText = error instanceof Error ? error.message : String(error);
  }
  paint();
}

function scheduleRefresh(): void {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  const minutes = payload?.uiPreview?.pollIntervalMinutes ?? 15;
  if (payload?.uiPreview?.pollAuto === false) return;
  refreshTimer = setTimeout(() => {
    void loadPayload(true);
  }, Math.max(1, minutes) * 60_000);
}

async function copyMcpSetup(): Promise<void> {
  const integration = mcpIntegration(mcpIntegrationId);
  try {
    await navigator.clipboard.writeText(integration.snippet);
    shareNote = `Copied ${integration.title} setup`;
  } catch {
    shareNote = "Copy failed";
  }
  paint();
}

async function copySummary(): Promise<void> {
  if (payload === null) return;
  const weekRows = periodRows(payload.spendPeriods, "week");
  const text = shareMarkdown({
    generatedAt: payload.generatedAt ?? "",
    weekRows,
    todayCost: payload.today?.total?.costUsd ?? payload.stats?.costUsd ?? 0,
    monthToDate: payload.spendHealth?.monthToDate ?? 0,
    projected: payload.spendHealth?.projected ?? 0,
  });
  try {
    await navigator.clipboard.writeText(text);
    shareNote = "Summary copied";
  } catch {
    shareNote = "Copy failed";
  }
  paint();
}

async function openDashboard(path: string): Promise<void> {
  if (dashboardUrl(path) === undefined) {
    shareNote = "That dashboard page is not available";
    paint();
    return;
  }
  shareNote = "Checking local dashboard…";
  paint();
  try {
    const response = await rpc.request.openDashboard({ path }, { maxRequestTime: 20_000 });
    dashboardDetail = response.detail;
    dashboardOwned = response.owned;
    shareNote = response.detail;
  } catch (error) {
    shareNote = error instanceof Error ? error.message : String(error);
  }
  paint();
}

async function stopDashboard(): Promise<void> {
  shareNote = "Stopping dashboard…";
  paint();
  try {
    const response = await rpc.request.stopDashboard({}, { maxRequestTime: 10_000 });
    dashboardDetail = response.detail;
    dashboardOwned = response.owned;
    shareNote = response.detail;
  } catch (error) {
    shareNote = error instanceof Error ? error.message : String(error);
  }
  paint();
}

async function loadDashboardStatus(): Promise<void> {
  try {
    const response = await rpc.request.dashboardStatus({}, { maxRequestTime: 5_000 });
    dashboardDetail = response.detail;
    dashboardOwned = response.owned;
  } catch (error) {
    dashboardDetail = error instanceof Error ? error.message : String(error);
    dashboardOwned = false;
  }
  if (activeTab === "settings") paint();
}

async function applyAction(input: { action: string; path?: string; value?: string; provider?: string; url?: string }, reload: boolean): Promise<void> {
  const slow = input.action === "poll" || input.action === "poll-all" || input.action === "sync";
  shareNote = input.action === "poll" || input.action === "poll-all" ? "Refreshing quota…" : input.action === "sync" ? "Syncing…" : "Saving…";
  paint();
  try {
    const response = await rpc.request.performAction(input, { maxRequestTime: slow ? 120_000 : 20_000 });
    if (response.authJson !== undefined) rememberAuthStates(response.authJson, input.provider);
    const refreshed = input.action === "poll" || input.action === "poll-all";
    shareNote = refreshed ? response.detail : input.action === "sync" && response.ok ? response.detail : response.ok ? "Saved" : response.detail;
    if ((response.ok && reload) || (!response.ok && input.action === "account-order")) await loadPayload(true);
    else paint();
  } catch (error) {
    shareNote = error instanceof Error ? error.message : String(error);
    if (input.action === "account-order") await loadPayload(true);
    else paint();
  }
}

document.body.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const attribute = (name: string): string | undefined => {
    const owner = target.closest(`[data-${name}]`);
    if (!(owner instanceof HTMLElement)) return undefined;
    const value = owner.getAttribute(`data-${name}`);
    return value === null ? undefined : value;
  };
  const pressedId = (): string => {
    const button = target.closest("button");
    if (button instanceof HTMLButtonElement && button.id.length > 0) return button.id;
    return target.id;
  };
  const eventIndex = target.closest("[data-event-index]");
  if (eventIndex instanceof HTMLElement && eventIndex.dataset.eventIndex !== undefined) {
    const index = Number(eventIndex.dataset.eventIndex);
    if (Number.isFinite(index)) showTimelineDetail(index);
    return;
  }
  const dashboardPath = target.dataset.dashboard ?? target.closest("[data-dashboard]")?.getAttribute("data-dashboard") ?? undefined;
  if (dashboardPath !== undefined && dashboardPath.length > 0) {
    const menu = target.closest("details.menu");
    if (menu instanceof HTMLDetailsElement) menu.open = false;
    void openDashboard(dashboardPath);
    return;
  }
  const move = attribute("move");
  const cardId = attribute("card-id");
  if (move !== undefined && cardId !== undefined && payload !== null) {
    const direction = move === "-1" ? -1 : 1;
    const accountId = accountOrderIdForCard(cardId);
    if (accountId.length > 0) {
      const next = moveCard(accountIdsOnTab(), accountId, direction === -1 ? -1 : 1);
      if (next.join("\n") !== accountIdsOnTab().join("\n")) persistAccountOrder(next);
      return;
    }
    const ids = tabOrder(lastCards);
    rememberOrder(moveCard(ids, cardId, direction === -1 ? -1 : 1), ids);
    saveLayout();
    persistCards();
    paint();
    return;
  }
  const hide = attribute("hide");
  if (hide !== undefined) {
    if (!layout.hidden.includes(hide)) layout.hidden.push(hide);
    saveLayout();
    persistCards();
    paint();
    return;
  }
  const show = attribute("show");
  if (show !== undefined) {
    layout.hidden = layout.hidden.filter((id) => id !== show);
    saveLayout();
    persistCards();
    paint();
    return;
  }
  const tabMove = attribute("tab-move");
  const tabDirection = attribute("tab-direction");
  if (tabMove !== undefined && tabDirection !== undefined) {
    const next = moveTab(tabMove, tabDirection === "-1" ? -1 : 1);
    if (next !== undefined) void applyAction({ action: "tabs", value: next.join(",") }, true);
    return;
  }
  const hideAccount = attribute("hide-account");
  if (hideAccount !== undefined) {
    void applyAction({ action: "ui-hide", value: hideAccount }, true);
    return;
  }
  const showAccount = attribute("show-account");
  if (showAccount !== undefined) {
    void applyAction({ action: "ui-show", value: showAccount }, true);
    return;
  }
  const configPath = attribute("config");
  const configValue = attribute("value");
  if (configPath !== undefined && configValue !== undefined) {
    void applyAction({ action: "config", path: configPath, value: configValue }, true);
    return;
  }
  const pollToggle = attribute("poll-toggle");
  if (pollToggle === "true" || pollToggle === "false") {
    void applyAction({ action: "poll-enabled", value: pollToggle }, true);
    return;
  }
  const pollProvider = attribute("poll");
  if (pollProvider !== undefined && pollProvider.length > 0) {
    void applyAction({ action: "poll", provider: pollProvider }, true);
    return;
  }
  const openUrl = attribute("open");
  if (openUrl !== undefined) {
    void applyAction({ action: "open", url: openUrl }, false);
    return;
  }
  if (target.closest("[data-session-back]") !== null) {
    sessionDetailRow = null;
    sessionDetail = null;
    sessionEvents = [];
    selectedEventIndex = null;
    sessionEventsLoading = false;
    sessionDetailGeneration += 1;
    sessionStatus = sessionRows.length === 0 ? sessionStatus : `${sessionRows.length} sessions · page ${sessionPage}`;
    paint();
    return;
  }
  const sessionPageDirection = target.dataset.sessionPage ?? target.closest("[data-session-page]")?.getAttribute("data-session-page");
  if (sessionPageDirection === "next" || sessionPageDirection === "previous") {
    if (sessionPageDirection === "next" && sessionHasMore) sessionPage += 1;
    if (sessionPageDirection === "previous" && sessionPage > 1) sessionPage -= 1;
    void loadSessionList();
    return;
  }
  if (target.closest("[data-session-events]") !== null && sessionDetail !== null && sessionDetail.eventsHasMore && !sessionEventsLoading) {
    void loadSessionDetail(sessionEvents.length);
    return;
  }
  if (target.id === "reindex-sessions") {
    void reindexSessionList();
    return;
  }
  const sessionButton = target.closest("[data-session-id]");
  if (sessionButton instanceof HTMLElement && sessionButton.dataset.sessionId !== undefined && sessionButton.dataset.sessionProvider !== undefined) {
    openSessionRow(sessionButton.dataset.sessionProvider, sessionButton.dataset.sessionId);
    return;
  }
  const details = attribute("details");
  if (details !== undefined) {
    if (detailAccounts.has(details)) detailAccounts.delete(details);
    else detailAccounts.add(details);
    paint();
    return;
  }
  const account = attribute("account");
  if (account !== undefined) {
    if (collapsedAccounts.has(account)) collapsedAccounts.delete(account);
    else collapsedAccounts.add(account);
    paint();
    return;
  }
  const tab = attribute("tab");
  if (tab !== undefined) {
    activeTab = tab;
    if (tab === "sources") void loadSources().then(paint);
    if (tab === "settings") {
      void loadSettingsInfo();
      void loadApiKeys();
      void loadDashboardStatus();
    }
    if (tab === "sessions") {
      sessionDetailRow = null;
      sessionDetail = null;
      sessionEvents = [];
      selectedEventIndex = null;
      sessionPage = 1;
      void loadSessionList();
    }
    const menu = document.querySelector("details.menu");
    if (menu instanceof HTMLDetailsElement) menu.open = false;
    paint();
    element("content").scrollTop = 0;
    return;
  }
  const period = attribute("period");
  if (period !== undefined) {
    tokenPeriod = period;
    paint();
    return;
  }
  const metric = attribute("metric");
  if (metric === "costUsd" || metric === "tokens") {
    distributionMetric = metric;
    paint();
    return;
  }
  const history = attribute("history");
  const composition = attribute("composition");
  if (composition === "day" || composition === "week" || composition === "month" || composition === "year") {
    compositionSpan = composition;
    paint();
    return;
  }
  if (history === "month" || history === "year") {
    historySpan = history;
    paint();
    return;
  }
  const integrationId = attribute("mcp-integration");
  if (integrationId !== undefined) {
    mcpIntegrationId = integrationId;
    paint();
    return;
  }
  if (pressedId() === "copy-mcp") {
    void copyMcpSetup();
    return;
  }
  if (pressedId() === "scan-sources") {
    sourcesText = "";
    void loadPayload(false).then(() => loadSources(true).then(paint));
    return;
  }
  if (pressedId() === "refresh") void loadPayload(false);
  if (pressedId() === "dismiss") rpc.send.dismiss({ closed: true });
  if (pressedId() === "share") void copySummary();
  if (pressedId() === "layout-mode") {
    layoutMode = !layoutMode;
    paint();
  }
  const authButton = target.closest("[data-auth]");
  if (authButton instanceof HTMLElement) {
    const kind = authButton.dataset.auth;
    const provider = authButton.dataset.provider ?? "";
    if (kind === "api-key") {
      activeTab = "settings";
      apiKeyFormOpen = true;
      void loadSettingsInfo();
      void loadApiKeys();
      paint();
      return;
    }
    if (kind === "retry") {
      void applyAction({ action: "poll", provider }, true);
      return;
    }
    const url = signInUrl(provider);
    if (url === undefined) {
      shareNote = "Could not open sign-in";
      paint();
      return;
    }
    void applyAction({ action: "open", url }, false);
    return;
  }
  if (target.id === "open-dashboard") void openDashboard("/");
  if (target.id === "stop-dashboard") void stopDashboard();
  if (target.id === "open-session-web" && sessionDetailRow !== null) {
    void openDashboard(`/?view=sessions&provider=${sessionDetailRow.provider}&session=${sessionDetailRow.sessionId}`);
    return;
  }
  if (target.id === "open-config") void openConfigFile();
  if (target.id === "save-sync") {
    const field = document.getElementById("sync-setting");
    if (field instanceof HTMLInputElement) {
      void applyAction({ action: "config", path: field.dataset.syncPath ?? "", value: field.value }, true);
    }
    return;
  }
  if (target.id === "reindex-settings") {
    void reindexFromSettings();
    return;
  }
  if (target.id === "import-csv") {
    void importUsageCsv();
    return;
  }
  if (target.id === "poll-now") {
    void applyAction({ action: "poll-all" }, true);
    return;
  }
  if (target.id === "sync-now") {
    void applyAction({ action: "sync" }, true);
    return;
  }
  if (target.id === "add-api-key") {
    apiKeyFormOpen = true;
    apiKeyNote = "";
    paint();
    return;
  }
  const providerChoice = target.dataset.apiProviderChoice;
  if (providerChoice === "opencode-go" || providerChoice === "openrouter") {
    apiKeyProvider = providerChoice;
    paint();
    return;
  }
  if (target.id === "save-api-key") {
    const idField = document.getElementById("api-key-id");
    const labelField = document.getElementById("api-key-label");
    const valueField = document.getElementById("api-key-value");
    const id = idField instanceof HTMLInputElement ? idField.value : "";
    const label = labelField instanceof HTMLInputElement ? labelField.value : "";
    const key = valueField instanceof HTMLInputElement ? valueField.value : "";
    void saveApiKey(id, label, key);
    return;
  }
  const removeKey = target.dataset.removeApiKey;
  const removeProvider = target.dataset.apiProvider;
  if (removeKey !== undefined && removeProvider !== undefined) {
    void removeApiKey(removeKey, removeProvider);
    return;
  }
});

document.body.addEventListener("dragstart", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const section = target.closest("[data-card]");
  if (!(section instanceof HTMLElement)) return;
  event.dataTransfer?.setData("text/plain", section.dataset.card ?? "");
});

document.body.addEventListener("dragover", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest("[data-card]") !== null) event.preventDefault();
});

document.body.addEventListener("drop", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || payload === null) return;
  const section = target.closest("[data-card]");
  if (!(section instanceof HTMLElement)) return;
  event.preventDefault();
  const dragged = event.dataTransfer?.getData("text/plain") ?? "";
  const destination = section.dataset.card ?? "";
  if (dragged.length === 0 || destination.length === 0 || dragged === destination) return;
  const draggedAccount = accountOrderIdForCard(dragged);
  const destinationAccount = accountOrderIdForCard(destination);
  if (draggedAccount.length > 0 && destinationAccount.length > 0) {
    persistAccountOrder(reorderCards(accountIdsOnTab(), draggedAccount, destinationAccount));
    return;
  }
  if (dragged.startsWith("account:") || destination.startsWith("account:")) return;
  const ids = tabOrder(lastCards);
  rememberOrder(reorderCards(ids, dragged, destination), ids);
  saveLayout();
  persistCards();
  paint();
});

document.body.addEventListener("mouseover", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const bar = target.closest("[data-event-index]");
  if (!(bar instanceof HTMLElement) || bar.dataset.eventIndex === undefined) return;
  const index = Number(bar.dataset.eventIndex);
  if (Number.isFinite(index)) showTimelineDetail(index);
});

const searchBox = document.getElementById("search");
if (searchBox instanceof HTMLInputElement) {
  searchBox.addEventListener("input", () => {
    searchText = searchBox.value;
    if (activeTab === "sessions" && sessionDetailRow === null) {
      sessionPage = 1;
      scheduleSessionSearch();
      return;
    }
    renderContent();
  });
}

rpc.send.ready({ title: "tokitoki" });
paint();
void loadPayload(true);
