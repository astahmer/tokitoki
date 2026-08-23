import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TokitokiConfig } from "./config.ts";

/**
 * Multi-machine presence. Each machine drops `<machineId>.hb` (JSON:
 * machine/host/ts) into the sync location during push; everyone else reads
 * those to show who is alive. Presence is best-effort: a missing or corrupt
 * file just means "unknown machine", never an error.
 */

export interface MachinePresence {
  machineId: string;
  host: string;
  /** Epoch ms of the heartbeat. */
  ts: number;
  /** active <10min · recent <1h · stale otherwise */
  state: "active" | "recent" | "stale";
}

const HB_SUFFIX = ".hb";

export function heartbeatFileName(machineId: string): string {
  return `${machineId}${HB_SUFFIX}`;
}

/** Atomic heartbeat write — same pattern as the dir adapter's jsonl push. */
export function writeHeartbeat(dir: string, machineId: string, now: Date = new Date()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ machine: machineId, host: os.hostname(), ts: now.getTime() });
    const tmp = path.join(dir, `${heartbeatFileName(machineId)}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, path.join(dir, heartbeatFileName(machineId)));
  } catch {
    // presence is decorative; never fail a sync over it
  }
}

export function presenceState(ts: number, now: Date = new Date()): MachinePresence["state"] {
  const age = Math.max(0, now.getTime() - ts);
  if (age < 10 * 60_000) return "active";
  if (age < 60 * 60_000) return "recent";
  return "stale";
}

/** Read every heartbeat in a directory, newest first. Tolerates absence. */
export function readPresence(dir: string, now: Date = new Date()): MachinePresence[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: MachinePresence[] = [];
  for (const name of entries) {
    if (!name.endsWith(HB_SUFFIX)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as {
        machine?: unknown;
        host?: unknown;
        ts?: unknown;
      };
      if (typeof raw.ts !== "number") continue;
      out.push({
        machineId: typeof raw.machine === "string" ? raw.machine : name.slice(0, -HB_SUFFIX.length),
        host: typeof raw.host === "string" ? raw.host : "?",
        ts: raw.ts,
        state: presenceState(raw.ts, now),
      });
    } catch {
      continue; // mid-write or garbage — skip
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/**
 * Every place another machine's heartbeat could plausibly live, without
 * touching the network: the dir-sync folder and the git worktree cache.
 */
export function presenceDirs(cfg: TokitokiConfig): string[] {
  const dirs: string[] = [];
  if (cfg.sync?.backend === "dir" && cfg.sync.path) dirs.push(cfg.sync.path);
  const gitWorkdir = path.join(os.tmpdir(), "tokitoki-sync-git");
  try {
    if (fs.statSync(path.join(gitWorkdir, ".git")).isDirectory()) dirs.push(gitWorkdir);
  } catch {
    /* no git workdir yet */
  }
  return [...new Set(dirs)];
}

/** Machines seen across all sync locations, deduped by id, newest first. */
export function collectMachines(cfg: TokitokiConfig, now: Date = new Date()): MachinePresence[] {
  const byId = new Map<string, MachinePresence>();
  for (const dir of presenceDirs(cfg)) {
    for (const p of readPresence(dir, now)) {
      const known = byId.get(p.machineId);
      if (known === undefined || p.ts > known.ts) byId.set(p.machineId, p);
    }
  }
  return [...byId.values()].sort((a, b) => b.ts - a.ts);
}
