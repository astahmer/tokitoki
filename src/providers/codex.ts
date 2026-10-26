import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { QuotaSnapshot, QuotaWindow, UsageEvent } from "../types.ts";
import { providerConfig } from "../config.ts";
import { codexHomes } from "../codex-homes.ts";
import { eventId } from "../machine.ts";
import { resolveUsageCost } from "../pricing.ts";
import { extractCodexToolName, shellToolName } from "../tools.ts";
import { cleanSessionText, sessionMessage, sessionTitle, summarizeToolCall } from "../sessionText.ts";
import { type EntryContext, type Provider, type SessionDoc } from "./types.ts";
import { codexForkParentId, codexThreadId, isCodexOriginalLine, isCodexReplayLine } from "./codex-replay.ts";

const tokenUsageSchema = z.object({
  input_tokens: z.number().finite().nonnegative(),
  cached_input_tokens: z.number().finite().nonnegative().default(0),
  output_tokens: z.number().finite().nonnegative(),
});
type CodexTokenUsage = z.infer<typeof tokenUsageSchema>;

function tokenUsage(value: unknown): CodexTokenUsage | undefined {
  const parsed = tokenUsageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data,
    cached_input_tokens: Math.min(parsed.data.cached_input_tokens, parsed.data.input_tokens),
  };
}

/** Reconcile cumulative snapshots before treating last usage as a new request.
 * Mirrors the cumulative gate / baseline advancement in ccusage's pinned
 * e351d846 Codex parser; resets establish a new baseline without billing it.
 */
function usageDelta(info: Record<string, unknown>, state: EntryContext["state"]): CodexTokenUsage | undefined {
  const total = tokenUsage(info.total_token_usage);
  const last = tokenUsage(info.last_token_usage);
  const previous = tokenUsage(state.codexCumulativeUsage);
  if (total === undefined) {
    if (last !== undefined) state.codexCumulativeGap = true;
    return last;
  }
  const gap = state.codexCumulativeGap === true;
  state.codexCumulativeUsage = total; // Always advance, including the last-usage path.
  delete state.codexCumulativeGap;
  if (previous !== undefined && !gap) {
    if (total.input_tokens === previous.input_tokens && total.output_tokens === previous.output_tokens &&
      total.cached_input_tokens === previous.cached_input_tokens) return undefined;
    // A reset/decrease is not a negative request or a whole new cumulative bill.
    if (total.input_tokens < previous.input_tokens || total.output_tokens < previous.output_tokens ||
      total.cached_input_tokens < previous.cached_input_tokens) return last;
  }
  if (last !== undefined) return last;
  // A last-only interval cannot be recovered from the next cumulative total
  // without counting those requests twice. Re-anchor instead.
  if (gap) return undefined;
  const input = total.input_tokens - (previous?.input_tokens ?? 0);
  return {
    input_tokens: input,
    output_tokens: total.output_tokens - (previous?.output_tokens ?? 0),
    cached_input_tokens: Math.min(input, total.cached_input_tokens - (previous?.cached_input_tokens ?? 0)),
  };
}

const quotaWindowSchema = z.object({
  used_percent: z.number().finite(),
  window_minutes: z.number().finite().positive().nullish(),
  resets_at: z.number().finite().nonnegative().nullish(),
});

const sourceId = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** Also usable by a quota-only scanner sink, without manufacturing a usage event. */
export const parseCodexQuotaSnapshot = (input: {
  rateLimits: unknown;
  accountId?: string;
  observedAt?: string;
}): QuotaSnapshot | undefined => {
  if (typeof input.rateLimits !== "object" || input.rateLimits === null) return undefined;
  const rl = input.rateLimits as Record<string, unknown>;
  const limitId = sourceId(rl.limit_id);
  const limitName = sourceId(rl.limit_name);
  const win = (value: unknown, windowId: string): QuotaWindow | undefined => {
    const parsed = quotaWindowSchema.safeParse(value);
    if (!parsed.success) return undefined;
    return {
      usedPct: parsed.data.used_percent,
      windowMinutes: parsed.data.window_minutes ?? 0,
      resetsAtEpoch: parsed.data.resets_at ?? 0,
      bucketId: limitId,
      windowId,
      label: limitName,
      observedAt: input.observedAt,
    };
  };
  const creditsRaw = rl.credits as Record<string, unknown> | undefined;
  const credits =
    creditsRaw && typeof creditsRaw.has_credits === "boolean"
      ? {
          hasCredits: creditsRaw.has_credits,
          unlimited: creditsRaw.unlimited === true,
          balance: typeof creditsRaw.balance === "string" ? creditsRaw.balance : "0",
          expiresAt: creditExpiry(
            creditsRaw.expires_at ?? creditsRaw.expiration_date ?? creditsRaw.expiresAt ?? creditsRaw.expirationDate,
          ),
        }
      : undefined;
  const primary = win(rl.primary, "primary");
  const secondary = win(rl.secondary, "secondary");
  const complete = Object.hasOwn(rl, "primary") && Object.hasOwn(rl, "secondary");
  if (primary === undefined && secondary === undefined && credits === undefined && !complete) return undefined;
  return {
    accountId: sourceId(rl.account_id) ?? sourceId(input.accountId),
    limitId,
    limitName,
    complete,
    primary,
    secondary,
    credits,
  };
};

/** Normalize the several expiry encodings used by Codex credit responses. */
function creditExpiry(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return creditExpiry(numeric);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Codex CLI/Desktop rollouts live under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Relevant lines:
 *   {"type":"session_meta","payload":{"id","session_id",cwd,model_provider,...}}
 *   {"type":"turn_context","payload":{"model",...}}           (current model)
 *   {"type":"event_msg","payload":{"type":"token_count",
 *     "info":{"total_token_usage"(cumulative),"last_token_usage"(delta),
 *             ...},"rate_limits":{"limit_id","plan_type"...}}}
 *
 * Cumulative advancement guards last_token_usage against repeated snapshots;
 * totals-only observations use differences from the saved baseline. Entry ids derive from the line
 * index within the rollout (files are append-only), tracked across scans in
 * cursor state.
 *
 * NOTE: best effort — format observed on codex 0.146.x; older/newer builds
 * may differ. Unknown shapes are skipped, never guessed.
 */
export const codexProvider: Provider = {
  id: "codex",
  label: "Codex",
  envVar: "CODEX_HOME",

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return codexHomes().flatMap(home => [path.join(home, "sessions"), path.join(home, "archived_sessions")]);
  },

  listFiles(root: string): string[] {
    return walkRollouts(root);
  },

  parseLine(line: string, ctx: EntryContext): UsageEvent[] {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    const state = ctx.state;
    const lineIndex = typeof state.lineIndex === "number" ? state.lineIndex : 0;
    state.lineIndex = lineIndex + 1;

    const payload = entry.payload as Record<string, unknown> | undefined;
    if (entry.type === "session_meta" && payload !== undefined) {
      // Preserve the old fresh-scan ID namespace even when a copied header
      // belongs to the parent; ownership itself stays with the first header.
      if (ctx.freshFile || typeof state.codexLegacySessionId !== "string") {
        state.codexLegacySessionId = typeof payload.session_id === "string" ? payload.session_id
          : path.basename(ctx.path).replace(/^rollout-|\.jsonl$/g, "").split("-").slice(-1)[0] ?? "unknown";
      }
      if (typeof payload.model_provider === "string") state.codexLegacyProviderLabel = payload.model_provider;
      // Later metadata can be inherited from a fork's copied parent history.
      // Only the first header owns identity, attribution and cumulative reset.
      if (state.codexMetadataSeen === true || (!ctx.freshFile && typeof state.sessionId === "string")) return [];
      state.codexMetadataSeen = true;
      // Keep the historical sessionId namespace below for existing event IDs.
      // Stock metadata.id is the thread; session_id can be the shared root.
      state.codexThreadId = codexThreadId(payload);
      state.codexForkedFromId = codexForkParentId(payload);
      if (ctx.freshFile) {
        delete state.codexCumulativeUsage;
        delete state.codexCumulativeGap;
      }
      if (ctx.freshFile || typeof state.sessionId !== "string") {
        state.sessionId =
          typeof payload.session_id === "string"
            ? payload.session_id
            : path.basename(ctx.path).replace(/^rollout-|\.jsonl$/g, "").split("-").slice(-1)[0] ?? "unknown";
        if (typeof payload.cwd === "string") state.cwd = payload.cwd;
      }
      if (typeof payload.model_provider === "string") state.providerLabel = payload.model_provider;
      state.accountId = sourceId(payload.account_id);
      return [];
    }
    if (payload === undefined) return [];

    if (entry.type === "turn_context" && typeof payload.model === "string") {
      state.model = payload.model;
      return [];
    }

    // Tool attribution: remember the most recent tool call; the token_count
    // that follows it (same turn step) inherits it.
    if (entry.type === "response_item") {
      const kind = payload.type;
      if (kind === "custom_tool_call" || kind === "function_call") {
        const name = typeof payload.name === "string" ? payload.name : "";
        const input = typeof payload.input === "string" ? payload.input : "";
        if (name.length > 0) {
          state.lastTool = extractCodexToolName(name, input) ?? name;
          if (name === "exec" && state.lastTool === "exec") {
            // exec without a parseable cmd stays generic
          }
        }
        return [];
      }
      if (kind === "item_completed") {
        const item = payload.item as Record<string, unknown> | undefined;
        if (item !== undefined && item.type === "CommandExecution") {
          const cmd = Array.isArray(item.command) ? (item.command[item.command.length - 1] as unknown) : item.command;
          state.lastTool = shellToolName(cmd as string | undefined);
        }
        return [];
      }
      return [];
    }
    if (entry.type !== "event_msg" || payload.type !== "token_count") return [];

    const sessionId = typeof state.sessionId === "string" ? state.sessionId : "unknown-session";
    const model = typeof state.model === "string" ? state.model : "unknown";

    // Keep the legacy accounting label; quota identity is carried separately.
    let account = typeof state.providerLabel === "string" ? state.providerLabel : "default";
    const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
    const planType = rateLimits?.plan_type;
    if (rateLimits !== undefined && typeof planType === "string") {
      account = `${account}:${planType}`;
    }
    // Historical usage IDs included the meter fallback. Preserve them on replay.
    const legacyProvider = typeof state.codexLegacyProviderLabel === "string" ? state.codexLegacyProviderLabel
      : typeof state.providerLabel === "string" ? state.providerLabel : "default";
    const legacyAccount = typeof planType === "string" ? `${legacyProvider}:${planType}` : legacyProvider;
    const idAccount = typeof planType !== "string" && typeof rateLimits?.limit_id === "string"
      ? rateLimits.limit_id : legacyAccount;
    const idSession = typeof state.codexLegacySessionId === "string" ? state.codexLegacySessionId : sessionId;
    const id = eventId("codex", idAccount, idSession, `line-${lineIndex}`);
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
    const quota = parseCodexQuotaSnapshot({
      rateLimits,
      accountId: sourceId(payload.account_id) ?? sourceId(state.accountId),
      observedAt: ts,
    });
    if (quota !== undefined) ctx.onQuota?.({ id, ts, provider: this.id, accountKey: account, sessionId, quota });

    const info = payload.info as Record<string, unknown> | undefined;
    if (info === undefined || info === null) return [];
    const delta = usageDelta(info, state);
    // Replay still advances cumulative accounting and delivers quota above.
    // The scanner supplies a verified plan; lineage alone is insufficient.
    if (isCodexReplayLine({ path: ctx.path, state, lineIndex })) {
      ctx.onReplayedUsage?.(id);
      delete state.lastTool;
      return [];
    }
    if (delta === undefined || delta === null) return [];
    const totalInput = delta.input_tokens ?? 0;
    const outputTokens = delta.output_tokens ?? 0;
    const cachedInput = delta.cached_input_tokens ?? 0;
    // Codex input includes cache hits. Normalize once at the adapter boundary
    // so totals and pricing both consume disjoint token buckets.
    if (![totalInput, outputTokens, cachedInput].every(value =>
      typeof value === "number" && Number.isFinite(value) && value >= 0) || cachedInput > totalInput) return [];
    if (totalInput === 0 && outputTokens === 0) return [];
    const inputTokens = totalInput - cachedInput;

    const event: UsageEvent = {
      ...(isCodexOriginalLine({ path: ctx.path, state, lineIndex }) ? { originalUsage: true } : {}),
      id,
      ts,
      machineId: ctx.machineId,
      provider: this.id,
      accountKey: account,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: cachedInput,
      ...resolveUsageCost({ model, tokens: {
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedInput,
        cacheWriteTokens: 0,
      } }),
      projectDir: typeof state.cwd === "string" ? state.cwd : undefined,
      sessionId,
      tool: typeof state.lastTool === "string" ? state.lastTool : undefined,
    };
    state.lastTool = undefined;

    event.quota = quota;
    return [event];
  },

  extractSessionDocs: extractCodexSessionDocs,
};

const BODY_CAP = 1024 * 1024;

/**
 * Full-text extraction for codex rollouts. Text lives in response_item
 * message payloads (content blocks typed input_text/output_text); tool calls
 * contribute their name + a command prefix.
 */
export function extractCodexSessionDocs(file: string): SessionDoc[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let sessionId = path.basename(file).replace(/^rollout-|\.jsonl$/g, "").split("-").slice(-1)[0] ?? "unknown";
  let startedAt: string | undefined;
  const userTexts: string[] = [];
  let body = "";
  const push = (role: "user" | "assistant" | "tool", text: string, timestamp?: string): void => {
    const message = sessionMessage(role, text, timestamp);
    if (message.length === 0) return;
    if (body.length + message.length > BODY_CAP) return;
    body += message + "\n\n";
  };
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (payload === undefined) continue;
    if (entry.type === "session_meta") {
      if (typeof payload.session_id === "string") sessionId = payload.session_id;
      if (typeof payload.timestamp === "string") startedAt = payload.timestamp;
      continue;
    }
    if (entry.timestamp !== undefined && startedAt === undefined && typeof entry.timestamp === "string") {
      startedAt = entry.timestamp;
    }
    if (entry.type !== "response_item") continue;
    const kind = payload.type;
    if (kind === "message") {
      const role = typeof payload.role === "string" ? payload.role : "";
      if (!Array.isArray(payload.content)) continue;
      for (const block of payload.content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text !== "string" || b.text.length === 0) continue;
        if ((b.type === "input_text" && role === "user") || (b.type === "output_text" && role === "assistant")) {
          if (role === "user") userTexts.push(b.text);
          push(role === "user" ? "user" : "assistant", b.text, typeof entry.timestamp === "string" ? entry.timestamp : undefined);
        }
      }
    } else if (kind === "function_call" || kind === "custom_tool_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const input = typeof payload.input === "string" ? payload.input : "";
      push("tool", summarizeToolCall(name, input), typeof entry.timestamp === "string" ? entry.timestamp : undefined);
    }
    if (body.length >= BODY_CAP) break;
  }
  if (body.length === 0) return [];
  const titles = userTexts.map((text) => sessionTitle(text)).filter((text) => text.length > 0);
  return [{ sessionId, startedAt, title: titles.at(-1) ?? "", body: cleanSessionText(body).slice(0, BODY_CAP) }];
}

function walkRollouts(root: string): string[] {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(root);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) return [root];
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out.sort();
}
