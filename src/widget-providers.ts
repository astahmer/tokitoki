import { z } from "zod";

import type { EventCache } from "./cache.ts";
import { vendorForProvider } from "./model-provider.ts";

/**
 * Vendor attribution for widget-payload sections, so shell widgets group and
 * label cards from the payload instead of guessing from account-key substrings.
 */

const LimitEntrySchema = z.looseObject({ provider: z.string(), accountKey: z.string() });
const ReportSchema = z.looseObject({ rows: z.array(z.looseObject({ bucket: z.string() })) });

type LimitEntry = z.infer<typeof LimitEntrySchema>;
type Report = z.infer<typeof ReportSchema>;

const tagLimits = (limits: unknown): Array<LimitEntry & { vendor: string }> | undefined => {
  const parsed = z.array(LimitEntrySchema).safeParse(limits);
  if (!parsed.success) return undefined;
  return parsed.data.map((entry) => ({ ...entry, vendor: vendorForProvider({ provider: entry.provider, accountKey: entry.accountKey }) }));
};

const tagReport = (report: unknown): Report | undefined => {
  const parsed = ReportSchema.safeParse(report);
  if (!parsed.success) return undefined;
  return { ...parsed.data, rows: parsed.data.rows.map((row) => ({ ...row, vendor: vendorForProvider({ provider: row.bucket }) })) };
};

/**
 * Attach `vendor` to every limits entry and today's per-harness rows. Sections
 * that do not match the expected shape pass through untouched.
 */
export const tagWidgetVendors = (input: { limits: unknown; today: unknown }): { limits: unknown; today: unknown; vendors: string[] } => {
  const limits = tagLimits(input.limits);
  const today = tagReport(input.today);
  const vendors = new Set<string>();
  for (const entry of limits ?? []) vendors.add(entry.vendor);
  for (const row of today?.rows ?? []) {
    if (typeof row.vendor === "string") vendors.add(row.vendor);
  }
  return { limits: limits ?? input.limits, today: today ?? input.today, vendors: [...vendors].sort() };
};

const ProviderRowsSchema = z.array(z.object({ provider: z.string(), accountKey: z.string() }));

/** Vendors behind every account this machine knows about: scanned usage plus polled-only quota accounts. */
export const knownAccountVendors = (cache: EventCache): string[] => {
  const accounts = cache.detectedAccounts().map((account) => ({ provider: account.provider, accountKey: account.accountKey }));
  try {
    const polled = ProviderRowsSchema.safeParse(
      cache.database.query("SELECT DISTINCT provider, account_key AS accountKey FROM quota_snapshots").all(),
    );
    if (polled.success) accounts.push(...polled.data);
  } catch {
    // pre-migration cache without quota snapshots
  }
  return [...new Set(accounts.map((account) => vendorForProvider(account)))].sort();
};
