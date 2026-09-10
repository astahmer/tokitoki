import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SyncAdapter } from "./types.ts";

interface DirSyncState {
  ownSize?: number;
  ownLines?: number;
  remote?: Record<string, { size: number; offset: number }>;
}

function expandUserPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Syncthing-style shared directory. Each machine owns exactly one file,
 * `<machineId>.jsonl`; machines never write each other's files so the folder
 * stays conflict-free under Syncthing. Pull reads every file except ours.
 */
export class DirAdapter implements SyncAdapter {
  readonly id = "dir" as const;
  readonly label: string;
  private readonly dir: string;
  private readonly stateFile: string | undefined;

  constructor(
    private readonly machineId: string,
    dir: string,
    stateFile?: string,
  ) {
    this.dir = expandUserPath(dir);
    this.stateFile = stateFile === undefined ? undefined : expandUserPath(stateFile);
    this.label = `dir:${dir}`;
  }

  private ownFile(): string {
    return path.join(this.dir, `${this.machineId}.jsonl`);
  }

  heartbeatDir(): string | null {
    return this.dir;
  }

  private loadState(): DirSyncState {
    if (this.stateFile === undefined) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as DirSyncState;
      return parsed !== null && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveState(state: DirSyncState): void {
    if (this.stateFile === undefined) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.stateFile);
  }

  private copyRange(source: string, target: string, from: number): number {
    const sourceFd = fs.openSync(source, "r");
    const targetFd = fs.openSync(target, from === 0 ? "w" : "a");
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let offset = from;
    let lines = 0;
    try {
      while (true) {
        const read = fs.readSync(sourceFd, buffer, 0, buffer.length, offset);
        if (read === 0) break;
        fs.writeSync(targetFd, buffer, 0, read);
        for (let i = 0; i < read; i += 1) if (buffer[i] === 0x0a) lines += 1;
        offset += read;
      }
    } finally {
      fs.closeSync(sourceFd);
      fs.closeSync(targetFd);
    }
    return lines;
  }

  async pushFile(file: string): Promise<number> {
    fs.mkdirSync(this.dir, { recursive: true });
    const state = this.loadState();
    let sourceSize: number;
    try {
      sourceSize = fs.statSync(file).size;
    } catch {
      return state.ownLines ?? 0;
    }

    const ownFile = this.ownFile();
    let existingSize = -1;
    try {
      existingSize = fs.statSync(ownFile).size;
    } catch {
      // First push on this machine.
    }

    let lines = state.ownLines ?? 0;
    if (state.ownSize === existingSize && existingSize >= 0 && existingSize <= sourceSize) {
      if (existingSize < sourceSize) lines += this.copyRange(file, ownFile, existingSize);
    } else {
      const tmp = `${ownFile}.tmp-${process.pid}`;
      lines = this.copyRange(file, tmp, 0);
      fs.renameSync(tmp, ownFile);
    }

    state.ownSize = fs.statSync(ownFile).size;
    state.ownLines = lines;
    this.saveState(state);
    return lines;
  }

  async push(lines: string[]): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const payload = Buffer.from(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    const ownFile = this.ownFile();
    const state = this.loadState();
    let existingSize = -1;
    try {
      existingSize = fs.statSync(ownFile).size;
    } catch {
      // First push on this machine.
    }

    // Each machine owns its own file and the local event log is append-only.
    // Continue from the last known byte so iCloud does not re-upload hundreds
    // of megabytes on every timer tick. If the file was replaced or shrank,
    // fall back to an atomic rewrite.
    if (state.ownSize === existingSize && existingSize >= 0 && existingSize <= payload.length) {
      if (existingSize < payload.length) {
        fs.appendFileSync(ownFile, payload.subarray(existingSize));
      }
    } else {
      const tmp = `${ownFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, ownFile);
    }
    state.ownSize = payload.length;
    state.ownLines = lines.length;
    this.saveState(state);
  }

  async *pull(): AsyncIterable<string> {
    const state = this.loadState();
    const remote = state.remote ?? {};
    let stateChanged = false;
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
      let raw: Buffer;
      try {
        raw = fs.readFileSync(file);
      } catch {
        continue; // raced with a sync tool mid-write
      }

      const previous = remote[name];
      const from = previous !== undefined && previous.offset <= raw.length ? previous.offset : 0;
      const tail = raw.subarray(from).toString("utf8");
      const lastNewline = tail.lastIndexOf("\n");
      let nextOffset = from;
      if (lastNewline >= 0) {
        const complete = tail.slice(0, lastNewline);
        nextOffset += Buffer.byteLength(complete, "utf8") + 1;
        for (const line of complete.split("\n")) yield line;
      }
      if (previous?.size !== raw.length || previous?.offset !== nextOffset) stateChanged = true;
      remote[name] = { size: raw.length, offset: nextOffset };
    }
    if (stateChanged) {
      state.remote = remote;
      this.saveState(state);
    }
  }
}
