import fs from "node:fs";
import path from "node:path";

import type { UsageEvent } from "../types.ts";
import { providerConfig } from "../config.ts";
import { eventId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { homePath, type EntryContext, type Provider } from "./types.ts";

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
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
    };
    return [event];
  },
};

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
