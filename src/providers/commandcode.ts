import fs from "node:fs";

import type { UsageEvent } from "../types.ts";
import { providerConfig } from "../config.ts";
import { eventId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { sessionMessage, summarizeToolCall } from "../sessionText.ts";
import { shellToolName } from "../tools.ts";
import { homePath, type EntryContext, type Provider, type SessionDoc } from "./types.ts";
import { walkJsonl } from "./claude-code.ts";

/**
 * Command Code (commandcode.ai, npm `command-code`, CLI `cmd`) sessions live
 * under ~/.commandcode/sessions/<sessionId>.jsonl (HOME/USERPROFILE based;
 * no dedicated data-dir env override). Format reverse-engineered from
 * command-code@1.33.0 dist/cli.mjs — near-identical to pi's JSONL with two
 * differences:
 *   - usage rides on the ENTRY, not inside message: {inputTokens,
 *     outputTokens, cacheReadTokens, cacheWriteTokens, costUsd?}
 *   - model is a top-level entry field (model_change entries carry it too)
 *
 * Quota API: api.commandcode.ai exists behind login but no public usage
 * endpoint is documented — polling is a future round.
 */
export const commandcodeProvider: Provider = {
  id: "commandcode",
  label: "command code",

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return [homePath("", "/.commandcode/sessions")];
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
        delete state.sessionId;
        delete state.cwd;
      }
      if (typeof entry.id === "string") state.sessionId = entry.id;
      if (typeof entry.cwd === "string") state.cwd = entry.cwd;
      return [];
    }
    if (type === "model_change") {
      if (typeof entry.model === "string") state.model = entry.model;
      return [];
    }
    if (type !== "message") return [];

    // Usage lives on the entry itself, not inside message.
    const usage = entry.usage as Record<string, unknown> | undefined;
    const inputTokens = toNum(usage?.inputTokens);
    const outputTokens = toNum(usage?.outputTokens);
    if (inputTokens === 0 && outputTokens === 0) return [];

    const cacheRead = toNum(usage?.cacheReadTokens);
    const cacheWrite = toNum(usage?.cacheWriteTokens);
    const reportedCost = toNum(usage?.costUsd);

    const sessionId = typeof state.sessionId === "string" ? state.sessionId : "unknown-session";
    const model =
      typeof entry.model === "string" && entry.model.length > 0
        ? entry.model
        : typeof state.model === "string"
          ? state.model
          : "unknown";
    // Command Code routes everything through its own gateway; account split
    // comes from auth.json, not the transcript.
    const accountKey = "default";

    const costUsd =
      reportedCost > 0
        ? reportedCost
        : estimateCost(model, { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

    const message = entry.message as Record<string, unknown> | undefined;
    const tool = toolNameFromContent(message?.content);

    const ts = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
    const entryId = typeof entry.id === "string" ? entry.id : `line-${hashLine(line)}`;

    const event: UsageEvent = {
      id: eventId(this.id, accountKey, sessionId, entryId),
      ts,
      machineId: ctx.machineId,
      provider: this.id,
      accountKey,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd,
      projectDir: typeof state.cwd === "string" ? state.cwd : undefined,
      sessionId,
      ...(tool !== undefined ? { tool } : {}),
    };
    return [event];
  },

  extractSessionDocs: extractCommandCodeSessionDocs,

  usageNote:
    "~/.commandcode/sessions/*.jsonl — entry-level usage {inputTokens,outputTokens,cacheRead*,costUsd}; auth in ~/.commandcode/auth.json",
};

/** Tool/function name out of a Command Code assistant content block array. */
function toolNameFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool" && b.type !== "tool_use" && b.type !== "toolCall") continue;
    if (typeof b.name !== "string" || b.name.length === 0) continue;
    if (b.name === "shell_command" || b.name === "bash" || b.name === "shell") {
      return shellToolName((b.input as Record<string, unknown> | undefined)?.command);
    }
    return b.name;
  }
  return undefined;
}

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

const BODY_CAP = 1024 * 1024;

function textBlocks(content: unknown, role: string): string[] {
  if (typeof content === "string") return role === "user" ? [content] : [];
  const out: string[] = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (role === "assistant" && typeof b.name === "string") {
      out.push(`[tool:${b.name}]`);
    }
  }
  return out;
}

/** Full-text extraction: one session per file (session line sets the id). */
export function extractCommandCodeSessionDocs(file: string): SessionDoc[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let sessionId: string | undefined;
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
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      if (typeof entry.timestamp === "string") startedAt = entry.timestamp;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const role = typeof message?.role === "string" ? message.role : "";
    if (role !== "user" && role !== "assistant") continue;
    for (const text of textBlocks(message?.content, role)) {
      if (role === "user" && title.length === 0) {
        title = text.replace(/\s+/g, " ").trim().slice(0, 200);
      }
      const isTool = text.startsWith("[tool:") && text.endsWith("]");
      const message = sessionMessage(isTool ? "tool" : role === "user" ? "user" : "assistant", isTool ? summarizeToolCall(text.slice(6, -1)) : text, typeof entry.timestamp === "string" ? entry.timestamp : undefined);
      if (message.length === 0) continue;
      if (body.length + message.length > BODY_CAP) break;
      body += message + "\n\n";
    }
    if (body.length >= BODY_CAP) break;
  }
  if (sessionId === undefined || body.length === 0) return [];
  return [{ sessionId, startedAt, title, body }];
}

/** Deterministic fallback when an entry lacks an id. */
function hashLine(line: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
