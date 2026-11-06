const TOKEN_TIERS: Array<[threshold: number, suffix: string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/** Letter-suffixed counts, same scale as the CLI reports. */
export function humanCount(value: number): string {
  const absolute = Math.abs(value);
  for (const tier of TOKEN_TIERS) {
    const threshold = tier[0];
    const suffix = tier[1];
    if (absolute >= threshold) return `${trimZeros((value / threshold).toFixed(2))}${suffix}`;
  }
  return String(Math.round(value));
}

/** Costs match the CLI: cents under $10, whole dollars from $10. */
export function formatCost(usd: number): string {
  if (usd >= 10) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  copilot: "Copilot",
  gemini: "Gemini",
  grok: "Grok",
  pi: "pi",
};

const SLICE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function signInUrl(provider: string): string | undefined {
  if (provider === "cursor") return "https://cursor.com/dashboard";
  if (provider === "claude-code") return "https://claude.ai/login";
  if (provider === "copilot") return "https://github.com/login";
  if (provider === "codex") return "https://chatgpt.com/";
  return undefined;
}

export function isSignInUrl(url: string): boolean {
  return url === signInUrl("cursor") || url === signInUrl("claude-code") || url === signInUrl("copilot") || url === signInUrl("codex");
}

const DASHBOARD_ORIGIN = "http://127.0.0.1:7788";

function dashboardQueryKeys(url: URL, allowed: string[]): boolean {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

/** Local dashboard routes the native menubar already opens. Nothing else. */
const AUTH_STATES = ["login-required", "api-key-required", "temporarily-unavailable"];

function authStateValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !AUTH_STATES.includes(value)) return undefined;
  return value;
}

/** Auth states from `tokitoki poll --json`. Account emails and other fields stay out. */
export function pollAuthStates(json: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const source = record.providerAuthStates !== undefined ? record.providerAuthStates : record;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return {};
  const states: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(key)) continue;
    const value = authStateValue((source as Record<string, unknown>)[key]);
    if (value !== undefined) states[key] = value;
  }
  return states;
}

export function pollResult(json: string): { ok: boolean; detail: string; authJson: string } {
  const states = pollAuthStates(json);
  const authJson = JSON.stringify(states);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, detail: "Quota refresh failed", authJson };
  }
  if (typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === false) {
    const reason = "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : "unknown reason";
    const detail = `Quota refresh failed: ${reason}`.slice(0, 180);
    return { ok: false, detail, authJson };
  }
  return { ok: true, detail: "Provider quotas refreshed", authJson };
}

export function dashboardUrl(pathAndQuery: string): string | undefined {
  const trimmed = pathAndQuery.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\") || trimmed.includes(" ")) return undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed.charCodeAt(index) < 32) return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed, DASHBOARD_ORIGIN);
  } catch {
    return undefined;
  }
  if (url.origin !== DASHBOARD_ORIGIN || url.pathname !== "/") return undefined;
  const view = url.searchParams.get("view");
  if (view === null) {
    if (url.search.length > 0) return undefined;
    return `${DASHBOARD_ORIGIN}/`;
  }
  if (view === "sources" && dashboardQueryKeys(url, ["view"])) return `${DASHBOARD_ORIGIN}/?view=sources`;
  if (view === "reports" && url.searchParams.get("last") === "month" && dashboardQueryKeys(url, ["view", "last"])) {
    return `${DASHBOARD_ORIGIN}/?view=reports&last=month`;
  }
  if (view === "sessions" && dashboardQueryKeys(url, ["view", "provider", "session"])) {
    const provider = url.searchParams.get("provider") ?? "";
    const sessionId = url.searchParams.get("session") ?? "";
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(provider)) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/.test(sessionId)) return undefined;
    return `${DASHBOARD_ORIGIN}/?view=sessions&provider=${encodeURIComponent(provider)}&session=${encodeURIComponent(sessionId)}`;
  }
  return undefined;
}

const CONFIG_PATHS = new Set([
  "notifications.enabled",
  "notifications.resetAware",
  "notifications.burnWarnings",
  "privacy.hideIdentities",
  "poll.adaptive",
  "ui.menubarPreviewEnabled",
  "ui.showHarnessVariants",
]);

const NUMERIC_VALUES: Record<string, number[]> = {
  "notifications.quotaCriticalPercent": [5, 10, 20],
  "notifications.burnWarningRatio": [0.8, 0.9, 1],
  "poll.intervalMinutes": [5, 15, 30, 60],
  "ui.menubarPreviewLines": [1, 2, 3, 4, 5],
};

const ALERT_KINDS = ["quotaCritical", "quotaReset", "quotaPace", "burnRate", "budget"];

const SYNC_BACKENDS = ["none", "dir", "git", "atproto"];

const STRING_VALUES: Record<string, string[]> = {
  "ui.menubarPreviewMode": ["inline", "hover"],
  "ui.stripMetric": ["percent", "tokens", "smart"],
  "ui.stripExhausted": ["reset", "hide", "show"],
};

export function upstreamProvider(provider: string, accountKey: string): string | undefined {
  if (provider === "codex") return "openai";
  if (provider === "claude-code") return "claude";
  if (provider === "gemini-cli") return "gemini";
  if (provider === "grok" || provider === "cursor" || provider === "copilot" || provider === "openrouter") return provider;
  if (provider === "openai" || provider === "claude" || provider === "gemini") return provider;
  if (provider === "pi" || provider === "opencode" || provider === "opencode-go" || provider === "t3code") {
    const key = accountKey.toLowerCase();
    if (key.includes("openrouter")) return "openrouter";
    if (provider === "opencode" || provider === "opencode-go" || key.includes("opencode")) return "opencode";
    if (provider === "t3code") {
      if (key.includes("openai") || key.includes("codex")) return "openai";
      if (key.includes("claude")) return "claude";
      if (key.includes("gemini")) return "gemini";
      if (key.includes("cursor")) return "cursor";
    }
  }
  return undefined;
}

function syncSettingValue(value: string): boolean {
  if (value.length === 0 || value.length > 500) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return false;
  }
  return true;
}

export function panelCommand(input: { action: string; path?: string; value?: string; provider?: string }): string[] | undefined {
  if (input.action === "config") {
    const path = input.path ?? "";
    const value = input.value ?? "";
    if (path === "notifications.disabled") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return undefined;
      }
      if (!Array.isArray(parsed)) return undefined;
      const kinds: string[] = [];
      for (const item of parsed) {
        if (typeof item !== "string" || !ALERT_KINDS.includes(item) || kinds.includes(item)) return undefined;
        kinds.push(item);
      }
      return ["config", "set", path, JSON.stringify(kinds)];
    }
    const numeric = NUMERIC_VALUES[path];
    if (numeric !== undefined) {
      const number = Number(value);
      if (!numeric.includes(number)) return undefined;
      return ["config", "set", path, String(number)];
    }
    if (path === "ui.previewHidden") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return undefined;
      }
      if (!Array.isArray(parsed)) return undefined;
      const ids: string[] = [];
      for (const item of parsed) {
        if (typeof item !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(item) || ids.includes(item)) return undefined;
        ids.push(item);
      }
      return ["config", "set", path, JSON.stringify(ids)];
    }
    const choices = STRING_VALUES[path];
    if (choices !== undefined) {
      if (!choices.includes(value)) return undefined;
      return ["config", "set", path, value];
    }
    if (path === "sync.backend") {
      if (!SYNC_BACKENDS.includes(value)) return undefined;
      return ["config", "set", path, value];
    }
    if (path === "sync.path" || path === "sync.url" || path === "sync.handle") {
      if (!syncSettingValue(value)) return undefined;
      return ["config", "set", path, JSON.stringify(value)];
    }
    if (!CONFIG_PATHS.has(path)) return undefined;
    if (value !== "true" && value !== "false") return undefined;
    return ["config", "set", path, value];
  }
  if (input.action === "sync") return ["sync"];
  if (input.action === "poll-all") return ["poll", "--json"];
  if (input.action === "poll") {
    const provider = input.provider ?? "";
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(provider)) return undefined;
    return ["poll", "--provider", provider, "--json"];
  }
  if (input.action === "poll-enabled") {
    if (input.value === "true") return ["poll", "--enable"];
    if (input.value === "false") return ["poll", "--disable"];
  }
  if (input.action === "ui-hide" || input.action === "ui-show") {
    const target = input.value ?? "";
    if (!/^[a-z][a-z0-9-]*:[^\s]{1,200}$/.test(target)) return undefined;
    const flag = input.action === "ui-hide" ? "--hide" : "--show";
    return ["ui", flag, target, "--surface", "widget"];
  }
  if (input.action === "card-set") {
    const spec = input.value ?? "";
    if (!/^[a-z]+:[01](,[a-z]+:[01])*$/.test(spec)) return undefined;
    return ["ui", "--card-set", spec];
  }
  if (input.action === "tabs") {
    const ids = (input.value ?? "").split(",").filter((id) => id.length > 0);
    if (ids.length === 0) return undefined;
    const seen: string[] = [];
    for (const id of ids) {
      if (!TAB_IDS.includes(id) || seen.includes(id)) return undefined;
      seen.push(id);
    }
    return ["ui", "--tabs", seen.join(",")];
  }
  if (input.action === "account-order") return accountOrderCommand(input.value ?? "");
  return undefined;
}

function accountOrderIdentifier(value: string): boolean {
  if (value.length < 3 || value.length > 220) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at >= value.length - 1) return false;
  const provider = value.slice(0, at);
  const accountKey = value.slice(at + 1);
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(provider)) return false;
  if (accountKey.length > 180) return false;
  for (let index = 0; index < accountKey.length; index += 1) {
    const code = accountKey.charCodeAt(index);
    if (code <= 32 || code === 34 || code === 39 || code === 44 || code === 92) return false;
  }
  return true;
}

function accountOrderList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !accountOrderIdentifier(item) || ids.includes(item)) return undefined;
    ids.push(item);
  }
  return ids;
}

export function accountOrderCommand(value: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { quota?: unknown; bar?: unknown };
  const quota = accountOrderList(record.quota);
  const bar = accountOrderList(record.bar);
  if (quota === undefined || bar === undefined) return undefined;
  return ["ui", "--account-order", quota.join(","), "--bar-account-order", bar.join(",")];
}

/** Keep absent and hidden slots, and write the dragged visible accounts into those slots. */
export function reorderQuotaAccounts(visibleIds: string[], saved: string[], barOrder: string[] | undefined, accounts: string[]): { quota: string[]; bar: string[] } {
  const complete = completeAccountOrder(saved, accounts);
  const moved = new Set(visibleIds);
  let cursor = 0;
  const quota: string[] = [];
  for (const id of complete) {
    if (moved.has(id)) {
      quota.push(visibleIds[cursor] ?? id);
      cursor += 1;
    } else {
      quota.push(id);
    }
  }
  const barSaved = barOrder === undefined ? saved : barOrder;
  return { quota, bar: completeAccountOrder(barSaved, accounts) };
}

export function completeAccountOrder(saved: string[], accounts: string[]): string[] {
  const ids: string[] = [];
  for (const id of saved) if (!ids.includes(id)) ids.push(id);
  for (const id of accounts) if (!ids.includes(id)) ids.push(id);
  return ids;
}

export function importCommand(file: string): string[] | undefined {
  const trimmed = file.trim();
  if (trimmed.length === 0 || trimmed.length > 500 || trimmed.startsWith("-")) return undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed.charCodeAt(index) < 32) return undefined;
  }
  if (!trimmed.toLowerCase().endsWith(".csv")) return undefined;
  return ["import", trimmed];
}

const TAB_IDS = ["overview", "quotas", "tokens", "reports", "sources", "mcp", "settings"];

const TAB_TITLES: Record<string, string> = {
  overview: "Home",
  quotas: "Quotas",
  tokens: "Tokens",
  reports: "Reports",
  sessions: "Sessions",
  sources: "Sources",
  mcp: "MCP",
  settings: "Settings",
};

export function orderedTabs(saved: string[] | undefined): string[] {
  const order: string[] = [];
  for (const id of saved ?? []) {
    if (TAB_IDS.includes(id) && !order.includes(id)) order.push(id);
  }
  for (const id of TAB_IDS) if (!order.includes(id)) order.push(id);
  return order;
}

export function tabTitle(id: string): string {
  return TAB_TITLES[id] ?? id;
}

export function popupTabIds(saved: string[] | undefined): string[] {
  const savedOrder = orderedTabs(saved);
  const ids = savedOrder.slice(0, 4);
  ids.push("sessions");
  for (const id of savedOrder.slice(4)) ids.push(id);
  return ids;
}

export function orderedAccounts<T extends { provider?: string; accountKey?: string }>(accounts: T[], order: string[], hidden: string[]): T[] {
  const visible: T[] = [];
  for (const account of accounts) {
    const target = `${account.provider ?? ""}:${account.accountKey ?? ""}`;
    if (hidden.includes(target)) continue;
    visible.push(account);
  }
  const sorted = visible.slice();
  sorted.sort((left, right) => {
    const leftId = `${left.provider ?? ""}@${left.accountKey ?? ""}`;
    const rightId = `${right.provider ?? ""}@${right.accountKey ?? ""}`;
    const leftRank = order.indexOf(leftId);
    const rightRank = order.indexOf(rightId);
    if (leftRank < 0 && rightRank < 0) return 0;
    if (leftRank < 0) return 1;
    if (rightRank < 0) return -1;
    return leftRank - rightRank;
  });
  return sorted;
}

const PERSISTED_CARDS = ["limits", "usage", "spend", "harness", "activity", "anomalies", "repos", "tools"];

export function cardSetSpec(order: string[], hidden: string[]): string {
  const parts: string[] = [];
  const seen: string[] = [];
  for (const id of order) {
    if (!PERSISTED_CARDS.includes(id) || seen.includes(id)) continue;
    seen.push(id);
    parts.push(`${id}:${hidden.includes(id) ? "0" : "1"}`);
  }
  for (const id of PERSISTED_CARDS) {
    if (seen.includes(id)) continue;
    parts.push(`${id}:${hidden.includes(id) ? "0" : "1"}`);
  }
  return parts.join(",");
}

export function privateTitle(title: string, hideIdentities: boolean): string {
  if (!hideIdentities) return title;
  return title.replace(/[^\s@]+@[^\s@]+/g, "hidden identity");
}

export function providerName(id: string): string {
  const known = PROVIDER_NAMES[id];
  return known ?? id;
}

export function sliceColor(index: number): string {
  const color = SLICE_COLORS[index % SLICE_COLORS.length];
  return color ?? "#8e8e8e";
}

export function tokenCount(row: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  tokens?: number;
}): number {
  if (typeof row.tokens === "number" && Number.isFinite(row.tokens)) return row.tokens;
  return (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
}

export interface QuotaWindow {
  id?: string;
  label?: string;
  kind?: string;
  source?: string;
  status?: string;
  usedPct?: number;
  usedPercent?: number;
  amountUsd?: number;
  cost?: number;
  tokens?: number;
  requests?: number;
  resetsAt?: string;
  observedAt?: string;
  windowStart?: string;
  windowEnd?: string;
  pace?: { status?: string; deltaPercent?: number; expectedPercent?: number; runsOutAt?: string };
}

export interface QuotaAccount {
  provider?: string;
  accountKey?: string;
  email?: string;
  label?: string;
  plan?: string;
  planLabel?: string;
  vendor?: string;
  origin?: string;
  freshness?: string;
  observedAt?: string;
  windows?: QuotaWindow[];
  budgetWindows?: QuotaWindow[];
  extraUsage?: { enabled?: boolean; usedUsd?: number; limitUsd?: number; usedPercent?: number };
  balance?: { currency?: string; remaining?: number; total?: number };
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null };
  bankedResets?: number;
  bankedExpiresAt?: string;
}

export interface ServiceIncident {
  vendor: string;
  indicator: string;
  description: string;
  url: string;
}

function money(value: number, currency: string | undefined): string {
  if ((currency ?? "USD").toUpperCase() === "USD") return formatCost(value);
  return `${value.toFixed(2)} ${currency ?? ""}`.trim();
}

/** Extra usage, prepaid balance, workspace credits, and banked resets. Same rows as the native account card. */
export function accountExtraLines(account: QuotaAccount, now: number): string[] {
  const lines: string[] = [];
  const banked = account.bankedResets;
  if (typeof banked === "number" && Number.isFinite(banked) && banked > 0) {
    const count = Math.floor(banked);
    const expiry = account.bankedExpiresAt;
    const when = expiry !== undefined && expiry.length > 0 ? ` (expires ${expiry.slice(0, 16).replace("T", " ")} · ${resetLabel(expiry, now)})` : "";
    lines.push(`${count} banked reset${count === 1 ? "" : "s"}${when}`);
  }
  const extra = account.extraUsage;
  if (extra?.enabled === true) {
    let value = "";
    if (typeof extra.usedUsd === "number" && typeof extra.limitUsd === "number") value = `${formatCost(extra.usedUsd)} / ${formatCost(extra.limitUsd)}`;
    else if (typeof extra.usedUsd === "number") value = formatCost(extra.usedUsd);
    else if (typeof extra.usedPercent === "number") value = `${Math.round(extra.usedPercent)}% used`;
    if (value.length > 0) lines.push(`Extra usage ${value}`);
  }
  const credits = account.credits;
  if (credits?.unlimited === true) lines.push("Unlimited workspace credits");
  else if (typeof credits?.balance === "string" && credits.balance.trim().length > 0) lines.push(`Workspace credits ${credits.balance.trim()}`);
  const balance = account.balance;
  if (typeof balance?.remaining === "number" && Number.isFinite(balance.remaining)) {
    const total = typeof balance.total === "number" && Number.isFinite(balance.total) ? ` / ${money(balance.total, balance.currency)}` : "";
    lines.push(`Balance ${money(balance.remaining, balance.currency)}${total}`);
  }
  return lines;
}

export function accountVendor(provider: string, registry: Record<string, { vendor?: string }> | undefined): string {
  const entry = registry?.[provider];
  const vendor = entry?.vendor;
  if (typeof vendor === "string" && vendor.length > 0) return vendor;
  return provider;
}

/** Vendor status incidents from the widget payload. `none` and malformed rows stay out. */
export function serviceIncidents(source: unknown): ServiceIncident[] {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return [];
  const incidents: ServiceIncident[] = [];
  const record = source as Record<string, unknown>;
  for (const vendor of Object.keys(record)) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(vendor)) continue;
    const value = record[vendor];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const incident = value as Record<string, unknown>;
    const indicator = incident.indicator;
    if (indicator !== "minor" && indicator !== "major" && indicator !== "critical") continue;
    const description = typeof incident.description === "string" ? incident.description.trim().slice(0, 180) : "";
    const rawUrl = typeof incident.url === "string" ? incident.url : "";
    const url = isPublicHttpsUrl(rawUrl) ? rawUrl : "";
    incidents.push({ vendor, indicator, description, url });
  }
  incidents.sort((left, right) => left.vendor.localeCompare(right.vendor));
  return incidents;
}

export function isPublicHttpsUrl(url: string): boolean {
  if (url.length === 0 || url.length > 500) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  if (parsed.hostname.length === 0 || parsed.hostname === "localhost") return false;
  return true;
}

export function usedPercent(window: QuotaWindow): number | undefined {
  const value = window.usedPercent ?? window.usedPct;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

export function remainingPercent(window: QuotaWindow): number | undefined {
  const used = usedPercent(window);
  if (used === undefined) return undefined;
  return Math.max(0, Math.min(100, 100 - used));
}

export function barTone(used: number): "ok" | "warn" | "critical" {
  if (used >= 90) return "critical";
  if (used >= 70) return "warn";
  return "ok";
}

export function resetLabel(resetsAt: string | undefined, now: number): string {
  if (resetsAt === undefined || resetsAt.length === 0) return "—";
  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return "—";
  const delta = end - now;
  if (delta <= 0) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function ageLabel(iso: string | undefined, now: number): string {
  if (iso === undefined || iso.length === 0) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const delta = now - then;
  if (delta < 60_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function windowStatusLabel(window: QuotaWindow): string {
  if (window.status === undefined || window.status === "current") return "";
  return window.status;
}

export interface WindowSummary {
  headline: string;
  detail: string;
  usedPercent: number | undefined;
}

function paceText(window: QuotaWindow): string {
  const pace = window.pace;
  if (pace === undefined || pace.status === undefined) return "";
  const delta = Math.round(Math.abs(pace.deltaPercent ?? 0));
  if (pace.status === "over") return `${delta}% ahead of pace`;
  if (pace.status === "under") return `${delta}% under pace`;
  if (pace.status === "on") return "on pace";
  return "";
}

export function windowSummary(window: QuotaWindow, now: number): WindowSummary {
  const status = windowStatusLabel(window);
  const used = usedPercent(window);
  const measures: string[] = [];
  if (typeof window.tokens === "number" && window.tokens > 0) measures.push(`${humanCount(window.tokens)} tokens`);
  const money = window.amountUsd ?? window.cost;
  if (typeof money === "number" && money > 0) measures.push(formatCost(money));
  if (typeof window.requests === "number" && window.requests > 0) measures.push(`${humanCount(window.requests)} requests`);
  const reset = resetLabel(window.resetsAt, now);
  let headline = measures[0] ?? "";
  if (status.length > 0) headline = status;
  else if (used !== undefined) headline = `${Math.round(100 - used)}% left`;
  const detailParts: string[] = [];
  if (status.length > 0) {
    for (const measure of measures) detailParts.push(measure);
    if (reset !== "—") detailParts.push(reset === "now" ? "reset passed" : `reset ${reset}`);
    const seen = ageLabel(window.observedAt, now);
    if (seen !== "—") detailParts.push(seen === "just now" ? "seen just now" : `seen ${seen}`);
    const pace = paceText(window);
    if (pace.length > 0) detailParts.push(pace);
  } else if (used !== undefined && reset !== "—") {
    detailParts.push(reset === "now" ? "resets now" : `resets in ${reset}`);
    for (const measure of measures) detailParts.push(measure);
    const pace = paceText(window);
    if (pace.length > 0) detailParts.push(pace);
  } else {
    for (const measure of measures.slice(headline === measures[0] ? 1 : 0)) detailParts.push(measure);
  }
  return {
    headline,
    detail: detailParts.join(" · "),
    usedPercent: status.length === 0 ? used : undefined,
  };
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function systemTrayPopupFrame(input: {
  trayBounds: Rectangle | undefined;
  workArea: Rectangle;
  popupWidth: number;
  popupHeight: number;
  gap: number;
  bottomInset?: number;
}): Rectangle {
  const gap = input.gap;
  const bottomInset = input.bottomInset ?? 0;
  const width = Math.min(input.popupWidth, Math.max(240, input.workArea.width - gap * 2));
  const height = Math.min(input.popupHeight, Math.max(240, input.workArea.height - gap * 2));
  const tray = input.trayBounds;
  const trayIsVisible = tray !== undefined && tray.width > 0 && tray.height > 0;
  let x = input.workArea.x + input.workArea.width - width - gap;
  let y = input.workArea.y + input.workArea.height - height - gap - bottomInset;
  if (trayIsVisible && tray !== undefined) {
    x = tray.x + tray.width - width;
    const iconMidpoint = tray.y + tray.height / 2;
    const workAreaMidpoint = input.workArea.y + input.workArea.height / 2;
    if (iconMidpoint >= workAreaMidpoint) y = tray.y - height - gap;
    else y = tray.y + tray.height + gap;
  }
  const minimumX = input.workArea.x + gap;
  const maximumX = input.workArea.x + input.workArea.width - width - gap;
  const minimumY = input.workArea.y + gap;
  const maximumY = input.workArea.y + input.workArea.height - height - gap - bottomInset;
  if (x < minimumX) x = minimumX;
  if (x > maximumX) x = maximumX;
  if (y < minimumY) y = minimumY;
  if (y > maximumY) y = maximumY;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function displayWindows(account: QuotaAccount): QuotaWindow[] {
  const shown: QuotaWindow[] = [];
  for (const window of account.windows ?? []) shown.push(window);
  for (const window of account.budgetWindows ?? []) shown.push(window);
  return shown;
}

export function toolEntries(
  value: { rows?: Array<{ tool?: string; costUsd?: number; requests?: number }>; tools?: Array<{ tool?: string; costUsd?: number; requests?: number }> } | Array<{ tool?: string; costUsd?: number; requests?: number }> | undefined,
): Array<{ tool?: string; costUsd?: number; requests?: number }> {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (value.tools !== undefined) return value.tools;
  return value.rows ?? [];
}

export function isLocalWindow(window: QuotaWindow): boolean {
  if (window.source === "derived") return true;
  const id = window.id ?? "";
  return id.startsWith("local:");
}

export function windowTitle(window: QuotaWindow): string {
  if (window.label !== undefined && window.label.length > 0) return window.label;
  if (window.kind !== undefined && window.kind.length > 0) return window.kind;
  return "window";
}

export function currentWindows(account: QuotaAccount): QuotaWindow[] {
  const windows = account.windows ?? [];
  const reported: QuotaWindow[] = [];
  for (const window of windows) {
    if (window.source === "derived") continue;
    if (window.status !== undefined && window.status !== "current") continue;
    if (usedPercent(window) === undefined && window.amountUsd === undefined) continue;
    reported.push(window);
  }
  if (reported.length > 0) return reported;
  const anyPercent: QuotaWindow[] = [];
  for (const window of windows) {
    if (usedPercent(window) !== undefined || window.amountUsd !== undefined) anyPercent.push(window);
  }
  return anyPercent;
}

export function tightestWindow(account: QuotaAccount): QuotaWindow | undefined {
  let best: QuotaWindow | undefined;
  let bestRemaining = Number.POSITIVE_INFINITY;
  for (const window of currentWindows(account)) {
    const remaining = remainingPercent(window);
    if (remaining === undefined) continue;
    if (remaining < bestRemaining) {
      best = window;
      bestRemaining = remaining;
    }
  }
  return best;
}

export function accountTitle(account: QuotaAccount): string {
  if (account.label !== undefined && account.label.length > 0) return account.label;
  if (account.email !== undefined && account.email.length > 0) return account.email;
  const provider = account.provider ?? "account";
  const key = account.accountKey ?? "";
  return key.length > 0 ? `${providerName(provider)} · ${key}` : providerName(provider);
}

export interface DonutArc {
  portion: number;
  offset: number;
}

export function donutArcs(values: number[]): DonutArc[] {
  let total = 0;
  for (const value of values) total += value;
  const arcs: DonutArc[] = [];
  let offset = 0;
  for (const value of values) {
    const portion = total <= 0 ? 0 : (value / total) * 100;
    arcs.push({ portion, offset });
    offset += portion;
  }
  return arcs;
}

export function tokitokiCommandCandidates(input: {
  executableOverride: string | undefined;
  localApplicationData: string | undefined;
  pathSeparator: string;
  repositoryCli: string | undefined;
  repositoryCliExists: boolean;
  bunExecutable: string | undefined;
}): string[][] {
  const candidates: string[][] = [];
  if (input.executableOverride !== undefined && input.executableOverride.length > 0) {
    candidates.push([input.executableOverride]);
  }
  if (input.localApplicationData !== undefined && input.localApplicationData.length > 0) {
    const separator = input.pathSeparator;
    candidates.push([input.localApplicationData + separator + "tokitoki" + separator + "tokitoki.exe"]);
  }
  if (input.repositoryCliExists && input.repositoryCli !== undefined && input.bunExecutable !== undefined) {
    candidates.push([input.bunExecutable, input.repositoryCli]);
  }
  candidates.push(["tokitoki"]);
  return candidates;
}
