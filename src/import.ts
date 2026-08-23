import type { UsageEvent } from "./types.ts";
import { localMachineId } from "./machine.ts";

/**
 * Backfill imports: turn provider console usage CSVs into UsageEvents so
 * pre-tokitoki history merges into totals.
 *
 * Sources (tolerant header mapping — exact names vary by export date):
 * - anthropic console CSV: per-request rows with token columns + cost
 * - openai usage CSV: aggregated daily rows per model
 * - openrouter activity CSV: per-activity rows with prompt/completion tokens + cost
 *
 * Events are tagged `provider = "anthropic-import"` etc. and dedupe on a
 * stable row hash, so re-importing the same file is a no-op.
 */

export type ImportSource = "anthropic" | "openai" | "openrouter";

export const IMPORT_SOURCES: ImportSource[] = ["anthropic", "openai", "openrouter"];

// ------------------------------------------------------------------ csv

/** Minimal RFC-4180-ish CSV reader: quoted fields, "" escapes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      /* skip */
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

function headerIndex(headers: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const idx = headers.findIndex((h) => pattern.test(h));
    if (idx >= 0) return idx;
  }
  return -1;
}

interface ColumnMap {
  timestamp?: number;
  model?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

/** Guess which columns mean what. Pure + testable. */
export function mapColumns(headers: string[]): { source: ImportSource | null; map: ColumnMap } {
  const h = headers.map((x) => x.toLowerCase());
  const find = (patterns: RegExp[]): number => headerIndex(h, patterns);

  const map: ColumnMap = {
    timestamp: find([/timestamp/, /^date$/, /datetime/]),
    model: find([/^model$/, /model/]),
    input: find([/(unspecified )?input.*token/, /prompt.*token/, /^input$/]),
    output: find([/output.*token/, /completion.*token/, /^output$/]),
    cacheRead: find([/cache.*read/, /cached.*token/]),
    cacheWrite: find([/cache.*(write|creation)/]),
    cost: find([/cost/]),
  };

  // Distinguish sources by signature headers.
  const joined = h.join("|");
  let source: ImportSource | null = null;
  if (/request.?id|transaction.?id/.test(joined) && map.cacheRead !== undefined) source = "anthropic";
  else if (joined.includes("usage.") || /api_key/.test(joined)) source = "openai";
  else if (/provider/.test(joined) && map.cost !== undefined) source = "openrouter";
  return { source, map };
}

function num(row: string[], idx: number | undefined): number {
  const value = cell(row, idx);
  return parseNum(value);
}

function parseNum(value: string | undefined): number {
  if (value === undefined) return 0;
  const n = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function cell(row: string[], idx: number | undefined): string | undefined {
  return idx === undefined || idx < 0 ? undefined : row[idx];
}

/** Stable dedupe id for one CSV row. Same file re-imported → same ids. */
export function importedEventId(source: string, cells: Array<string | undefined>): string {
  // FNV-1a over the canonical row — fast, stable across runs.
  const text = `${source}|${cells.map((c) => c ?? "").join("|")}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `import:${source}:${(hash >>> 0).toString(36)}`;
}

export interface ImportResult {
  source: ImportSource | null;
  events: UsageEvent[];
  skipped: number;
}

export function importCsv(text: string, machineId: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { source: null, events: [], skipped: rows.length };
  const headers = rows[0]!;
  const body = rows.slice(1);
  const { source, map } = mapColumns(headers);
  if (source === null || map.model === undefined || map.timestamp === undefined) {
    return { source, events: [], skipped: body.length };
  }
  const events: UsageEvent[] = [];
  let skipped = 0;
  for (const row of body) {
    const tsRaw = row[map.timestamp!]?.trim();
    const ms = tsRaw !== undefined && tsRaw.length > 0 ? Date.parse(tsRaw) : Number.NaN;
    const model = row[map.model!]?.trim();
    const input = num(row, map.input);
    const output = num(row, map.output);
    if (Number.isNaN(ms) || model === undefined || model.length === 0 || (input === 0 && output === 0)) {
      skipped++;
      continue;
    }
    const cacheRead = num(row, map.cacheRead);
    const cacheWrite = num(row, map.cacheWrite);
    const costCell = cell(row, map.cost);
    const costUsd = costCell !== undefined && costCell.trim().length > 0 ? parseNum(costCell) : undefined;
    events.push({
      id: importedEventId(source, [
        cell(row, map.timestamp),
        cell(row, map.model),
        cell(row, map.input),
        cell(row, map.output),
        cell(row, map.cacheRead),
        cell(row, map.cacheWrite),
        cell(row, map.cost),
      ]),
      ts: new Date(ms).toISOString(),
      machineId,
      provider: `${source}-import`,
      accountKey: "imported",
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
  }
  return { source, events, skipped };
}


