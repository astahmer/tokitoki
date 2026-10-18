import { monthStartIso, sinceIsoFor } from "./report.ts";
import type { EventCache } from "./cache.ts";
import type { BlockRow } from "./blocks.ts";
import { providerInfo } from "./provider-registry.ts";
import { vendorForProvider } from "./model-provider.ts";
import { cachedStatusIncidents, refreshStatusIncidents, type IncidentIndicator } from "./status-incidents.ts";
import { knownAccountVendors } from "./widget-providers.ts";

/**
 * Claude Code statusline hook integration: reads the hook's stdin JSON,
 * answers with ONE line summarizing session/today/MTD spend plus the active
 * 5-hour billing block. Missing data degrades gracefully — segments are
 * omitted rather than zero-filled, so partial installs still render.
 */

export interface StatuslineInput {
  sessionId?: string;
  modelName?: string;
}

/** Parse the statusline hook stdin: {session_id, model:{display_name}}. */
export function parseStatuslineStdin(raw: string): StatuslineInput {
  try {
    const parsed = JSON.parse(raw) as {
      session_id?: unknown;
      model?: { display_name?: unknown };
    };
    return {
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
      modelName:
        typeof parsed.model?.display_name === "string" ? parsed.model.display_name : undefined,
    };
  } catch {
    return {};
  }
}

const INDICATOR_WORDS: Record<IncidentIndicator, string> = {
  none: "ok",
  minor: "degraded",
  major: "partial outage",
  critical: "outage",
};

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** One short segment for the worst degraded vendor among this machine's accounts. */
export const incidentSegment = (incidents: Record<string, { indicator: IncidentIndicator; description: string }>): string | undefined => {
  const rank: Record<IncidentIndicator, number> = { none: 0, minor: 1, major: 2, critical: 3 };
  const worst = Object.entries(incidents)
    .filter(([, incident]) => incident.indicator !== "none")
    .sort(([, a], [, b]) => rank[b.indicator] - rank[a.indicator])[0];
  if (worst === undefined) return undefined;
  const [vendor, incident] = worst;
  const head = `${providerInfo(vendor).shortName} ${INDICATOR_WORDS[incident.indicator]}`;
  return incident.description.length > 0 ? `${head}: ${truncate(incident.description, 32)}` : head;
};

/** Render the single statusline. Never throws; empty string when no data. */
export async function renderStatusline(
  input: StatuslineInput,
  cache: EventCache,
  now: number = Date.now(),
  options: { refreshIncidents?: boolean; fetcher?: typeof fetch } = {},
): Promise<string> {
  const segments: string[] = [];

  if (input.modelName !== undefined) segments.push(input.modelName);

  // Session cost first (most specific), then day/MTD from the rollup-backed
  // spend snapshot (one query pair for both windows).
  if (input.sessionId !== undefined) {
    const row = cache.database
      .query(
        "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM events WHERE session_id = ?",
      )
      .get(input.sessionId) as { c: number };
    if (row.c > 0) segments.push(`$${row.c.toFixed(2)} sess`);
  }

  const monthStart = monthStartIso(new Date(now));
  // spendSnapshot(dayIso, weekIso, monthIso) — we only surface day + MTD.
  const snap = cache.spendSnapshot(sinceIsoFor("day", new Date(now)), monthStart, monthStart);
  if (snap.totals.day > 0) segments.push(`$${snap.totals.day.toFixed(2)} today`);
  if (snap.totals.month > 0) segments.push(`$${snap.totals.month.toFixed(2)} MTD`);

  // Active billing block: prefer one belonging to the account that owns this
  // session; fall back to any account's active block. Used% prefers the
  // provider-reported quota snapshot (codex rate_limits) when present; the
  // synthetic 5h block has no provider cap, so it falls back to elapsed-time
  // fraction — labeled honestly either way.
  const dayAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const owner =
    input.sessionId !== undefined
      ? (
          cache.database
            .query("SELECT account_key, provider FROM events WHERE session_id = ? LIMIT 1")
            .get(input.sessionId) as { account_key?: string; provider?: string } | undefined
        )
      : undefined;

  // Owner's own blocks first; any account's active block as fallback.
  let active: BlockRow | undefined;
  if (owner?.account_key !== undefined) {
    active = cache
      .blockWindows(dayAgoIso, undefined, owner.account_key, { now })
      .find((b) => b.isActive);
  }
  if (active === undefined) {
    active = cache.blockWindows(dayAgoIso, undefined, undefined, { now }).find((b) => b.isActive);
  }

  if (active !== undefined) {
    const remainingMin = Math.max(0, Math.round((Date.parse(active.endIso) - now) / 60000));
    let usedPct: number | undefined;
    if (owner?.provider !== undefined && owner.account_key !== undefined) {
      const snaps = cache.latestQuotaSnapshots(owner.provider, owner.account_key);
      const primary = snaps.find((s) => s.windowMinutes === 300) ?? snaps[0];
      if (primary !== undefined) usedPct = Math.round(primary.usedPct);
    }
    if (usedPct === undefined) {
      usedPct = Math.min(100, Math.max(0,
        Math.round(((now - Date.parse(active.startIso)) / (5 * 60 * 60 * 1000)) * 100)));
    }
    segments.push(`block ${usedPct}% (${remainingMin}m left)`);
  }

  // The hook runs constantly: refresh only the session vendor's page (TTL
  // cached), but report any account vendor already known to be degraded.
  const vendors = knownAccountVendors(cache);
  if (options.refreshIncidents === true) {
    const sessionVendor = vendorForProvider({ provider: owner?.provider ?? "claude-code", accountKey: owner?.account_key ?? "" });
    await refreshStatusIncidents({ cache, vendors: [sessionVendor], now, ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}) })
      .catch(() => undefined);
    vendors.push(sessionVendor);
  }
  const incident = incidentSegment(cachedStatusIncidents({ cache, vendors, now }));
  if (incident !== undefined) segments.push(incident);

  return segments.join(" · ");
}
