import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SyncAdapter } from "./types.ts";
/**
 * Private git repo as the transport. Each machine commits its own
 * `<machineId>.jsonl`; pull fetches and reads everyone else's files.
 * Pure Bun.spawn git calls — no dependencies. Pushes are full-file commits,
 * so they are idempotent.
 */
export class GitAdapter implements SyncAdapter {
  readonly id = "git" as const;
  readonly label: string;

  constructor(
    private readonly machineId: string,
    private readonly url: string,
    private readonly branch: string = "main",
    private readonly workdir: string = path.join(os.tmpdir(), "tokitoki-sync-git"),
  ) {
    this.label = `git:${url}`;
  }

  private ownFile(): string {
    return path.join(this.workdir, `${this.machineId}.jsonl`);
  }

  heartbeatDir(): string | null {
    return this.workdir;
  }

  /** Run a git command, throwing on non-zero exit with stderr attached. */
  private async git(args: string[], allowFailure = false): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 && !allowFailure) {
      throw new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`);
    }
    return stdout;
  }

  private hasGitDir(): boolean {
    try {
      fs.accessSync(path.join(this.workdir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /** Clone when missing; otherwise fetch + hard-reset onto the remote branch. */
  private async syncRepo(): Promise<void> {
    if (!this.hasGitDir()) {
      fs.mkdirSync(this.workdir, { recursive: true });
      await this.git(["clone", "--branch", this.branch, "--single-branch", this.url, this.workdir]);
      return;
    }
    await this.git(["fetch", "origin", this.branch]);
    // Fresh empty branch may have no commits yet; tolerate that.
    await this.git(["reset", "--hard", `origin/${this.branch}`], true);
  }

  async push(lines: string[]): Promise<void> {
    await this.syncRepo();
    fs.writeFileSync(this.ownFile(), lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    // Presence heartbeat rides along with every push so other machines can
    // see this host without any extra network round-trip.
    const hb = path.join(this.workdir, `${this.machineId}.hb`);
    try {
      fs.writeFileSync(
        hb,
        JSON.stringify({ machine: this.machineId, host: os.hostname(), ts: Date.now() }),
      );
      await this.git(["add", `${this.machineId}.hb`]);
    } catch {
      // presence is decorative; never fail an event push over it
    }
    await this.git(["add", `${this.machineId}.jsonl`]);
    const status = await this.git(["status", "--porcelain"], true);
    if (status.trim().length === 0) return; // nothing new
    await this.git([
      "-c", "user.name=tokitoki",
      "-c", `user.email=tokitoki@${this.machineId}`,
      "commit", "-m", `tokitoki events from ${this.machineId}`,
    ]);
    await this.git(["push", "origin", `HEAD:${this.branch}`]);
  }

  async *pull(): AsyncIterable<string> {
    await this.syncRepo();
    let entries: string[];
    try {
      entries = fs.readdirSync(this.workdir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".jsonl")) continue;
      if (name === `${this.machineId}.jsonl`) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(this.workdir, name), "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) yield line;
    }
  }
}
