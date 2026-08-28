import fs from "node:fs";
import path from "node:path";

import type { QuotaWindow, UsageEvent } from "../types.ts";
import { providerConfig } from "../config.ts";
import { eventId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { extractCodexToolName, shellToolName } from "../tools.ts";
import { cleanSessionText, sessionMessage, sessionTitle, summarizeToolCall } from "../sessionText.ts";
import { homePath, type EntryContext, type Provider, type SessionDoc } from "./types.ts";

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

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
 *   {"type":"session_meta","payload":{"session_id",cwd,model_provider,...}}
 *   {"type":"turn_context","payload":{"model",...}}           (current model)
 *   {"type":"event_msg","payload":{"type":"token_count",
 *     "info":{"total_token_usage"(cumulative),"last_token_usage"(delta),
 *             ...},"rate_limits":{"limit_id","plan_type"...}}}
 *
 * We emit events from last_token_usage (the per-turn delta) to avoid double
 * counting; cumulative totals are ignored. Entry ids derive from the line
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
    return [homePath("CODEX_HOME", "/.codex/sessions")];
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
      if (ctx.freshFile || typeof state.sessionId !== "string") {
        state.sessionId =
          typeof payload.session_id === "string"
            ? payload.session_id
            : path.basename(ctx.path).replace(/^rollout-|\.jsonl$/g, "").split("-").slice(-1)[0] ?? "unknown";
        if (typeof payload.cwd === "string") state.cwd = payload.cwd;
      }
      if (typeof payload.model_provider === "string") state.providerLabel = payload.model_provider;
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

    const info = payload.info as Record<string, unknown> | undefined;
    if (info === undefined) return [];

    const delta = info.last_token_usage as CodexTokenUsage | undefined;
    if (delta === undefined) return [];
    const inputTokens = delta.input_tokens ?? 0;
    const outputTokens = delta.output_tokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0) return [];

    const sessionId = typeof state.sessionId === "string" ? state.sessionId : "unknown-session";
    const model = typeof state.model === "string" ? state.model : "unknown";

    // Account attribution: rate_limits carries limit_id + plan_type
    let account = typeof state.providerLabel === "string" ? state.providerLabel : "default";
    const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
    const planType = rateLimits?.plan_type;
    if (rateLimits !== undefined && typeof planType === "string") {
      account = `${account}:${planType}`;
    } else if (typeof rateLimits?.limit_id === "string") {
      account = rateLimits.limit_id as string;
    }

    const cachedInput = delta.cached_input_tokens ?? 0;

    const event: UsageEvent = {
      id: eventId("codex", account, sessionId, `line-${lineIndex}`),
      ts: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
      machineId: ctx.machineId,
      provider: this.id,
      accountKey: account,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: cachedInput,
      costUsd: estimateCost(model, {
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedInput,
        cacheWriteTokens: 0,
      }),
      projectDir: typeof state.cwd === "string" ? state.cwd : undefined,
      sessionId,
      tool: typeof state.lastTool === "string" ? state.lastTool : undefined,
    };
    state.lastTool = undefined;

    // Embedded quota: real provider-reported rate-limit windows. Prefer over
    // any derived estimate (see src/limits.ts).
    if (rateLimits !== undefined && typeof rateLimits === "object") {
      const rl = rateLimits as Record<string, unknown>;
      const win = (w: unknown): QuotaWindow | undefined => {
        if (typeof w !== "object" || w === null) return undefined;
        const o = w as Record<string, unknown>;
        const usedPct = o.used_percent;
        const windowMinutes = o.window_minutes;
        const resetsAtEpoch = o.resets_at;
        if (
          typeof usedPct !== "number" ||
          typeof windowMinutes !== "number" ||
          typeof resetsAtEpoch !== "number"
        )
          return undefined;
        return { usedPct, windowMinutes, resetsAtEpoch };
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
      const primary = win(rl.primary);
      const secondary = win(rl.secondary);
      if (primary !== undefined || secondary !== undefined || credits !== undefined) {
        event.quota = {};
        if (primary !== undefined) event.quota.primary = primary;
        if (secondary !== undefined) event.quota.secondary = secondary;
        if (credits !== undefined) event.quota.credits = credits;
      }
    }
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
