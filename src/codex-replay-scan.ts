import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { codexForkParentId, codexThreadId, planCodexReplay } from "./providers/codex-replay.ts";
import type { FileScanState } from "./providers/types.ts";

const headerSchema = z.object({ type: z.literal("session_meta"), payload: z.record(z.string(), z.unknown()) });

// Verification is optional: oversized or unreadable records retain usage.
const completeLines = function* (file: string): Generator<string> {
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  let consumed = 0;
  try {
    while (consumed < 64 * 1024 * 1024) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return;
      consumed += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let start = 0;
      for (;;) {
        const end = pending.indexOf(10, start);
        if (end < 0) break;
        yield pending.subarray(start, end).toString("utf8");
        start = end + 1;
      }
      pending = pending.subarray(start);
      if (pending.length > 8 * 1024 * 1024) return;
    }
  } finally { fs.closeSync(fd); }
};

/** Only discovered files in the same native home can prove a replay. */
export const codexReplayScanner = (input: { files: string[]; roots: string[] }) => {
  const sources = new Map<string, { path: string; scope: string; id?: string; parent?: string; stamp: string }>();
  const roots = input.roots.flatMap(root => {
    try { return [fs.realpathSync(root)]; } catch { return []; }
  }).sort((a, b) => b.length - a.length);
  for (const file of input.files) {
    try {
      const canonical = fs.realpathSync(file);
      if (sources.has(canonical)) continue;
      const root = roots.find(root => canonical.startsWith(root + path.sep));
      if (root === undefined) continue;
      const scope = ["sessions", "archived_sessions"].includes(path.basename(root)) ? path.dirname(root) : root;
      const reader = completeLines(canonical);
      let first: string | undefined;
      try { first = reader.next().value; } finally { reader.return(undefined); }
      const parsed = headerSchema.safeParse(first === undefined ? undefined : JSON.parse(first));
      const stat = fs.statSync(canonical);
      sources.set(canonical, { path: canonical, scope, stamp: `${stat.size}:${stat.mtimeMs}`,
        ...(parsed.success ? { id: codexThreadId(parsed.data.payload), parent: codexForkParentId(parsed.data.payload) } : {}) });
    } catch { /* No proof is safer than a guessed duplicate. */ }
  }
  return {
    files: [...sources.keys(), ...input.files.filter(file => {
      try { return !sources.has(fs.realpathSync(file)); } catch { return true; }
    })],
    prepare: (file: string, state: FileScanState): boolean => {
      const child = sources.get(file);
      const parent = child?.parent === undefined ? undefined : [...sources.values()].find(source =>
        source.scope === child.scope && source.id === child.parent && source.path !== child.path);
      const stamp = child?.parent === undefined ? undefined : JSON.stringify([child.stamp, child.parent, parent?.path, parent?.stamp]);
      if (stamp === state.codexReplayStamp) return false;
      const hadPlan = state.codexReplayPlan !== undefined;
      const changed = state.codexReplayStamp !== undefined;
      delete state.codexReplayPlan;
      state.codexReplayStamp = stamp;
      if (child !== undefined && parent !== undefined) {
        const seen = new Set([child.path]);
        let ancestor: typeof parent | undefined = parent;
        while (ancestor !== undefined) {
          if (seen.has(ancestor.path)) return changed || hadPlan;
          seen.add(ancestor.path);
          const parentId: string | undefined = ancestor.parent;
          ancestor = parentId === undefined ? undefined : [...sources.values()].find(source =>
            source.scope === child.scope && source.id === parentId);
        }
        try { state.codexReplayPlan = planCodexReplay({ child: { ...child, lines: completeLines(child.path) }, parent: { ...parent, lines: completeLines(parent.path) } }); }
        catch { /* A failed proof never suppresses a request. */ }
      }
      return changed || hadPlan;
    },
  };
};
