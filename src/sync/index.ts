import fs from "node:fs";

import type { TokitokiConfig } from "../config.ts";
import { EventCache } from "../cache.ts";
import { localMachineId } from "../machine.ts";
import { dataDir, ensureDataDir, eventsFile } from "../store.ts";
import { lineToEvent, type SyncAdapter, type SyncConfig } from "./types.ts";
import { DirAdapter } from "./dir.ts";
import { GitAdapter } from "./git.ts";
import { AtprotoAdapter } from "./atproto.ts";

export * from "./types.ts";

export function getSyncBackend(cfg: SyncConfig, machineId = localMachineId()): SyncAdapter {
  switch (cfg.backend) {
    case "dir":
      if (cfg.path === undefined || cfg.path.length === 0) {
        throw new Error("sync backend 'dir' requires [sync].path in config");
      }
      return new DirAdapter(machineId, cfg.path);
    case "git":
      if (cfg.url === undefined || cfg.url.length === 0) {
        throw new Error("sync backend 'git' requires [sync].url in config");
      }
      return new GitAdapter(machineId, cfg.url, cfg.branch ?? "main");
    case "atproto":
      if (cfg.handle === undefined || cfg.handle.length === 0) {
        throw new Error("sync backend 'atproto' requires [sync].handle in config");
      }
      return new AtprotoAdapter({ ...cfg, handle: cfg.handle });
    default:
      throw new Error(
        `unknown or unconfigured sync backend: ${String(cfg.backend)} — set [sync] in config`,
      );
  }
}

/** Lines of this machine's local events log — the push payload. */
function localLines(): string[] {
  try {
    const raw = fs.readFileSync(eventsFile(), "utf8");
    return raw.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

export interface SyncResult {
  pushed: number;
  pulledValid: number;
  pulledInvalid: number;
}

/**
 * Run a sync round. Pulled valid lines are appended to the dedicated remote
 * log (never the local events.jsonl) and merged into reports through the
 * normal dedupe path.
 */
export async function runSync(adapter: SyncAdapter, mode: "push" | "pull" | "both"): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulledValid: 0, pulledInvalid: 0 };

  if (mode === "push" || mode === "both") {
    const lines = localLines();
    await adapter.push(lines);
    result.pushed = lines.length;
  }

  if (mode === "pull" || mode === "both") {
    const valid: string[] = [];
    for await (const line of adapter.pull()) {
      if (line.trim().length === 0) continue;
      if (lineToEvent(line) !== null) valid.push(line);
      else result.pulledInvalid += 1;
    }
    result.pulledValid = valid.length;
    // Appending is dedupe-safe: cache rebuilds INSERT OR IGNORE on event id,
    // and repeated pulls of identical lines collapse to no-ops.
    if (valid.length > 0) {
      ensureDataDir();
      fs.appendFileSync(remoteEventsFile(), valid.join("\n") + "\n");
      warmCache();
    }
  }

  return result;
}

/** Rebuild/refresh the sqlite projection so a later `report` needs no rescan. */
function warmCache(): void {
  const cache = new EventCache();
  try {
    cache.sync(syncedExtraFiles());
  } finally {
    cache.close();
  }
}

/** Remote lines land in their own append-log, never the local one. */
const REMOTE_LOG = "remote-events.jsonl";

function remoteEventsFile(): string {
  return `${dataDir()}/${REMOTE_LOG}`;
}

/** Extra merge sources contributed by the sync layer (pulled machines). */
export function syncedExtraFiles(): string[] {
  try {
    if (fs.statSync(remoteEventsFile()).size > 0) return [remoteEventsFile()];
  } catch {
    /* not created yet */
  }
  return [];
}

export type { TokitokiConfig };
