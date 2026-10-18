import { z } from "zod";

import { PROVIDER_REGISTRY, type StatusPageSource } from "./provider-registry.ts";

/**
 * Vendor status-page incidents (Statuspage.io summaries and Google's
 * Workspace incidents feed for Gemini). Results are cached in the cache meta
 * table so payload and statusline renders stay offline; fetch failures keep
 * the previous answer and never surface as errors.
 */

export type IncidentIndicator = "none" | "minor" | "major" | "critical";

export interface VendorIncident {
  indicator: IncidentIndicator;
  description: string;
  url: string;
}

interface MetaStore {
  metaValue(key: string): string | undefined;
  setMetaValue(key: string, value: string): void;
}

const INCIDENT_TTL_MS = 5 * 60_000;
/** Cached incidents older than this are dropped rather than shown as current. */
const INCIDENT_MAX_AGE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 4_000;

const INDICATOR_RANK: Record<IncidentIndicator, number> = { none: 0, minor: 1, major: 2, critical: 3 };

const IndicatorSchema = z.enum(["none", "minor", "major", "critical"]);

const toIndicator = (value: string | null | undefined): IncidentIndicator => {
  const parsed = IndicatorSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return value === "maintenance" ? "minor" : "none";
};

const StatuspageSummarySchema = z.object({
  page: z.object({ url: z.string().optional() }).optional(),
  status: z.object({ indicator: z.string(), description: z.string().optional() }),
  incidents: z.array(z.object({
    name: z.string(),
    status: z.string().optional(),
    impact: z.string().nullish(),
    shortlink: z.string().nullish(),
  })).optional(),
});

/** Statuspage.io summary.json (or status.json) → worst current indicator plus the leading unresolved incident. */
export const parseStatuspageSummary = (input: { body: unknown; pageUrl: string }): VendorIncident | undefined => {
  const parsed = StatuspageSummarySchema.safeParse(input.body);
  if (!parsed.success) return undefined;
  const summary = parsed.data;
  const open = (summary.incidents ?? []).filter((incident) => incident.status !== "resolved" && incident.status !== "postmortem");
  const worstIncident = open.reduce<(typeof open)[number] | undefined>(
    (worst, incident) =>
      worst === undefined || INDICATOR_RANK[toIndicator(incident.impact)] > INDICATOR_RANK[toIndicator(worst.impact)] ? incident : worst,
    undefined,
  );
  const pageIndicator = toIndicator(summary.status.indicator);
  const incidentIndicator = toIndicator(worstIncident?.impact);
  const indicator = INDICATOR_RANK[incidentIndicator] > INDICATOR_RANK[pageIndicator] ? incidentIndicator : pageIndicator;
  return {
    indicator,
    description: worstIncident?.name ?? summary.status.description ?? "",
    url: worstIncident?.shortlink ?? summary.page?.url ?? input.pageUrl,
  };
};

const GoogleIncidentSchema = z.object({
  end: z.string().nullish(),
  external_desc: z.string().nullish(),
  status_impact: z.string().nullish(),
  severity: z.string().nullish(),
  uri: z.string().nullish(),
  affected_products: z.array(z.object({ id: z.string() })).nullish(),
  currently_affected_products: z.array(z.object({ id: z.string() })).nullish(),
  most_recent_update: z.object({ status: z.string().nullish(), text: z.string().nullish() }).nullish(),
});

const googleIndicator = (input: { status: string | null | undefined; severity: string | null | undefined }): IncidentIndicator => {
  switch (input.status?.toUpperCase()) {
    case "AVAILABLE": return "none";
    case "SERVICE_INFORMATION": return "minor";
    case "SERVICE_DISRUPTION": return "major";
    case "SERVICE_OUTAGE": return "critical";
    case "SERVICE_MAINTENANCE":
    case "SCHEDULED_MAINTENANCE": return "minor";
  }
  switch (input.severity?.toLowerCase()) {
    case "medium": return "major";
    case "high": return "critical";
    default: return "minor";
  }
};

/** First meaningful line of a Workspace incident's markdown body. */
const googleSummaryLine = (text: string | null | undefined): string => {
  for (const raw of (text ?? "").split(/\r?\n|\r/)) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    if (line.length === 0 || lower.startsWith("**summary") || lower.startsWith("**description") || lower === "summary") continue;
    const cleaned = line.replaceAll("**", "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^- /, "").trim();
    if (cleaned.length > 0) return cleaned;
  }
  return "";
};

/** Google Workspace incidents.json → most severe active incident for one product. */
export const parseGoogleIncidents = (input: { body: unknown; productId: string; pageUrl: string }): VendorIncident | undefined => {
  const parsed = z.array(z.unknown()).safeParse(input.body);
  if (!parsed.success) return undefined;
  const active = parsed.data
    .map((entry) => GoogleIncidentSchema.safeParse(entry))
    .flatMap((result) => (result.success ? [result.data] : []))
    .filter((incident) => {
      if (incident.end !== null && incident.end !== undefined) return false;
      const products = incident.currently_affected_products ?? incident.affected_products ?? [];
      return products.some((product) => product.id === input.productId);
    });
  const ranked = active
    .map((incident) => ({
      incident,
      indicator: googleIndicator({ status: incident.most_recent_update?.status ?? incident.status_impact, severity: incident.severity }),
    }))
    .sort((a, b) => INDICATOR_RANK[b.indicator] - INDICATOR_RANK[a.indicator]);
  const worst = ranked[0];
  if (worst === undefined || worst.indicator === "none") return { indicator: "none", description: "", url: input.pageUrl };
  return {
    indicator: worst.indicator,
    description: googleSummaryLine(worst.incident.most_recent_update?.text ?? worst.incident.external_desc),
    url: worst.incident.uri !== null && worst.incident.uri !== undefined
      ? `https://www.google.com/appsstatus/dashboard/${worst.incident.uri}`
      : input.pageUrl,
  };
};

const CachedIncidentSchema = z.object({
  checkedAt: z.number(),
  /** Last successful fetch; a cached incident is only trusted relative to this. */
  observedAt: z.number().optional(),
  incident: z.object({ indicator: IndicatorSchema, description: z.string(), url: z.string() }).optional(),
});

type CachedIncident = z.infer<typeof CachedIncidentSchema>;

const metaKey = (vendor: string): string => `status-incident:${vendor}`;

const readCached = (input: { cache: MetaStore; vendor: string }): CachedIncident | undefined => {
  const raw = input.cache.metaValue(metaKey(input.vendor));
  if (raw === undefined) return undefined;
  try {
    const parsed = CachedIncidentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const statusPageFor = (vendor: string): StatusPageSource | undefined => PROVIDER_REGISTRY[vendor]?.statusPage;

const fetchIncident = async (input: { source: StatusPageSource; fetcher: typeof fetch }): Promise<VendorIncident | undefined> => {
  const source = input.source;
  const url = source.kind === "statuspage"
    ? `${source.url}/api/v2/summary.json`
    : "https://www.google.com/appsstatus/dashboard/incidents.json";
  const res = await input.fetcher(url, {
    headers: { accept: "application/json", "user-agent": "tokitoki" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return undefined;
  const body: unknown = await res.json();
  return source.kind === "statuspage"
    ? parseStatuspageSummary({ body, pageUrl: source.url })
    : parseGoogleIncidents({ body, productId: source.productId, pageUrl: source.url });
};

/** Vendors among `vendors` that publish a status page. */
export const statusVendors = (vendors: Iterable<string>): string[] =>
  [...new Set(vendors)].filter((vendor) => statusPageFor(vendor) !== undefined).sort();

/**
 * Refresh incidents whose cache entry is older than the TTL. A failed fetch
 * keeps the previous incident and still stamps checkedAt so an unreachable
 * status page is retried once per TTL, not on every render.
 */
export const refreshStatusIncidents = async (input: {
  cache: MetaStore;
  vendors: Iterable<string>;
  fetcher?: typeof fetch;
  now?: number;
  ttlMs?: number;
}): Promise<void> => {
  const now = input.now ?? Date.now();
  const ttl = Math.max(INCIDENT_TTL_MS, input.ttlMs ?? INCIDENT_TTL_MS);
  const fetcher = input.fetcher ?? globalThis.fetch;
  await Promise.all(statusVendors(input.vendors).map(async (vendor) => {
    const source = statusPageFor(vendor);
    if (source === undefined) return;
    const previous = readCached({ cache: input.cache, vendor });
    if (previous !== undefined && now - previous.checkedAt < ttl) return;
    const incident = await fetchIncident({ source, fetcher }).catch(() => undefined);
    const stored: CachedIncident = incident !== undefined
      ? { checkedAt: now, observedAt: now, incident }
      : { ...previous, checkedAt: now };
    input.cache.setMetaValue(metaKey(vendor), JSON.stringify(stored));
  }));
};

/** Cached, reasonably fresh incidents for the given vendors. Never touches the network. */
export const cachedStatusIncidents = (input: {
  cache: MetaStore;
  vendors: Iterable<string>;
  now?: number;
}): Record<string, VendorIncident> => {
  const now = input.now ?? Date.now();
  const out: Record<string, VendorIncident> = {};
  for (const vendor of statusVendors(input.vendors)) {
    const cached = readCached({ cache: input.cache, vendor });
    if (cached?.incident === undefined || cached.observedAt === undefined || now - cached.observedAt > INCIDENT_MAX_AGE_MS) continue;
    out[vendor] = cached.incident;
  }
  return out;
};
