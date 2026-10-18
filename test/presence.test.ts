import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectMachines, writeHeartbeat } from "../src/presence.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("presence", () => {
  it("marks only the current machine as local", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-presence-"));
    directories.push(directory);
    const now = new Date("2026-10-18T12:00:00Z");
    writeHeartbeat(directory, "laptop", now);
    writeHeartbeat(directory, "desktop", new Date(now.getTime() - 60_000));

    const machines = collectMachines({ sync: { backend: "dir", path: directory } }, now, "laptop");

    expect(machines.map((machine) => [machine.machineId, machine.local === true])).toEqual([
      ["laptop", true],
      ["desktop", false],
    ]);
    expect(machines[1]).not.toHaveProperty("local");
  });
});
