import fs from "node:fs";
import path from "node:path";

import type { UsageEvent } from "../types.ts";
import { providerConfig } from "../config.ts";
import { eventId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { homePath, type EntryContext, type Provider, type SessionDoc } from "./types.ts";

/**
 * Grok CLI session rollouts under $GROK_HOME/sessions (default ~/.grok/sessions).
 *
 * The store family is codex-like JSONL (token-cost documents the same layout:
 * ~/.grok/sessions/*.jsonl). No store was present on the inspection machine
 * (2026-08-24), so this adapter is deliberately tolerant across the shapes
 * seen in that family instead of betting on one:
 *
 *   {"type":"session_meta","payload":{"session_id","cwd"}}      session start
 *   {"type":"turn_context","payload":{"model"}}                 current model
 *   {"type":"event_msg","payload":{"type":"token_count",
 *     "info":{"last_token_usage"|"total_token_usage",...}}}     usage (codex)
 *   {...,"usage":{"input_tokens"|"prompt_tokens",
 *     "output_tokens"|"completion_tokens","cached_tokens"?}}    generic usage
 *   {...,"tokenUsage":{...}}                                    alt spelling
 *
 * Delta rule: `last_token_usage` is preferred when present (per-turn delta);
 * flat `usage` objects are treated as per-message values. Cumulative-looking
 * totals without a last/delta sibling are ignored to avoid double counting.
 */
export const grokProvider: Provider = {
  id: "grok",
  label: "Grok CLI",
  envVar: "GROK_HOME",

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return [homePath("GROK_HOME", "/.grok/sessions")];
  },

  listFiles(root: string): string[] {
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
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
      }
    }
    return out.sort();
  },

  parseLine(line: string, ctx: EntryContext): UsageEvent[] {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    const state = ctx.state as Record<string, unknown>;
    const lineIndex = typeof state.lineIndex === "number" ? state.lineIndex : 0;
    state.lineIndex = lineIndex + 1;

    const payload = entry.payload as Record<string, unknown> | undefined;

    if (entry.type === "session_meta" && payload !== undefined) {
      if (ctx.freshFile || typeof state.sessionId !== "string") {
        state.sessionId =
          typeof payload.session_id === "string"
            ? payload.session_id
            : path.basename(ctx.path).replace(/\.jsonl$/, "");
        if (typeof payload.cwd === "string") state.cwd = payload.cwd;
        if (typeof payload.model === "string") state.model = payload.model;
      }
      return [];
    }
    if (entry.type === "turn_context" && payload !== undefined && typeof payload.model === "string") {
      state.model = payload.model;
      return [];
    }

    // Codex-family nested shape
    if (entry.type === "event_msg" && payload !== undefined && payload.type === "token_count") {
      const info = payload.info as Record<string, unknown> | undefined;
      if (info === undefined) return [];
      const delta = (info.last_token_usage ?? info.delta) as Record<string, unknown> | undefined;
      if (delta === undefined) return []; // cumulative-only lines are skipped
      return emit(this.id, state, ctx, lineIndex, entry, delta);
    }

    // Flat/generic shapes anywhere on the entry
    const flat = (entry.usage ?? entry.tokenUsage) as Record<string, unknown> | undefined;
    if (flat !== undefined && typeof flat === "object") {
      return emit(this.id, state, ctx, lineIndex, entry, flat);
    }
    return [];
  },
};

function emit(
  providerId: string,
  state: Record<string, unknown>,
  ctx: EntryContext,
  lineIndex: number,
  entry: Record<string, unknown>,
  usage: Record<string, unknown>,
): UsageEvent[] {
  const inputTokens = num(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = num(usage.output_tokens ?? usage.completion_tokens);
  const cachedInput = num(usage.cached_input_tokens ?? usage.cached_tokens);
  if (inputTokens === 0 && outputTokens === 0) return [];

  const sessionId = typeof state.sessionId === "string" ? state.sessionId : path.basename(ctx.path).replace(/\.jsonl$/, "");
  const model = typeof entry.model === "string" ? entry.model : typeof state.model === "string" ? state.model : "unknown";
  const ts =
    firstString(entry.timestamp, entry.ts) ?? new Date().toISOString();

  return [
    {
      id: eventId(providerId, "default", sessionId, `line-${lineIndex}`),
      ts,
      machineId: ctx.machineId,
      provider: providerId,
      accountKey: "default",
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
    },
  ];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === "string") return v;
  return undefined;
}

const BODY_CAP = 512 * 1024;

/** Tolerant transcript extraction mirroring the parseLine shapes. */
export function extractGrokSessionDocs(file: string): SessionDoc[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let sessionId = path.basename(file).replace(/\.jsonl$/, "");
  let title = "";
  let body = "";
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (entry.type === "session_meta" && payload !== undefined && typeof payload.session_id === "string") {
      sessionId = payload.session_id;
      continue;
    }
    if (entry.type === "response_item" && payload !== undefined && payload.type === "message") {
      const role = typeof payload.role === "string" ? payload.role : "";
      if (!Array.isArray(payload.content)) continue;
      for (const block of payload.content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text !== "string" || b.text.length === 0) continue;
        if ((b.type === "input_text" && role === "user") || (b.type === "output_text" && role === "assistant")) {
          if (role === "user" && title.length === 0) title = b.text.replace(/\s+/g, " ").trim().slice(0, 200);
          body += `${b.text.replace(/\s+/g, " ").slice(0, 2000)}\n`;
          if (body.length >= BODY_CAP) break;
        }
      }
    }
    if (body.length >= BODY_CAP) break;
  }
  if (body.length === 0 && title.length === 0) return [];
  return [{ sessionId, title, body }];
}

grokProvider.extractSessionDocs = extractGrokSessionDocs;
