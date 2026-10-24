import fs from "node:fs";

import { z } from "zod";

import { accountEmailFor, accountIdentityFor } from "./accounts.ts";
import { EventCache, type QuotaSnapshotRow } from "./cache.ts";
import { loadConfig, type TokitokiConfig } from "./config.ts";
import {
  appendBalanceOnlyAccounts,
  attachCodexPoolEmails,
  collapseHarnessVariants,
  computeLimits,
  dedupeAccountLimits,
  embeddedLimitWindow,
  gatewayExtraKeys,
  groupBySharedCredential,
  mergeAliasLimits,
  type AccountLimits,
  type LimitWindow,
} from "./limits.ts";
import { vendorForProvider } from "./model-provider.ts";
import { opencodeCredentials, opencodexAccountIdentities, piCredentials, redactCredential } from "./poll.ts";
import { providerInfo } from "./provider-registry.ts";
import { AccountBalanceSchema, withUniqueWindowIds } from "./quota-windows.ts";
import { resolveExtraFiles } from "./report.ts";

const LIMITS_SCHEMA_VERSION = 1;

const CreditsSchema = z.object({
  hasCredits: z.boolean().optional(),
  unlimited: z.boolean().optional(),
  balance: z.union([z.string(), z.number()]).optional(),
  expiresAt: z.string().optional(),
});

const parseCredits = (raw: string): z.infer<typeof CreditsSchema> | undefined => {
  try {
    const parsed = CreditsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const PolledAccountSchema = z.array(z.object({ provider: z.string(), accountKey: z.string() }));
const OriginRowSchema = z.object({ origin: z.string().optional() }).nullable();

const canonicalCodexAccounts = (input: {
  limits: AccountLimits[];
  cache: EventCache;
  now: Date;
  maxAgeMs: (eventId?: string) => number | undefined;
}): AccountLimits[] => {
  const groups = new Map<string, AccountLimits[]>();
  const result: AccountLimits[] = [];
  for (const limit of input.limits) {
    if (limit.provider !== "codex" || limit.accountId === undefined) {
      result.push(limit);
      continue;
    }
    const group = groups.get(limit.accountId) ?? [];
    group.push(limit);
    groups.set(limit.accountId, group);
  }
  for (const [accountId, aliases] of groups) {
    const keys = aliases.map((alias) => alias.accountKey);
    const placeholders = keys.map(() => "?").join(", ");
    const observations = input.cache.database.query<{
      id: number; bucketId: string; capturedAt: string; accountKey: string;
    }, string[]>(`SELECT id, bucket_id AS bucketId, captured_at AS capturedAt, account_key AS accountKey
      FROM quota_observations WHERE provider = 'codex' AND account_id = ? AND complete = 1 AND account_key IN (${placeholders})
      ORDER BY captured_at DESC, id DESC`).all(accountId, ...keys);
    const full = observations.find((observation) => observation.bucketId === "*");
    const buckets = new Map<string, typeof observations[number]>();
    for (const observation of observations) {
      if (full !== undefined && (observation.capturedAt < full.capturedAt ||
        (observation.capturedAt === full.capturedAt && observation.id <= full.id))) continue;
      if (!buckets.has(observation.bucketId)) buckets.set(observation.bucketId, observation);
    }
    const rows = input.cache.database.query<QuotaSnapshotRow & { observationId: number | null }, string[]>(`
      SELECT account_key AS accountKey, account_id AS accountId, window_minutes AS windowMinutes,
        label, used_pct AS usedPct, amount_usd AS amountUsd, NULLIF(model, '') AS model,
        resets_at AS resetsAt, credits_json AS creditsJson, captured_at AS capturedAt, event_id AS eventId,
        bucket_id AS bucketId, window_id AS windowId, scope, window_start AS windowStart,
        window_end AS windowEnd, COALESCE(observed_at, captured_at) AS observedAt, observation_id AS observationId
      FROM quota_snapshots WHERE provider = 'codex' AND account_id = ? AND account_key IN (${placeholders})
      ORDER BY captured_at DESC, COALESCE(observation_id, 0) DESC
    `).all(accountId, ...keys);
    const legacyLatest = observations.length === 0 && rows.every((row) => row.observationId === null)
      ? rows[0]?.capturedAt : undefined;
    const snapshots = new Map<string, QuotaSnapshotRow>();
    for (const row of rows) {
      if (full !== undefined && (row.capturedAt < full.capturedAt ||
        (row.capturedAt === full.capturedAt && (row.observationId ?? 0) < full.id))) continue;
      if (legacyLatest !== undefined && row.capturedAt !== legacyLatest) continue;
      const bucket = buckets.get(row.bucketId ?? "");
      if (bucket !== undefined && (row.capturedAt < bucket.capturedAt ||
        (row.capturedAt === bucket.capturedAt && (row.observationId ?? 0) < bucket.id))) continue;
      const slot = JSON.stringify([row.bucketId ?? "", row.windowId || row.label || row.model || String(row.windowMinutes), row.model ?? ""]);
      if (!snapshots.has(slot)) snapshots.set(slot, row);
    }
    const preferredKey = full?.accountKey ?? rows[0]?.accountKey;
    const preferred = aliases.find((alias) => alias.accountKey === preferredKey) ?? aliases[0]!;
    const budgets = new Map<string, LimitWindow>();
    for (const alias of aliases) {
      for (const window of alias.budgetWindows ?? []) {
        const key = JSON.stringify([window.id ?? window.kind, window.windowStart, window.windowEnd]);
        const previous = budgets.get(key);
        budgets.set(key, previous === undefined ? { ...window } : {
          ...previous, tokens: previous.tokens + window.tokens, cost: previous.cost + window.cost,
          requests: previous.requests + window.requests,
          usedPct: previous.usedPct !== undefined && window.usedPct !== undefined ? previous.usedPct + window.usedPct : undefined,
        });
      }
    }
    result.push({
      ...preferred, accountKey: `openai:${accountId}`, accountId,
      windows: withUniqueWindowIds([...snapshots.values()].map((snapshot) => embeddedLimitWindow({
        snapshot, now: input.now, identityVerified: true, maxAgeMs: input.maxAgeMs(snapshot.eventId),
      }))),
      ...(budgets.size > 0 ? { budgetWindows: withUniqueWindowIds([...budgets.values()]) } : {}),
    });
  }
  return result;
};

/**
 * Card-level account limits: provider-reported quotas and separate derived
 * budgets, deduplicated across harness variants and shared credentials.
 * The one builder behind widget-payload `limits`, `limits --json`, `serve`,
 * web `/api/limits`, and MCP `get_limits`, so every surface agrees on what an
 * account is. Callers sync the cache first.
 */
export const buildAccountLimits = (input: { cache: EventCache; config: TokitokiConfig; now?: Date }): AccountLimits[] => {
  const cache = input.cache;
  const config = input.config;
  const now = input.now ?? new Date();
  const limits = computeLimits(cache, config, now);
  const poolIdentities = opencodexAccountIdentities();
  const localCodexIdentity = accountIdentityFor("codex");
  const maxAgeMs = (eventId?: string): number | undefined => eventId?.startsWith("poll:")
    ? Math.max(10, (config.poll?.intervalMinutes ?? 15) * 2) * 60_000
    : undefined;
  const limitsWithPoolEmails = attachCodexPoolEmails(
    limits,
    poolIdentities,
    (accountKey) => cache.quotaAccountIds("codex", accountKey),
  );
  const cursorEmail = accountEmailFor("cursor");
  const withHarnessEmails = cursorEmail === null ? limitsWithPoolEmails : limitsWithPoolEmails.map((limit) => {
    if (limit.email !== undefined) return limit;
    const cursorRouted = limit.provider === "cursor" || (limit.provider === "t3code" && limit.accountKey === "cursor");
    return cursorRouted ? { ...limit, email: cursorEmail } : limit;
  });
  const merged = [
    ...mergeAliasLimits(withHarnessEmails.filter((limit) => limit.provider !== "codex")),
    ...withHarnessEmails.filter((limit) => limit.provider === "codex" && !limit.accountKey.startsWith("unidentified:")),
  ];
  const opencodeCreds = opencodeCredentials();
  const piKeys = piCredentials();
  const withCreds = merged.map((limit) => {
    const opencodeCred = opencodeCreds[limit.accountKey];
    if (opencodeCred !== undefined) return { ...limit, credential: opencodeCred };
    const piCred = limit.provider === "pi" ? piKeys[limit.accountKey] : undefined;
    return piCred !== undefined ? { ...limit, credential: redactCredential(piCred) } : limit;
  });
  const grouped = config.ui?.showHarnessVariants === true ? withCreds : groupBySharedCredential(withCreds);
  const withOrigin = dedupeAccountLimits(grouped.map((limit) => {
    try {
      const row = OriginRowSchema.parse(
        cache.database
          .query(
            `SELECT CASE WHEN event_id LIKE '%:opencodex' THEN 'opencodex' ELSE 'polled' END AS origin
             FROM quota_snapshots
             WHERE provider = ? AND account_key = ? AND event_id LIKE 'poll:%'
             LIMIT 1`,
          )
          .get(limit.provider, limit.accountKey),
      );
      return { ...limit, origin: row?.origin ?? "scan" };
    } catch {
      return { ...limit, origin: "scan" };
    }
  }));

  if (config.experimental?.zeroStateCards !== false) {
    const known = new Set(withOrigin.map((limit) => `${limit.provider}@${limit.accountKey}`));
    const commandcodeRoot = `${process.env.HOME ?? "~"}/.commandcode`;
    if (!known.has("commandcode@default") && fs.existsSync(commandcodeRoot)) {
      withOrigin.push({ provider: "commandcode", accountKey: "default", origin: "scan", windows: [] });
    }
  }

  for (const manualKey of gatewayExtraKeys(config)) {
    const cardProvider = manualKey.provider === "openrouter" ? "openrouter" : "opencode";
    const matchingProviders = manualKey.provider === "openrouter" ? ["openrouter"] : ["pi", "opencode"];
    const label = manualKey.label?.trim();
    const labelFields = label !== undefined && label.length > 0 ? { label: label.slice(0, 48) } : {};
    const existingIndex = withOrigin.findIndex((limit) => matchingProviders.includes(limit.provider) && limit.accountKey === manualKey.id);
    if (existingIndex >= 0) {
      const existing = withOrigin[existingIndex]!;
      withOrigin[existingIndex] = {
        ...existing,
        provider: cardProvider,
        origin: "manual",
        credential: existing.credential ?? redactCredential(manualKey.key),
        ...labelFields,
      };
      continue;
    }
    withOrigin.push({
      provider: cardProvider,
      accountKey: manualKey.id,
      credential: redactCredential(manualKey.key),
      origin: "manual",
      windows: cache.latestQuotaSnapshots(cardProvider, manualKey.id).map((snapshot) => embeddedLimitWindow({ snapshot, now, maxAgeMs: maxAgeMs(snapshot.eventId) })),
      ...labelFields,
    });
  }

  try {
    const polled = PolledAccountSchema.parse(
      cache.database
        .query(`SELECT DISTINCT provider, account_key AS accountKey FROM quota_snapshots
          WHERE event_id LIKE 'poll:%' OR provider = 'codex'
          UNION SELECT provider, account_key AS accountKey FROM quota_observations`)
        .all(),
    );
    const known = new Set(withOrigin.map((limit) => `${limit.provider}@${limit.accountKey}`));
    for (const polledAccount of polled) {
      if (polledAccount.provider === "codex" && polledAccount.accountKey.startsWith("unidentified:")) continue;
      const id = `${polledAccount.provider}@${polledAccount.accountKey}`;
      const mirroredInSharedGateway =
        (polledAccount.provider === "pi" || polledAccount.provider === "opencode") &&
        (known.has(`pi@${polledAccount.accountKey}`) || known.has(`opencode@${polledAccount.accountKey}`));
      if (known.has(id)) {
        continue;
      }
      if (mirroredInSharedGateway) continue;
      const snapshots = cache.latestQuotaSnapshots(polledAccount.provider, polledAccount.accountKey);
      let bankedResets: number | undefined;
      let bankedExpiresAt: string | undefined;
      for (const snapshot of snapshots) {
        if (snapshot.creditsJson === null) continue;
        const credits = parseCredits(snapshot.creditsJson);
        const balance = Number(credits?.balance ?? 0);
        if (credits?.hasCredits === true && credits.unlimited !== true && balance > 0) {
          bankedResets = Math.floor(balance);
          if (credits.expiresAt !== undefined) bankedExpiresAt = credits.expiresAt;
        }
      }
      const accountMeta = cache.quotaAccountMeta(polledAccount.provider, polledAccount.accountKey);
      const accountIds = cache.quotaAccountIds(polledAccount.provider, polledAccount.accountKey);
      const latestEpoch = (rows: typeof snapshots): number | undefined =>
        rows
          .map((snapshot) => Date.parse(snapshot.observedAt ?? snapshot.capturedAt))
          .filter((value) => Number.isFinite(value))
          .sort((a, b) => b - a)[0];
      const observedEpoch = latestEpoch(snapshots);
      const pollObservedEpoch = latestEpoch(snapshots.filter((snapshot) => snapshot.eventId?.startsWith("poll:") === true));
      const freshnessWindowMs = Math.max(10, (config.poll?.intervalMinutes ?? 15) * 2) * 60_000;
      const freshness: AccountLimits["freshness"] = pollObservedEpoch === undefined
        ? observedEpoch === undefined ? "unknown" : now.getTime() - observedEpoch <= 6 * 60 * 60_000 ? "fresh" : "stale"
        : now.getTime() - pollObservedEpoch <= freshnessWindowMs ? "fresh" : "stale";
      const poolIdentity = polledAccount.provider === "codex"
        ? Object.values(poolIdentities).find((identity) => identity.accountId !== undefined && accountIds.has(identity.accountId))
        : undefined;
      const email = poolIdentity?.email ?? accountMeta?.email;
      withOrigin.push({
        provider: polledAccount.provider,
        accountKey: polledAccount.accountKey,
        ...(accountIds.size === 1 ? { accountId: [...accountIds][0] } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(accountMeta?.plan !== undefined ? { plan: accountMeta.plan, planLabel: accountMeta.plan } : {}),
        ...(accountMeta?.extraUsage !== undefined ? { extraUsage: accountMeta.extraUsage } : {}),
        origin: snapshots.some((snapshot) => snapshot.eventId?.startsWith("poll:")) ? "polled" : "scan",
        windows: snapshots.map((snapshot) => embeddedLimitWindow({
          snapshot, now, maxAgeMs: maxAgeMs(snapshot.eventId),
          identityVerified: polledAccount.provider !== "codex" ||
            (snapshot.accountId !== null && snapshot.accountId.length > 0 && accountIds.has(snapshot.accountId)),
        })),
        ...(observedEpoch !== undefined ? { observedAt: new Date(observedEpoch).toISOString() } : {}),
        freshness,
        ...(bankedResets !== undefined ? { bankedResets } : {}),
        ...(bankedExpiresAt !== undefined ? { bankedExpiresAt } : {}),
      });
    }
  } catch {
    // pre-migration cache: no quota snapshot table
  }

  const savedOrder = config.ui?.menubarAccountOrder ?? [];
  const rank = (limit: AccountLimits): number => {
    const index = savedOrder.indexOf(`${limit.provider}@${limit.accountKey}`);
    return index === -1 ? savedOrder.length : index;
  };
  const withBalances = appendBalanceOnlyAccounts({ limits: withOrigin, cache, now });
  const cardLimits = config.ui?.showHarnessVariants === true ? withBalances : collapseHarnessVariants(withBalances);
  const attributedLimits = cardLimits.map((limit) => {
      const windows = withUniqueWindowIds(limit.windows);
      const budgetWindows = limit.budgetWindows === undefined ? undefined : withUniqueWindowIds(limit.budgetWindows);
      if (limit.provider !== "codex") return { ...limit, windows, budgetWindows };
      const accountIds = cache.quotaAccountIds("codex", limit.accountKey);
      const accountId = accountIds.size === 1 ? accountIds.values().next().value : undefined;
      const poolIdentity = accountId === undefined ? undefined : Object.values(poolIdentities).find((identity) => identity.accountId === accountId);
      const email = accountId === undefined ? undefined
        : accountId === localCodexIdentity?.accountId ? localCodexIdentity.email
        : poolIdentity?.email ?? cache.quotaAccountMeta("codex", limit.accountKey)?.email;
      return { ...limit, windows, budgetWindows, accountId, email };
    });
  return canonicalCodexAccounts({ limits: attributedLimits, cache, now, maxAgeMs }).sort((a, b) => rank(a) - rank(b));
};

const PaceSchema = z.object({
  expectedPercent: z.number(),
  deltaPercent: z.number(),
  status: z.enum(["under", "on", "over"]),
  runsOutAt: z.string().optional(),
});

const LimitsWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.enum(["session", "daily", "weekly", "monthly", "model", "other"]),
  model: z.string().optional(),
  source: z.enum(["provider", "derived"]),
  usedPercent: z.number().nullable().optional(),
  status: z.enum(["current", "stale", "expired", "unknown"]).optional(),
  observedAt: z.string().optional(),
  bucketId: z.string().optional(),
  windowId: z.string().optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
  amountUsd: z.number().optional(),
  windowMinutes: z.number().optional(),
  resetsAt: z.string().optional(),
  pace: PaceSchema.optional(),
  tokens: z.number(),
  costUsd: z.number(),
  requests: z.number(),
});

const LimitsAccountSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  vendorName: z.string(),
  harness: z.string(),
  alsoOn: z.array(z.string()),
  accountKey: z.string(),
  accountId: z.string().optional(),
  label: z.string().optional(),
  email: z.string().optional(),
  plan: z.string().optional(),
  credential: z.string().optional(),
  origin: z.string().optional(),
  freshness: z.enum(["fresh", "stale", "unknown"]).optional(),
  observedAt: z.string().optional(),
  extraUsage: z.object({
    enabled: z.boolean(),
    usedUsd: z.number().optional(),
    limitUsd: z.number().optional(),
    usedPercent: z.number().optional(),
  }).optional(),
  balance: AccountBalanceSchema.optional(),
  bankedResets: z.number().optional(),
  bankedExpiresAt: z.string().optional(),
  windows: z.array(LimitsWindowSchema),
  budgetWindows: z.array(LimitsWindowSchema).optional(),
});

/** Stable `tokitoki limits --json` / `GET /v1/limits` / MCP `get_limits` contract. */
export const LimitsDocumentSchema = z.object({
  version: z.literal(LIMITS_SCHEMA_VERSION),
  generatedAt: z.string(),
  accounts: z.array(LimitsAccountSchema),
});

export type LimitsDocument = z.infer<typeof LimitsDocumentSchema>;
type LimitsDocumentWindow = z.infer<typeof LimitsWindowSchema>;

const DERIVED_WINDOWS: Readonly<Record<string, { label: string; scope: LimitsDocumentWindow["scope"] }>> = {
  day: { label: "Today", scope: "daily" },
  week: { label: "This week", scope: "weekly" },
  month: { label: "This month", scope: "monthly" },
};

const documentWindow = (window: LimitWindow): LimitsDocumentWindow => {
  const derived = window.source === "derived" ? DERIVED_WINDOWS[window.kind] : undefined;
  const usedPercent = window.status === undefined || window.status === "current" ? window.usedPercent ?? window.usedPct : undefined;
  return {
    id: window.id ?? window.kind,
    label: window.label ?? derived?.label ?? window.kind,
    scope: window.scope ?? derived?.scope ?? "other",
    ...(window.model !== undefined ? { model: window.model } : {}),
    source: window.source === "embedded" ? "provider" : "derived",
    ...(usedPercent !== undefined ? { usedPercent: Math.round(usedPercent * 10) / 10 } : {}),
    ...(window.status !== undefined ? { status: window.status } : {}),
    ...(window.observedAt !== undefined ? { observedAt: window.observedAt } : {}),
    ...(window.bucketId !== undefined ? { bucketId: window.bucketId } : {}),
    ...(window.windowId !== undefined ? { windowId: window.windowId } : {}),
    ...(window.windowStart !== undefined ? { windowStart: window.windowStart } : {}),
    ...(window.windowEnd !== undefined ? { windowEnd: window.windowEnd } : {}),
    ...(window.amountUsd !== undefined ? { amountUsd: window.amountUsd } : {}),
    ...(window.windowMinutes !== undefined ? { windowMinutes: window.windowMinutes } : {}),
    ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    ...(window.pace !== undefined ? { pace: window.pace } : {}),
    tokens: window.tokens,
    costUsd: Math.round(window.cost * 10_000) / 10_000,
    requests: window.requests,
  };
};

const VENDOR_ORDER = ["anthropic", "openai", "google", "xai", "cursor", "github"];

const vendorRank = (vendor: string): number => {
  const index = VENDOR_ORDER.indexOf(vendor);
  return index === -1 ? VENDOR_ORDER.length : index;
};

/** Project card limits onto the versioned document, grouped vendor-first. */
export const limitsDocument = (input: { limits: AccountLimits[]; now?: Date; showEmail?: boolean }): LimitsDocument => {
  const accounts = input.limits.map((limit) => {
    const plan = limit.plan ?? limit.planLabel;
    const vendor = vendorForProvider({ provider: limit.provider, accountKey: limit.accountKey });
    return {
      id: `${limit.provider}@${limit.accountKey}`,
      vendor,
      vendorName: providerInfo(vendor).displayName,
      harness: limit.provider,
      alsoOn: limit.alsoOn ?? [],
      accountKey: limit.accountKey,
      ...(limit.accountId !== undefined ? { accountId: limit.accountId } : {}),
      ...(limit.label !== undefined ? { label: limit.label } : {}),
      ...(limit.email !== undefined && input.showEmail === true ? { email: limit.email } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(limit.credential !== undefined ? { credential: limit.credential } : {}),
      ...(limit.origin !== undefined ? { origin: limit.origin } : {}),
      ...(limit.freshness !== undefined ? { freshness: limit.freshness } : {}),
      ...(limit.observedAt !== undefined ? { observedAt: limit.observedAt } : {}),
      ...(limit.extraUsage !== undefined ? { extraUsage: limit.extraUsage } : {}),
      ...(limit.balance !== undefined ? { balance: limit.balance } : {}),
      ...(limit.bankedResets !== undefined ? { bankedResets: limit.bankedResets } : {}),
      ...(limit.bankedExpiresAt !== undefined ? { bankedExpiresAt: limit.bankedExpiresAt } : {}),
      windows: limit.windows.map(documentWindow),
      ...(limit.budgetWindows !== undefined ? { budgetWindows: limit.budgetWindows.map(documentWindow) } : {}),
    };
  });
  // Stable sort keeps the user's saved card order within each vendor.
  accounts.sort((a, b) => vendorRank(a.vendor) - vendorRank(b.vendor) || a.vendor.localeCompare(b.vendor));
  return {
    version: LIMITS_SCHEMA_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    accounts,
  };
};

/** Read-only: merges configured extra event files into the cache, never scans or polls. */
export const readLimitsDocument = (input: { cache?: EventCache; config?: TokitokiConfig; now?: Date; showEmail?: boolean } = {}): LimitsDocument => {
  const config = input.config ?? loadConfig();
  const now = input.now ?? new Date();
  const build = (cache: EventCache): LimitsDocument => {
    cache.sync(resolveExtraFiles(config));
    return limitsDocument({ limits: buildAccountLimits({ cache, config, now }), now, showEmail: input.showEmail });
  };
  if (input.cache !== undefined) return build(input.cache);
  const cache = new EventCache();
  try {
    return build(cache);
  } finally {
    cache.close();
  }
};
