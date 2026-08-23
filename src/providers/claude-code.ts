import fs from "node:fs";
import path from "node:path";

import type { UsageEvent } from "../types.ts";
import { providerConfig } from "../config.ts";
import { eventId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { shellToolName } from "../tools.ts";
import { homePath, type EntryContext, type Provider, type SessionDoc } from "./types.ts";

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeAssistantMessage {
  id?: string;
  model?: string;
  usage?: ClaudeUsage;
  content?: unknown;
}

/** First tool_use block name in an assistant message, if any. */
function toolUseName(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && typeof b.name === "string" && b.name.length > 0) {
      if (b.name === "Bash") {
        const input = b.input as Record<string, unknown> | undefined;
        return shellToolName(input?.command);
      }
      return b.name;
    }
  }
  return undefined;
}

/**
 * Claude Code stores sessions as JSONL files under
 * $CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/... (incl. subagents/).
 * Assistant lines carry message.usage with token counts; some builds also
 * carry a costUSD field.
 */
export const claudeCodeProvider: Provider = {
  id: "claude-code",
  label: "Claude Code",
  envVar: "CLAUDE_CONFIG_DIR",

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return [homePath("CLAUDE_CONFIG_DIR", "/.claude/projects")];
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
    if (entry.type !== "assistant") return [];

    const message = entry.message as ClaudeAssistantMessage | undefined;
    const usage = message?.usage;
    if (usage === undefined) return [];

    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    // Skip empty assistant stubs (e.g. thinking-only retries)
    if (inputTokens === 0 && outputTokens === 0) return [];

    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : pathId(ctx.path);
    const entryId =
      (typeof message?.id === "string" ? message.id : undefined) ??
      (typeof entry.requestId === "string" ? entry.requestId : undefined) ??
      (typeof entry.uuid === "string" ? entry.uuid : sessionId);

    const ts = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
    const model = typeof message?.model === "string" ? message.model : "unknown";
    const projectDir = typeof entry.cwd === "string" ? entry.cwd : undefined;

    const costRaw = entry.costUSD ?? entry.costUsd;
    const costUsd = typeof costRaw === "number" ? costRaw : estimateCost(model, {
      inputTokens,
      outputTokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    });

    const event: UsageEvent = {
      id: eventId("claude-code", "default", sessionId, entryId),
      ts,
      machineId: ctx.machineId,
      provider: this.id,
      accountKey: "default",
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      costUsd,
      projectDir,
      sessionId,
      tool: toolUseName(message?.content),
    };
    return [event];
  },

  extractSessionDocs: extractClaudeSessionDocs,
};

/** Session id fallback derived from the claude-code directory layout. */
function pathId(p: string): string {
  return path.basename(p).replace(/\.jsonl$/, "");
}

const BODY_CAP = 1024 * 1024;

/** Text out of a claude message content (string or block array). */
function claudeTextBlocks(content: unknown, kind: "user" | "assistant"): string[] {
  if (typeof content === "string") return kind === "user" ? [content] : [];
  const out: string[] = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (kind === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
      out.push(`[tool:${b.name}]`);
    }
  }
  return out;
}

/** Full-text extraction: one conversation per .jsonl file. */
export function extractClaudeSessionDocs(file: string): SessionDoc[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let sessionId = pathId(file);
  let startedAt: string | undefined;
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
    if (typeof entry.sessionId === "string") sessionId = entry.sessionId;
    if (startedAt === undefined && typeof entry.timestamp === "string") startedAt = entry.timestamp;
    const type = entry.type;
    if (type !== "user" && type !== "assistant") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const role = typeof message?.role === "string" ? message.role : type;
    for (const text of claudeTextBlocks(message?.content, role as "user" | "assistant")) {
      if (role === "user" && title.length === 0) {
        title = text.replace(/\s+/g, " ").trim().slice(0, 200);
      }
      if (body.length + text.length > BODY_CAP) break;
      body += text.replace(/\s+/g, " ").slice(0, 2000) + "\n";
    }
    if (body.length >= BODY_CAP) break;
  }
  if (body.length === 0) return [];
  return [{ sessionId, startedAt, title, body }];
}

/** Recursive *.jsonl listing, sorted for deterministic cursor behavior. */
export function walkJsonl(root: string): string[] {
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
}
