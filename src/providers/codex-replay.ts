import { z } from "zod";

import type { FileScanState } from "./types.ts";

// Frozen stock source: openai/codex e363b08c9175ac1cbe5893615dd2cb9ddf95043b
// (rust-v0.146.0): protocol/src/protocol.rs (SessionMeta, TurnContextItem,
// TokenCountEvent), core/src/session/mod.rs (record_initial_history), and
// rollout/src/recorder.rs (JsonlWriter). Fork copies retain RolloutItems but
// receive new envelope timestamps/ordinals. token_count has no response ID.
const recordSchema = z.record(z.string(), z.unknown());
const idSchema = z.string().min(1).refine(value => value.trim().length > 0);
const planSchema = z.object({
  version: z.literal(1),
  childPath: z.string().min(1),
  childThreadId: idSchema,
  parentThreadId: idSchema,
  fromLine: z.number().int().nonnegative(),
  throughLine: z.number().int().nonnegative(),
});

export type CodexReplayPlan = z.infer<typeof planSchema>;

export interface CodexReplaySource {
  /** Canonical file path selected by discovery; never a filename-derived ID. */
  path: string;
  /** Canonical Codex home/account scope shared by sessions and archives. */
  scope: string;
  /** Complete JSONL lines only, from byte zero; no filesystem reads here. */
  lines: Iterable<string>;
}

const object = (value: unknown): Record<string, unknown> | undefined => {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const codexThreadId = (payload: Record<string, unknown>): string | undefined =>
  idSchema.safeParse(payload.id).data;

export const codexForkParentId = (payload: Record<string, unknown>): string | undefined => {
  const source = object(payload.source);
  const subagent = object(source?.subagent);
  const spawn = object(subagent?.thread_spawn);
  // A generic parent_thread_id is not evidence of copied history.
  return idSchema.safeParse(payload.forked_from_id).data ?? idSchema.safeParse(spawn?.parent_thread_id).data;
};

function* records(lines: Iterable<string>) {
  let index = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const entry = object(raw);
    const payload = object(entry?.payload);
    if (entry === undefined || payload === undefined || typeof entry.type !== "string") return;
    yield { index: index++, type: entry.type, payload };
  }
}

// Compare the entire item, including messages, tools, quota and all counters.
// This is ordered structural equality, not a cross-session token fingerprint.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/**
 * Scan integration contract: select ONE parent from the same canonical scope,
 * including archives, whose first metadata.id equals the explicit lineage ID.
 * The parent must participate in accounting. Call before parsing the child and
 * seed state.codexReplayPlan with the result (delete it for undefined). Rebuild
 * on growth/replacement/extraction replay; never retain an old plan on failure.
 * Re-plan growing copied prefixes before resuming their saved byte cursor.
 * Discovery, parent availability, invalidation and historical cleanup belong to
 * the scanner/cache; parseLine cannot infer them from a single child line.
 *
 * Only an exact ordered prefix with an explicit copied turn ID is suppressible.
 * Stop permanently at the first mismatch; never search ahead or match amounts.
 * No parent, missing IDs or altered history conservatively retains usage.
 */
export const planCodexReplay = (input: {
  child: CodexReplaySource;
  parent: CodexReplaySource;
}): CodexReplayPlan | undefined => {
  if (!input.child.scope || input.child.scope !== input.parent.scope || input.child.path === input.parent.path) return;
  const child = records(input.child.lines);
  const parent = records(input.parent.lines);
  try {
    const childMeta = child.next().value;
    const parentMeta = parent.next().value;
    if (childMeta?.type !== "session_meta" || parentMeta?.type !== "session_meta") return;
    const childId = codexThreadId(childMeta.payload);
    const parentId = codexThreadId(parentMeta.payload);
    if (childId === undefined || parentId === undefined || childId === parentId ||
      codexForkParentId(childMeta.payload) !== parentId) return;

    let expected: typeof parentMeta | undefined | void = parentMeta;
    let fromLine: number | undefined;
    let throughLine: number | undefined;
    for (const copied of child) {
      // Copied histories may include the parent's metadata or start after it.
      if (expected === parentMeta && copied.type !== "session_meta") expected = parent.next().value;
      if (expected === undefined || expected.type !== copied.type ||
        canonical(expected.payload) !== canonical(copied.payload)) break;
      if (copied.type === "turn_context" && idSchema.safeParse(copied.payload.turn_id).success) {
        fromLine ??= copied.index;
      }
      if (fromLine !== undefined) throughLine = copied.index;
      expected = parent.next().value;
    }
    if (fromLine === undefined || throughLine === undefined) return;
    return { version: 1, childPath: input.child.path, childThreadId: childId, parentThreadId: parentId, fromLine, throughLine };
  } finally {
    child.return(undefined);
    parent.return(undefined);
  }
};

export const isCodexReplayLine = (input: {
  path: string;
  state: FileScanState;
  lineIndex: number;
}): boolean => {
  const parsed = planSchema.safeParse(input.state.codexReplayPlan);
  if (!parsed.success) return false;
  const plan = parsed.data;
  return plan.childPath === input.path && plan.childThreadId === input.state.codexThreadId &&
    plan.parentThreadId === input.state.codexForkedFromId && plan.fromLine <= input.lineIndex &&
    input.lineIndex <= plan.throughLine;
};

export const isCodexOriginalLine = (input: { path: string; state: FileScanState; lineIndex: number }): boolean => {
  if (typeof input.state.codexThreadId !== "string") return false;
  if (input.state.codexForkedFromId === undefined) return true;
  const parsed = planSchema.safeParse(input.state.codexReplayPlan);
  if (!parsed.success) return false;
  const plan = parsed.data;
  return plan.childPath === input.path && plan.childThreadId === input.state.codexThreadId &&
    plan.parentThreadId === input.state.codexForkedFromId && input.lineIndex > plan.throughLine;
};
