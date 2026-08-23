import fs from "node:fs";
import path from "node:path";

import type { SyncAdapter } from "./types.ts";

/**
 * Syncthing-style shared directory. Each machine owns exactly one file,
 * `<machineId>.jsonl`; machines never write each other's files so the folder
 * stays conflict-free under Syncthing. Pull reads every file except ours.
 */
export class DirAdapter implements SyncAdapter {
  readonly id = "dir" as const;
  readonly label: string;

  constructor(
    private readonly machineId: string,
    private readonly dir: string,
  ) {
    this.label = `dir:${dir}`;
  }

  private ownFile(): string {
    return path.join(this.dir, `${this.machineId}.jsonl`);
  }

  async push(lines: string[]): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    // Full atomic rewrite of OUR file: pushes are idempotent and Syncthing
    // resolves per-file, never merging partial content.
    const tmp = `${this.ownFile()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    fs.renameSync(tmp, this.ownFile());
  }

  async *pull(): AsyncIterable<string> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".jsonl")) continue;
      if (name === `${this.machineId}.jsonl`) continue; // own file: skip
      const file = path.join(this.dir, name);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue; // raced with a sync tool mid-write
      }
      for (const line of raw.split("\n")) yield line;
    }
  }
}
