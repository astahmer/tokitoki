import fs from "node:fs";

import type { UsageEvent } from "../types.ts";
import { providerConfig } from "../config.ts";
import { eventId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { shellToolName } from "../tools.ts";
import { cleanSessionText, sessionSnippet, sessionTitle } from "../sessionText.ts";
import { homePath, type EntryContext, type Provider, type SessionDoc } from "./types.ts";
import { walkJsonl } from "./claude-code.ts";

/**
 * pi coding agent sessions live under $PI_DIR/agent/sessions/<encoded-cwd>/
 * as JSONL. Line kinds:
 *   {"type":"session","id":...,"timestamp":...,"cwd":...}
 *   {"type":"model_change",...,"provider":...,"modelId":...}
 *   {"type":"message","id":...,...,"message":{role,usage:{input,output,
 *     cacheRead,cacheWrite,totalTokens,cost:{...total}},model,provider}}
 */
export const piProvider: Provider = {
  id: "pi",
  label: "pi",
  envVar: "PI_DIR",

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return [homePath("PI_DIR", "/.pi/agent/sessions")];
  },

  listFiles(root: string): string[] {
    return walkJsonl(root);
  },

  parseLine(line: string, ctx: EntryContext): UsageEvent[] {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    const state = ctx.state;

    const type = entry.type;
    if (type === "session") {
      if (ctx.freshFile) {
        // Reset per-file session context on full replay
        delete state.sessionId;
        delete state.cwd;
      }
      if (typeof entry.id === "string") state.sessionId = entry.id;
      if (typeof entry.cwd === "string") state.cwd = entry.cwd;
      return [];
    }
    if (type === "model_change") {
      // Remember latest model/provider for subsequent usage entries
      if (typeof entry.provider === "string") state.provider = entry.provider;
      if (typeof entry.modelId === "string") state.model = entry.modelId;
      return [];
    }
    if (type !== "message") return [];

    const message = entry.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, number | Record<string, number>> | undefined;
    if (usage === undefined) return [];

    // Tool attribution: assistant messages carry toolCall content blocks.
    let tool: string | undefined;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "toolCall" || typeof b.name !== "string" || b.name.length === 0) continue;
        if (b.name === "bash") {
          const args = b.arguments as Record<string, unknown> | undefined;
          tool = shellToolName(args?.command);
        } else {
          tool = b.name;
        }
        break;
      }
    }

    const inputTokens = toNum(usage.input);
    const outputTokens = toNum(usage.output);
    if (inputTokens === 0 && outputTokens === 0) return [];

    const sessionId = typeof state.sessionId === "string" ? state.sessionId : "unknown-session";
    const model = typeof message?.model === "string" ? message.model
      : typeof state.model === "string" ? state.model : "unknown";
    const account = typeof message?.provider === "string" ? message.provider
      : typeof state.provider === "string" ? state.provider : "default";

    const costObj = usage.cost as Record<string, number> | undefined;
    const reportedCost = costObj?.total;
    const cacheRead = toNum(usage.cacheRead);
    const cacheWrite = toNum(usage.cacheWrite);
    const costUsd =
      typeof reportedCost === "number"
        ? reportedCost
        : estimateCost(model, { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

    const entryId = typeof entry.id === "string" ? entry.id : `line-${hashLine(line)}`;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();

    const event: UsageEvent = {
      id: eventId("pi", account, sessionId, entryId),
      ts,
      machineId: ctx.machineId,
      provider: this.id,
      accountKey: account,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd,
      projectDir: typeof state.cwd === "string" ? state.cwd : undefined,
      sessionId,
      tool,
    };
    return [event];
  },

  extractSessionDocs: extractPiSessionDocs,
};

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const BODY_CAP = 1024 * 1024;

/** Text out of a pi message content (string or block array). */
function piTextBlocks(content: unknown, role: string): string[] {
  if (typeof content === "string") return role === "user" ? [content] : [];
  const out: string[] = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (role === "assistant" && b.type === "toolCall" && typeof b.name === "string") {
      out.push(`[tool:${b.name}]`);
    }
  }
  return out;
}

/** Full-text extraction: one session per file (session line sets the id). */
export function extractPiSessionDocs(file: string): SessionDoc[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let sessionId: string | undefined;
  let startedAt: string | undefined;
  const userTexts: string[] = [];
  let body = "";
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      if (typeof entry.timestamp === "string") startedAt = entry.timestamp;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const role = typeof message?.role === "string" ? message.role : "";
    if (role !== "user" && role !== "assistant") continue;
    for (const text of piTextBlocks(message?.content, role)) {
      if (role === "user") {
        userTexts.push(text);
      }
      if (body.length + text.length > BODY_CAP) break;
      body += sessionSnippet(text) + "\n";
    }
    if (body.length >= BODY_CAP) break;
  }
  if (sessionId === undefined || body.length === 0) return [];
  return [{ sessionId, startedAt, title: sessionTitle(userTexts[0] ?? body), body: cleanSessionText(body).slice(0, BODY_CAP) }];
}

/** Deterministic fallback when an entry lacks an id. */
function hashLine(line: string): string {
  // Cheap stable hash (FNV-1a) — enough for dedupe within a file.
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
