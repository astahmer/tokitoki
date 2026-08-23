/**
 * Opt-in public sharing — publishes a sanitized aggregate record to the
 * user's PDS. Privacy model:
 *
 * - NEVER included: raw session content, prompts, emails, account ids,
 *   project paths, machine ids
 * - Included: period label + window bounds, cost/request/token totals,
 *   top models and tools as {name, share} pairs (share = % of spend when
 *   any cost exists, else % of tokens), repo names only with
 *   --include-repos, and even then SHA-256-hashed prefixes
 *
 * Disabled by default; state lives in
 * ~/.local/share/tokitoki/share.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { resolveExtraFiles, sinceIsoForDays } from "./report.ts";
import { monthStartIso } from "./report.ts";
import { AtprotoAdapter } from "./sync/atproto.ts";

export type ShareScope = "week" | "month";

export interface ShareState {
  enabled: boolean;
  lastPublished?: {
    cid: string;
    rkey: string;
    at: string;
    scope: ShareScope;
  };
}

export interface ShareTopEntry {
  name: string;
  /** 0–100, one decimal. % of spend when any cost exists, else % of tokens. */
  share: number;
}

export interface SharePayload {
  $type: "dev.tokitoki.share";
  period: ShareScope;
  window: { since: string; until: string };
  totals: { costUsd: number; requests: number; tokens: number };
  topModels: ShareTopEntry[];
  topTools: ShareTopEntry[];
  /** Only present with includeRepos — names are sha256-prefixed, never raw. */
  repos?: Array<{ hash: string; share: number }>;
  generatedAt: string;
}

export function dataDir(): string {
  return process.env.TOKITOKI_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "tokitoki");
}

function statePath(): string {
  return path.join(dataDir(), "share.json");
}

export function readShareState(): ShareState {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<ShareState>;
    return {
      enabled: raw.enabled === true,
      lastPublished:
        raw.lastPublished !== undefined && typeof raw.lastPublished.cid === "string"
          ? raw.lastPublished
          : undefined,
    };
  } catch {
    return { enabled: false };
  }
}

export function writeShareState(state: ShareState): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
}

/** Token total across all four counters (matches report totals semantics). */
function rowTokens(r: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

/** Top-N sanitized entries from aggregate rows, share normalized to 0–100. */
export function topEntries(
  rows: Array<{
    bucket: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>,
  n: number,
): ShareTopEntry[] {
  const byCost = rows.reduce((acc, r) => acc + r.costUsd, 0);
  const metric = byCost > 0 ? "cost" : "tokens";
  const total = metric === "cost" ? byCost : rows.reduce((acc, r) => acc + rowTokens(r), 0);
  if (total <= 0) return [];
  return rows
    .slice()
    .sort((a, b) =>
      metric === "cost" ? b.costUsd - a.costUsd : rowTokens(b) - rowTokens(a),
    )
    .slice(0, n)
    .map((r) => ({
      name: r.bucket,
      share:
        Math.round(((metric === "cost" ? r.costUsd : rowTokens(r)) / total) * 1000) / 10,
    }));
}

/** Repo names are hashed before leaving the machine unless --include-repos is given... which still hashes them. Raw names never leave. */
export function hashRepoName(name: string): string {
  return crypto.createHash("sha256").update(name).digest("hex").slice(0, 16);
}

export function buildSharePayload(
  scope: ShareScope,
  opts: { includeRepos?: boolean } = {},
): SharePayload {
  const cache = new EventCache();
  try {
    cache.sync(resolveExtraFiles(loadConfig()));
    const sinceIso = scope === "week" ? sinceIsoForDays(7) : monthStartIso();
    const untilIso = new Date().toISOString();
    const totals = cache.totals(sinceIso, undefined, untilIso);
    const models = cache.aggregate(sinceIso, "model", undefined, untilIso);
    const tools = cache.aggregate(sinceIso, "tool", undefined, untilIso);
    const payload: SharePayload = {
      $type: "dev.tokitoki.share",
      period: scope,
      window: { since: sinceIso, until: untilIso },
      totals: {
        costUsd: Math.round(totals.costUsd * 100) / 100,
        requests: totals.requests,
        tokens: totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
      },
      topModels: topEntries(models, 5),
      topTools: topEntries(tools, 5),
      generatedAt: untilIso,
    };
    if (opts.includeRepos === true) {
      const repos = cache.aggregate(sinceIso, "repo", undefined, untilIso);
      payload.repos = topEntries(repos, 10).map((e) => ({
        hash: hashRepoName(e.name),
        share: e.share,
      }));
    }
    return payload;
  } finally {
    cache.close();
  }
}

/** Human-readable preview of exactly what a publish would contain. */
export function describePayload(p: SharePayload, includeRepos: boolean): string[] {
  const lines = [
    `period: ${p.period} (${p.window.since} → ${p.window.until})`,
    `totals: $${p.totals.costUsd} across ${p.totals.requests} requests`,
    `topModels: ${p.topModels.map((m) => `${m.name} ${m.share}%`).join(", ") || "(none)"}`,
    `topTools: ${p.topTools.map((t) => `${t.name} ${t.share}%`).join(", ") || "(none)"}`,
  ];
  lines.push(
    includeRepos
      ? `repos: hashed names only (${p.repos?.length ?? 0} entries)`
      : "repos: not included",
  );
  lines.push("never included: messages, prompts, emails, account ids, project paths");
  return lines;
}

export function atprotoConfig(): { handle: string; appPassword?: string; pds?: string } | null {
  const sync = loadConfig().sync;
  if (sync?.handle === undefined || sync.handle.length === 0) return null;
  return { handle: sync.handle, appPassword: sync.appPassword, pds: sync.pds };
}

export interface PublishResult {
  cid: string;
  rkey: string;
  at: string;
}

/** Publishes the current payload to the PDS configured under [sync]. */
export async function publishShare(
  scope: ShareScope,
  opts: { includeRepos?: boolean } = {},
): Promise<PublishResult> {
  const cfg = atprotoConfig();
  if (cfg === null) {
    throw new Error(
      "public sharing needs atproto credentials: add [sync] handle + appPassword to config\ntry: see docs/atproto-lexicon.md for setup",
    );
  }
  const payload = buildSharePayload(scope, opts);
  const client = new AtprotoAdapter({ handle: cfg.handle, appPassword: cfg.appPassword, pds: cfg.pds });
  // One rolling record per scope keeps the repo tidy: republishing replaces.
  const day = new Date().toISOString().slice(0, 10);
  const rkey = `${scope}-${day}`;
  const res = await client.putCustomRecord("dev.tokitoki.share", rkey, payload);
  const state = readShareState();
  state.enabled = true;
  state.lastPublished = { cid: res.cid, rkey, at: new Date().toISOString(), scope };
  writeShareState(state);
  return { cid: res.cid, rkey, at: state.lastPublished.at };
}
