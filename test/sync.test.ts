import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DirAdapter } from "../src/sync/dir.ts";
import { GitAdapter } from "../src/sync/git.ts";
import { lineToEvent, type SyncAdapter } from "../src/sync/types.ts";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-sync-test-"));
  tmpDirs.push(dir);
  return dir;
}

function event(id: string, machineId = "other-mac"): string {
  return JSON.stringify({
    id,
    ts: "2026-08-23T10:00:00.000Z",
    machineId,
    provider: "pi",
    accountKey: "default",
    model: "test-model",
    inputTokens: 10,
    outputTokens: 5,
  });
}

async function collect(adapter: SyncAdapter): Promise<string[]> {
  const out: string[] = [];
  for await (const line of adapter.pull()) {
    if (line.trim().length > 0) out.push(line);
  }
  return out;
}

beforeEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("lineToEvent", () => {
  test("validates and rejects", () => {
    expect(lineToEvent(event("x"))?.id).toBe("x");
    expect(lineToEvent("not json")).toBeNull();
    expect(lineToEvent(JSON.stringify({ id: "no-ts" }))).toBeNull();
    expect(lineToEvent("")).toBeNull();
  });
});

describe("dir adapter", () => {
  test("push writes own file; pull reads only others", async () => {
    const dir = tmpDir();
    const mine = new DirAdapter("my-mac", dir);
    const theirs = new DirAdapter("other-mac", dir);

    await theirs.push([event("e1"), event("e2")]);
    await mine.push([event("m1", "my-mac")]);

    const seenByMine = await collect(mine);
    expect(seenByMine).toHaveLength(2); // other's two lines, not our own
    expect(seenByMine.every((l) => lineToEvent(l)?.machineId === "other-mac")).toBe(true);

    // Push is idempotent — same lines twice leave one copy.
    await mine.push([event("m1", "my-mac")]);
    expect(fs.readFileSync(path.join(dir, "my-mac.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("pull on missing directory yields nothing", async () => {
    const adapter = new DirAdapter("my-mac", path.join(tmpDir(), "does-not-exist"));
    expect(await collect(adapter)).toEqual([]);
  });

  test("invalid remote lines are yielded but flagged by lineToEvent", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "other-mac.jsonl"), event("ok") + "\ngarbage\n\n");
    const mine = new DirAdapter("my-mac", dir);
    const lines = [...(await (async () => { const acc = []; for await (const l of mine.pull()) acc.push(l); return acc; })())];
    expect(lines.filter((l) => lineToEvent(l) !== null)).toHaveLength(1);
    expect(lines.filter((l) => lineToEvent(l) === null && l.trim().length > 0)).toHaveLength(1);
  });
});

describe("git adapter (local bare repo)", () => {
  function initBareRepo(): { bare: string; work: string } {
    const base = tmpDir();
    const bare = path.join(base, "remote.git");
    const work = path.join(base, "seed");
    fs.mkdirSync(work, { recursive: true });
    const run = (cwd: string, args: string[]) => {
      Bun.spawnSync(["git", ...args], { cwd });
    };
    run(work, ["init", "-b", "main"]);
    run(work, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
    run(work, ["clone", "--bare", ".", bare]);
    return { bare, work: path.join(base, "a") };
  }

  test("push commits and pull sees the other machine's file", async () => {
    const repo = initBareRepo();
    fs.mkdirSync(repo.work, { recursive: true });
    // Machine A pushes via its own clone
    const a = new GitAdapter("mac-a", repo.bare, "main", repo.work);
    await a.push([event("a1", "mac-a")]);

    // Machine B pulls in a fresh clone
    const bDir = tmpDir() + "/b";
    const b = new GitAdapter("mac-b", repo.bare, "main", bDir);
    const lines: string[] = [];
    for await (const l of b.pull()) if (l.trim().length > 0) lines.push(l);

    expect(lines).toHaveLength(1);
    expect(lineToEvent(lines[0]!)?.machineId).toBe("mac-a");
  });

  test("second push is incremental and idempotent", async () => {
    const repo = initBareRepo();
    fs.mkdirSync(repo.work, { recursive: true });
    const a = new GitAdapter("mac-a", repo.bare, "main", repo.work);
    await a.push([event("a1", "mac-a")]);
    await a.push([event("a1", "mac-a"), event("a2", "mac-a")]);
    // Re-push identical content → no-op commit, still exactly 2 lines remotely
    await a.push([event("a1", "mac-a"), event("a2", "mac-a")]);
    const content = fs.readFileSync(path.join(repo.work, "mac-a.jsonl"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
  });
});
