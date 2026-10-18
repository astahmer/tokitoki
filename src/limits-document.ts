import fs from "node:fs";

import { z } from "zod";

import { accountEmailFor, accountIdentityFor } from "./accounts.ts";
import { EventCache } from "./cache.ts";
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
import { opencodeCredentials, opencodexAccountIdentities, opencodexQuotas, piCredentials, redactCredential } from "./poll.ts";
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

/**
 * Card-level account limits: provider-reported quotas merged with derived
 * usage windows, deduplicated across harness variants and shared credentials.
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
  const poolQuotas = opencodexQuotas();
  const localCodexAccountId = accountIdentityFor("codex")?.accountId;
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
  const normalizedLimits = withHarnessEmails.filter((limit) => {
    if (limit.provider !== "codex" || !limit.accountKey.startsWith("codex:")) return true;
    const poolKey = limit.accountKey.slice("codex:".length);
    if (poolQuotas[poolKey] === undefined) return true;
    const poolId = poolIdentities[poolKey]?.accountId;
    return poolId === undefined || cache.quotaAccountIds("codex", limit.accountKey).has(poolId);
  });
  const withoutLocalCodexAliases = normalizedLimits.filter((limit) => {
    if (limit.provider !== "codex" || localCodexAccountId === undefined) return true;
    if (limit.accountKey.startsWith("openai:")) return true;
    return !cache.quotaAccountIds("codex", limit.accountKey).has(localCodexAccountId);
  });
  const merged = mergeAliasLimits(withoutLocalCodexAliases);
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
      windows: cache.latestQuotaSnapshots(cardProvider, manualKey.id).map((snapshot) => embeddedLimitWindow({ snapshot, now })),
      ...labelFields,
    });
  }

  try {
    const polled = PolledAccountSchema.parse(
      cache.database
        .query("SELECT DISTINCT provider, account_key AS accountKey FROM quota_snapshots WHERE event_id LIKE 'poll:%'")
        .all(),
    );
    const known = new Set(withOrigin.map((limit) => `${limit.provider}@${limit.accountKey}`));
    for (const polledAccount of polled) {
      const id = `${polledAccount.provider}@${polledAccount.accountKey}`;
      const mirroredInSharedGateway =
        (polledAccount.provider === "pi" || polledAccount.provider === "opencode") &&
        (known.has(`pi@${polledAccount.accountKey}`) || known.has(`opencode@${polledAccount.accountKey}`));
      if (known.has(id)) {
        const existingIndex = withOrigin.findIndex((limit) => `${limit.provider}@${limit.accountKey}` === id);
        if (existingIndex < 0 || withOrigin[existingIndex]!.windows.length > 0) continue;
        withOrigin.splice(existingIndex, 1);
        known.delete(id);
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
          .map((snapshot) => Date.parse(snapshot.capturedAt))
          .filter((value) => Number.isFinite(value))
          .sort((a, b) => b - a)[0];
      const observedEpoch = latestEpoch(snapshots);
      const pollObservedEpoch = latestEpoch(snapshots.filter((snapshot) => snapshot.eventId?.startsWith("poll:") === true));
      const freshnessWindowMs = Math.max(10, (config.poll?.intervalMinutes ?? 15) * 2) * 60_000;
      const freshness: AccountLimits["freshness"] = pollObservedEpoch === undefined
        ? "unknown"
        : now.getTime() - pollObservedEpoch <= freshnessWindowMs ? "fresh" : "stale";
      if (
        polledAccount.provider === "codex" &&
        localCodexAccountId !== undefined &&
        !polledAccount.accountKey.startsWith("openai:") &&
        accountIds.has(localCodexAccountId)
      ) {
        continue;
      }
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
        origin: "polled",
        windows: snapshots.map((snapshot) => embeddedLimitWindow({ snapshot, now })),
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
  return cardLimits
    .sort((a, b) => rank(a) - rank(b))
    .map((limit) => ({ ...limit, windows: withUniqueWindowIds(limit.windows) }));
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
  usedPercent: z.number().nullable(),
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
  const derived = DERIVED_WINDOWS[window.kind];
  const usedPercent = window.usedPercent ?? window.usedPct;
  return {
    id: window.id ?? window.kind,
    label: window.label ?? derived?.label ?? window.kind,
    scope: window.scope ?? derived?.scope ?? "monthly",
    ...(window.model !== undefined ? { model: window.model } : {}),
    source: window.source === "embedded" ? "provider" : "derived",
    usedPercent: usedPercent === undefined ? null : Math.round(usedPercent * 10) / 10,
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
