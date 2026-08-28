import fs from "node:fs";
import path from "node:path";

import type { UsageEvent } from "../types.ts";
import { providerConfig } from "../config.ts";
import { eventId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { sessionMessage } from "../sessionText.ts";
import { homePath, type EntryContext, type Provider, type SessionDoc } from "./types.ts";

/**
 * Gemini CLI chat history under ~/.gemini/tmp/<project-hash>/chats/session-*.json.
 *
 * Format (gemini-cli ChatRecordingService, observed in the wild):
 *   whole-file JSON, either an array of records or {"messages":[...]}:
 *     {"type":"user"|"gemini"|"info","text":"...",
 *      "timestamp": <ISO string | epoch ms>,
 *      "tokens":{"input":N,"output":N,"cached":N,"total":N,"thoughts":N}}
 *
 * Token objects are only recorded when the CLI has stats enabled — sessions
 * without them contribute search docs but zero events (never guessed).
 */
export const geminiCliProvider: Provider = {
  id: "gemini-cli",
  label: "Gemini CLI",
  envVar: "GEMINI_CLI_DIR",

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return [homePath("GEMINI_CLI_DIR", "/.gemini/tmp")];
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
        else if (e.isFile() && e.name.startsWith("session-") && e.name.endsWith(".json")) out.push(full);
      }
    }
    return out.sort();
  },

  /**
   * Session files are whole-file JSON (often pretty-printed), not JSONL.
   * The scan loop feeds lines; we parse once on the first complete line by
   * re-reading the file, then mark state.done so remaining lines are skipped.
   */
  parseLine(line: string, ctx: EntryContext): UsageEvent[] {
    const state = ctx.state as Record<string, unknown>;
    if (state.done === true) return [];
    state.done = true;
    try {
      JSON.parse(line); // single-line JSON files parse directly
    } catch {
      // pretty-printed or truncated first line — fall through to full read
    }
    const records = readRecords(ctx.path);
    const sessionId = path.basename(ctx.path).replace(/\.json$/, "");
    const events: UsageEvent[] = [];
    let startedAt: string | undefined;
    let model = "unknown";
    let index = 0;
    for (const rec of records) {
      index += 1;
      const ts = normalizeTs(rec.timestamp);
      if (ts !== undefined && startedAt === undefined) startedAt = ts;
      if (typeof rec.model === "string") model = rec.model;
      const tokens = rec.tokens as Record<string, unknown> | undefined;
      if (tokens === undefined || typeof tokens !== "object") continue;
      const inputTokens = num(tokens.input);
      const outputTokens = num(tokens.output ?? tokens.total);
      if (inputTokens === 0 && outputTokens === 0) continue;
      const cachedInput = num(tokens.cached);
      events.push({
        id: eventId("gemini-cli", "default", sessionId, `rec-${index}`),
        ts: ts ?? new Date().toISOString(),
        machineId: ctx.machineId,
        provider: "gemini-cli",
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
        projectDir: typeof rec.projectHash === "string" ? rec.projectHash : path.basename(path.dirname(path.dirname(ctx.path))),
        sessionId,
      });
    }
    return events;
  },

  extractSessionDocs(file: string): SessionDoc[] {
    const records = readRecords(file);
    if (records.length === 0) return [];
    const sessionId = path.basename(file).replace(/\.json$/, "");
    let title = "";
    let body = "";
    let startedAt: string | undefined;
    for (const rec of records) {
      const text = typeof rec.text === "string" ? rec.text : "";
      if (text.length === 0) continue;
      const role = rec.type === "user" ? "user" : rec.type === "gemini" ? "assistant" : undefined;
      if (role === "user") {
        if (title.length === 0) title = text.replace(/\s+/g, " ").trim().slice(0, 200);
        const message = sessionMessage("user", text, normalizeTs(rec.timestamp));
        if (message.length > 0) body += `${message}\n\n`;
      } else if (role === "assistant") {
        const message = sessionMessage("assistant", text, normalizeTs(rec.timestamp));
        if (message.length > 0) body += `${message}\n\n`;
      }
      const ts = normalizeTs(rec.timestamp);
      if (ts !== undefined && startedAt === undefined) startedAt = ts;
      if (body.length >= 512 * 1024) break;
    }
    if (body.length === 0 && title.length === 0) return [];
    return [{ sessionId, startedAt, title, body }];
  },
};

interface GemRecord extends Record<string, unknown> {
  type?: unknown;
  text?: unknown;
  timestamp?: unknown;
  model?: unknown;
  tokens?: unknown;
}

function readRecords(file: string): GemRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // tolerate trailing partial writes: take lines that individually parse
    const records: GemRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim().replace(/,$/, "");
      if (trimmed.length < 2) continue;
      try {
        const one = JSON.parse(trimmed) as unknown;
        if (one !== null && typeof one === "object") records.push(one as GemRecord);
      } catch {
        continue;
      }
    }
    return records;
  }
  if (Array.isArray(parsed)) return parsed as GemRecord[];
  if (parsed !== null && typeof parsed === "object") {
    const messages = (parsed as Record<string, unknown>).messages;
    if (Array.isArray(messages)) return messages as GemRecord[];
  }
  return [];
}

function normalizeTs(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return new Date(Number(value)).toISOString();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  if (typeof value === "number") {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  return undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
