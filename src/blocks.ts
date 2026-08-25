import { bar, formatCost, formatInt } from "./format.ts";

/**
 * Claude-style 5-hour billing blocks (ccusage semantics): events partition
 * into consecutive windows of [start, start+5h); the first event defines a
 * block's start, and any event falling outside the current block opens the
 * next one. Partitioning is per account_key — real Claude limits are tracked
 * per account, so two accounts never share a block.
 */

/** Claude billing window length in milliseconds. */
export const BLOCK_MS = 5 * 60 * 60 * 1000;

export interface BlockRow {
  accountKey: string;
  startIso: string;
  endIso: string;
  tokens: number;
  costUsd: number;
  requests: number;
  /** True for the still-open block (endIso is after `now`). */
  isActive: boolean;
}

interface BlockEvent {
  ts: number;
  accountKey: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/**
 * Partition time-ordered events into 5-hour blocks per account.
 * Input need not be pre-sorted; ties keep insertion order.
 */
export function partitionBlocks(
  events: BlockEvent[],
  now: number = Date.now(),
): BlockRow[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  // Open blocks keyed by account; an account's block closes only when an
  // event lands outside [start, start+BLOCK_MS).
  const open = new Map<string, { start: number; tokens: number; cost: number; requests: number }>();
  const closed: BlockRow[] = [];

  for (const e of sorted) {
    let b = open.get(e.accountKey);
    if (b !== undefined && e.ts >= b.start + BLOCK_MS) {
      closed.push(finishBlock(b, e.accountKey));
      open.delete(e.accountKey);
      b = undefined;
    }
    if (b === undefined) {
      b = { start: e.ts, tokens: 0, cost: 0, requests: 0 };
      open.set(e.accountKey, b);
    }
    b.tokens += e.inputTokens + e.outputTokens + e.cacheReadTokens;
    b.cost += e.costUsd;
    b.requests += 1;
  }
  for (const [accountKey, b] of open) {
    closed.push({ ...finishBlock(b, accountKey), isActive: b.start + BLOCK_MS > now });
  }
  return closed;
}

function finishBlock(
  b: { start: number; tokens: number; cost: number; requests: number },
  accountKey: string,
): BlockRow {
  return {
    accountKey,
    startIso: new Date(b.start).toISOString(),
    endIso: new Date(b.start + BLOCK_MS).toISOString(),
    tokens: b.tokens,
    costUsd: b.cost,
    requests: b.requests,
    isActive: false, // set by caller for still-open blocks
  };
}

/** Human line for one block row: gauge + spend + countdown when active. */
export function describeBlock(row: BlockRow, now: number = Date.now()): string {
  if (!row.isActive) {
    return `${row.accountKey} ${row.startIso.slice(11, 16)}–${row.endIso.slice(11, 16)} · ${formatCost(row.costUsd)}`;
  }
  const remainingMin = Math.max(0, Math.round((Date.parse(row.endIso) - now) / 60000));
  const elapsed = Math.min(1, Math.max(0, (now - Date.parse(row.startIso)) / BLOCK_MS));
  return (
    `${row.accountKey} ACTIVE ${bar(elapsed, 10)} · ${formatCost(row.costUsd)} · ` +
    `${formatInt(remainingMin)}m left`
  );
}

/**
 * Table of recent blocks (newest last), plus a one-line gauge for the active
 * block when there is one — mirrors report.ts table + planGauge style.
 */
export function renderBlocks(rows: BlockRow[], now: number = Date.now()): string {
  if (rows.length === 0) {
    return "no billing blocks in this window — run `tokitoki scan` first";
  }
  const shown = rows.slice(-12);
  const lines: string[] = [
    "account      window (local)        req   tokens   cost",
    "-----------  --------------------  ----  -------  ------",
  ];
  for (const r of shown) {
    const activeMark = r.isActive ? "▸" : " ";
    lines.push(
      `${activeMark}${r.accountKey.padEnd(11).slice(0, 11)}  ` +
        `${r.startIso.slice(5, 16)}–${r.endIso.slice(11, 16)}  ` +
        `${String(r.requests).padStart(4)}  ${formatInt(r.tokens).padStart(7)}  ${formatCost(r.costUsd)}`,
    );
  }
  const active = rows.find((r) => r.isActive);
  if (active !== undefined) lines.push("", describeBlock(active, now));
  return lines.join("\n");
}
