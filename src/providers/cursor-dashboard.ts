import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { EventCache } from "../cache.ts";
import { eventId, localMachineId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { appendEvents, dataDir } from "../store.ts";
import type { UsageEvent } from "../types.ts";

/**
 * Same endpoint T3 Code's Usage page reads. One account response already
 * includes the IDE, the CLI, and headless T3 sessions, so those turns are
 * not added again from statev2.sqlite.
 */
export const CURSOR_DASHBOARD_USAGE_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";

const PAGE_SIZE = 1000;
const MAX_PAGES = 40;
const FIRST_WINDOW_MS = 90 * 24 * 3600_000;
const OVERLAP_MS = 3600_000;

/** `WorkosCursorSessionToken` cookie T3 sends, or null when the token is not a Cursor login JWT. */
export function cursorWorkosCookie(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown };
    if (typeof parsed.sub !== "string" || parsed.sub.length === 0) return null;
    const userId = parsed.sub.split("|").at(-1);
    if (userId === undefined || userId.length === 0) return null;
    return `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`;
  } catch {
    return null;
  }
}

/** Missing counts are zero, matching T3. A present non-number is invalid. */
function countOrZero(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Turn one dashboard page into usage events. Identical rows in a page get a
 * stable occurrence suffix so a later poll of the same page dedupes.
 */
export function cursorDashboardUsageEvents(input: {
  body: unknown;
  machineId: string;
  accountKey?: string;
}): UsageEvent[] {
  if (typeof input.body !== "object" || input.body === null || Array.isArray(input.body)) return [];
  const rawEvents = (input.body as { usageEventsDisplay?: unknown }).usageEventsDisplay;
  if (!Array.isArray(rawEvents)) return [];

  const accountKey = input.accountKey ?? "default";
  const seen = new Map<string, number>();
  const events: UsageEvent[] = [];
  for (const raw of rawEvents) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as Record<string, unknown>;
    if (event.tokenUsage === undefined || event.tokenUsage === null) continue;
    if (typeof event.tokenUsage !== "object") continue;
    const usage = event.tokenUsage as Record<string, unknown>;
    const inputTokens = countOrZero(usage.inputTokens);
    const outputTokens = countOrZero(usage.outputTokens);
    const cacheReadTokens = countOrZero(usage.cacheReadTokens);
    const cacheWriteTokens = countOrZero(usage.cacheWriteTokens);
    const totalCents = usage.totalCents === undefined || usage.totalCents === null ? null : countOrZero(usage.totalCents);
    if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null) continue;
    if (typeof event.model !== "string" || event.model.length === 0) continue;
    const timestampMs = typeof event.timestamp === "string" ? Number(event.timestamp) : event.timestamp;
    if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) continue;
    const sessionId = typeof event.conversationId === "string" ? event.conversationId : "";
    const counts = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
    const reported = totalCents === null ? null : totalCents / 100;
    const identity = JSON.stringify([timestampMs, event.model, sessionId, counts, reported]);
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    events.push({
      id: eventId("cursor", accountKey, sessionId.length > 0 ? sessionId : "account", `${shortHash(identity)}:${occurrence}`),
      ts: new Date(timestampMs).toISOString(),
      machineId: input.machineId,
      provider: "cursor",
      accountKey,
      model: event.model,
      ...counts,
      costUsd: reported ?? estimateCost(event.model, counts),
      ...(sessionId.length > 0 ? { sessionId } : {}),
    });
  }
  return events;
}

function statePath(): string {
  return path.join(dataDir(), "cursor-dashboard.json");
}

function readSince(now: number): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8")) as { sinceMs?: unknown };
    if (typeof parsed.sinceMs === "number" && Number.isFinite(parsed.sinceMs)) return parsed.sinceMs;
  } catch {
    // first sync
  }
  return now - FIRST_WINDOW_MS;
}

function writeSince(sinceMs: number): void {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sinceMs }));
}

/**
 * Pull account usage with the same login the quota poll already uses.
 * Failures leave the watermark where it was so the next poll retries.
 */
export async function syncCursorDashboardUsage(input: {
  accessToken: string;
  fetcher: typeof fetch;
  cache?: EventCache;
  now?: number;
  machineId?: string;
}): Promise<number> {
  const cookie = cursorWorkosCookie(input.accessToken);
  if (cookie === null) return 0;
  const now = input.now ?? Date.now();
  const sinceMs = readSince(now);
  const machineId = input.machineId ?? localMachineId();
  const collected: UsageEvent[] = [];
  let newest = sinceMs;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await input.fetcher(CURSOR_DASHBOARD_USAGE_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        Origin: "https://cursor.com",
        Cookie: cookie,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        page,
        pageSize: PAGE_SIZE,
        startDate: String(sinceMs),
        endDate: String(now),
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    const pageEvents = cursorDashboardUsageEvents({ body, machineId });
    collected.push(...pageEvents);
    for (const event of pageEvents) {
      const ts = Date.parse(event.ts);
      if (Number.isFinite(ts) && ts > newest) newest = ts;
    }
    const displayed = typeof body === "object" && body !== null && Array.isArray((body as { usageEventsDisplay?: unknown }).usageEventsDisplay)
      ? (body as { usageEventsDisplay: unknown[] }).usageEventsDisplay.length
      : 0;
    if (displayed < PAGE_SIZE) break;
  }

  if (collected.length > 0) {
    appendEvents(collected);
    input.cache?.insert(collected);
  }
  writeSince(Math.max(sinceMs, newest - OVERLAP_MS));
  return collected.length;
}
