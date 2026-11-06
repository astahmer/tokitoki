import { formatCost, humanCount } from "./format.ts";

export interface SessionListRow {
  sessionId: string;
  provider: string;
  accountKey: string;
  startedAt: string;
  title: string;
  snippet: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

export interface SessionListPage {
  rows: SessionListRow[];
  page: number;
  hasMore: boolean;
}

export interface SessionEvent {
  n: number;
  ts: string;
  model: string;
  description: string;
  tokenSource: string;
  tokens: number;
  runningTokens: number;
  costUsd: number;
}

export interface SessionDetailPage {
  provider: string;
  sessionId: string;
  conversationTitle: string;
  conversationBody: string;
  events: SessionEvent[];
  eventsTotal: number;
  eventsOffset: number;
  eventsHasMore: boolean;
  cacheDuration: {
    estimatedSeconds: number | null;
    confidence: string;
    samples: number;
    busts: number;
  } | null;
}

export function sessionListArguments(query: string, page: number): string[] {
  const pageNumber = Math.max(1, Math.floor(page));
  const args = ["sessions", "--cached", "--last", "month", "--top", "25", "--page", String(pageNumber), "--json"];
  const trimmed = query.trim();
  if (trimmed.length > 0) args.push("--search", trimmed);
  return args;
}

export function sessionDetailArguments(provider: string, sessionId: string, offset: number): string[] {
  const start = Math.max(0, Math.floor(offset));
  return [
    "sessions",
    "--cached",
    "--provider",
    provider,
    "--session",
    sessionId,
    "--events-limit",
    "40",
    "--events-offset",
    String(start),
    "--json",
  ];
}

function textValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

export function sessionTitle(row: { title?: string }): string {
  const title = textValue(row.title).replace(/\s+/g, " ").trim();
  return title.length > 0 ? title : "(no title)";
}

export function sessionSnippet(row: { title?: string; snippet?: string }): string {
  let raw = textValue(row.snippet).split("[[").join("").split("]]").join("");
  raw = raw.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  const title = textValue(row.title).replace(/\s+/g, " ").trim();
  if (title.length > 0 && raw.startsWith(title)) {
    raw = raw.slice(title.length).replace(/^[\s.:\-–—]+/, "").trim();
  }
  return raw.length > 0 ? raw : "No preview for this session.";
}

export function sessionStats(row: { requests?: number; totalTokens?: number; costUsd?: number }): string {
  let text = `${humanCount(numberValue(row.requests))} req · ${humanCount(numberValue(row.totalTokens))} tok`;
  const cost = numberValue(row.costUsd);
  if (cost > 0) text += ` · ${formatCost(cost)}`;
  return text;
}

export function sessionClock(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "unknown time";
  const date = new Date(parsed);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}`;
}

export function eventClock(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "unknown time";
  const date = new Date(parsed);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function intervalText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "not enough evidence";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.max(1, Math.round(minutes / 60));
  if (hours < 48) return `${hours}h`;
  return `${Math.max(1, Math.round(hours / 24))}d`;
}

export function cacheDurationText(estimate: SessionDetailPage["cacheDuration"]): string {
  if (estimate === null) return "";
  let confidence = estimate.confidence;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") confidence = "unknown";
  const samples = Math.max(0, Math.round(estimate.samples));
  const busts = Math.max(0, Math.round(estimate.busts));
  const resetLabel = busts === 1 ? "reset" : "resets";
  return `Estimated cache lifetime ≈ ${intervalText(estimate.estimatedSeconds)} · ${confidence} confidence. Based on ${busts} observed cache ${resetLabel} across ${samples} requests; an estimate, not a provider guarantee.`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("the command returned an invalid sessions payload");
  return value as Record<string, unknown>;
}

export function parseSessionList(raw: string): SessionListPage {
  const data = record(JSON.parse(raw));
  if (!Array.isArray(data.rows)) throw new Error("the command returned an invalid sessions payload");
  const rows: SessionListRow[] = [];
  for (const item of data.rows) {
    const row = record(item);
    const sessionId = textValue(row.sessionId);
    const provider = textValue(row.provider);
    if (sessionId.length === 0 || provider.length === 0) continue;
    rows.push({
      sessionId,
      provider,
      accountKey: textValue(row.accountKey),
      startedAt: textValue(row.startedAt),
      title: textValue(row.title),
      snippet: textValue(row.snippet),
      requests: numberValue(row.requests),
      totalTokens: numberValue(row.totalTokens),
      costUsd: numberValue(row.costUsd),
    });
  }
  const page = numberValue(data.page);
  return { rows, page: page > 0 ? page : 1, hasMore: data.hasMore === true };
}

function eventTokens(row: Record<string, unknown>): number {
  return numberValue(row.inputTokens) + numberValue(row.outputTokens) + numberValue(row.cacheReadTokens) + numberValue(row.cacheWriteTokens);
}

export function parseSessionDetail(raw: string, provider: string, sessionId: string): SessionDetailPage {
  const data = record(JSON.parse(raw));
  if (textValue(data.provider) !== provider || textValue(data.sessionId) !== sessionId) {
    throw new Error("the command returned a different session");
  }
  const events: SessionEvent[] = [];
  const incoming = Array.isArray(data.events) ? data.events : [];
  const eventsOffset = Math.max(0, Math.floor(numberValue(data.eventsOffset)));
  for (const item of incoming) {
    const row = record(item);
    events.push({
      n: eventsOffset + events.length + 1,
      ts: textValue(row.ts),
      model: textValue(row.model),
      description: textValue(row.description),
      tokenSource: textValue(row.tokenSource),
      tokens: eventTokens(row),
      runningTokens: numberValue(row.runningTokens),
      costUsd: numberValue(row.costUsd),
    });
  }
  let conversationTitle = "";
  let conversationBody = "";
  if (typeof data.conversation === "object" && data.conversation !== null) {
    const conversation = record(data.conversation);
    conversationTitle = textValue(conversation.title);
    conversationBody = textValue(conversation.body);
  }
  let cacheDuration: SessionDetailPage["cacheDuration"] = null;
  if (typeof data.cacheDuration === "object" && data.cacheDuration !== null) {
    const estimate = record(data.cacheDuration);
    const seconds = estimate.estimatedSeconds;
    cacheDuration = {
      estimatedSeconds: typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null,
      confidence: textValue(estimate.confidence),
      samples: numberValue(estimate.samples),
      busts: numberValue(estimate.busts),
    };
  }
  const eventsTotal = Math.max(0, Math.floor(numberValue(data.eventsTotal)));
  let eventsHasMore = typeof data.eventsHasMore === "boolean" ? data.eventsHasMore : eventsOffset + events.length < eventsTotal;
  if (events.length === 0) eventsHasMore = false;
  return {
    provider,
    sessionId,
    conversationTitle,
    conversationBody,
    events,
    eventsTotal,
    eventsOffset,
    eventsHasMore,
    cacheDuration,
  };
}

export function appendSessionEvents(current: SessionEvent[], page: SessionDetailPage, requestedOffset: number): SessionEvent[] {
  if (page.eventsOffset !== requestedOffset) throw new Error("the command returned an unexpected event page");
  if (requestedOffset > 0 && requestedOffset !== current.length) throw new Error("the command returned an unexpected event page");
  if (requestedOffset === 0) return page.events;
  const combined: SessionEvent[] = [];
  for (const event of current) combined.push(event);
  for (const event of page.events) combined.push(event);
  return combined;
}

export function eventDetailLines(event: SessionEvent): { heading: string; description: string; meta: string } {
  const estimated = event.tokenSource === "estimated";
  const description = event.description.length > 0 ? event.description : `model response · ${event.model}`;
  const marker = estimated ? "≈" : "";
  const estimatedLabel = estimated ? " estimated" : "";
  return {
    heading: `Request ${event.n} · ${eventClock(event.ts)}`,
    description,
    meta: `${event.model} · ${marker}${humanCount(event.tokens)} tokens${estimatedLabel} · ${formatCost(event.costUsd)}`,
  };
}

export function eventShare(tokens: number, maximum: number): number {
  if (maximum <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((tokens / maximum) * 100)));
}
