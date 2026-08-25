import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { rotateEventsLog, readArchiveMonths, archiveFilePath } from "../src/archive.ts";
import { eventsFile, readEventsFile } from "../src/store.ts";
import type { UsageEvent } from "../src/types.ts";

const NOW = new Date("2026-08-25T12:00:00.000Z"); // keepMonths=3 → cutoff 2026-05

function makeEvent(id: string, ts: string): UsageEvent {
  return {
    id,
    ts,
    machineId: "mac-one",
    provider: "pi",
    accountKey: "default",
    model: "m1",
    inputTokens: 10,
    outputTokens: 5,
  };
}

function setup(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-archive-"));
  process.env.TOKITOKI_DATA_DIR = dir;
  return dir;
}

/** Events across 5 months: 03..07 (04..06 archivable at cutoff 05... see test). */
function seedLog(): { ids: string[]; linesById: Map<string, string> } {
  const months = ["2026-01", "2026-03", "2026-05", "2026-07", "2026-08"];
  const ids: string[] = [];
  const linesById = new Map<string, string>();
  const lines: string[] = [];
  let i = 0;
  for (const m of months) {
    for (let j = 0; j < 3; j++) {
      const id = `evt-${m}-${j}`;
      const ts = `${m}-15T10:00:${String(j).padStart(2, "0")}Z`;
      const line = JSON.stringify(makeEvent(id, ts));
      ids.push(id);
      linesById.set(id, line);
      lines.push(line);
      i++;
      void i;
    }
  }
  // one corrupt line (no valid ts) — must survive rotation in the live log
  lines.push('{"id":"corrupt-no-ts","machineId":"x"}');
  writeFileSync(eventsFile(), lines.join("\n") + "\n");
  return { ids, linesById };
}

describe("rotateEventsLog", () => {
  it("archives months older than the cutoff per-month and keeps recent data", async () => {
    const env = setup();
    try {
      const { ids, linesById } = seedLog();
      // cutoff = 2026-05 → strictly older months archive: 2026-01, 2026-03
      const result = await rotateEventsLog({ now: NOW });
      expect(result.rotated).toEqual(["2026-01", "2026-03"]);
      expect(result.bytesSaved).toBeGreaterThan(0);

      expect(readArchiveMonths()).toEqual(["2026-01", "2026-03"]);
      expect(existsSync(archiveFilePath("2026-01"))).toBe(true);

      // live log keeps 2026-05/07/08 (+ the corrupt raw line, which
      // readEventsFile skips as an invalid event)
      const live = readEventsFile(eventsFile());
      expect(live.map((e) => e.id).sort()).toEqual(
        ids.filter((id) => !id.startsWith("evt-2026-01") && !id.startsWith("evt-2026-03")).sort(),
      );
      expect(readFileSync(eventsFile(), "utf8")).toContain('"corrupt-no-ts"');

      // archives reconstruct exact content (gunzip directly)
      for (const month of ["2026-01", "2026-03"]) {
        const text = gunzipSync(readFileSync(archiveFilePath(month))).toString("utf8");
        for (const line of text.trim().split("\n")) {
          const parsed = JSON.parse(line) as { id: string };
          expect(linesById.get(parsed.id)).toBe(line);
        }
      }
      void env;
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("is idempotent — re-running never duplicates archived ids", async () => {
    setup();
    try {
      seedLog();
      await rotateEventsLog({ now: NOW });

      // re-seed some already-archived lines into the live log (simulates a
      // crash between archive write and log rewrite) + rerun
      appendArchivedBack(["evt-2026-01-0", "evt-2026-03-1"]);
      const second = await rotateEventsLog({ now: NOW });
      // the two re-appended lines are re-archived into their months…
      expect(second.rotated.sort()).toEqual(["2026-01", "2026-03"]);
      expect(second.bytesSaved).toBeGreaterThan(0);
      await rotateEventsLog({ now: NOW }); // …and a third run is a full no-op
      expect((await rotateEventsLog({ now: NOW })).rotated).toEqual([]);

      for (const month of readArchiveMonths()) {
        const text = gunzipSync(readFileSync(archiveFilePath(month))).toString("utf8");
        const idsInFile = text.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id);
        expect(new Set(idsInFile).size).toBe(idsInFile.length); // no duplicates within a file
        if (month === "2026-01") expect(idsInFile).toContain("evt-2026-01-0");
      }
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("keeps corrupt/no-ts lines in the live log untouched", async () => {
    setup();
    try {
      seedLog();
      await rotateEventsLog({ now: NOW });
      const liveRaw = readFileSync(eventsFile(), "utf8");
      expect(liveRaw).toContain('"corrupt-no-ts"');
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("does nothing when every month is inside the retention window", async () => {
    setup();
    try {
      const freshNow = new Date("2026-02-25T12:00:00.000Z"); // cutoff 2025-11
      seedLog();
      const result = await rotateEventsLog({ now: freshNow });
      expect(result.rotated).toEqual([]);
      expect(result.bytesSaved).toBe(0);
      // nothing to rotate → archive dir is never even created
      expect(existsSync(path.join(process.env.TOKITOKI_DATA_DIR!, "events-archive"))).toBe(false);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});

function appendArchivedBack(ids: string[]): void {
  mkdirSync(path.dirname(eventsFile()), { recursive: true });
  const lines = ids.map((id) => {
    const month = id.slice(4, 11); // evt-YYYY-MM-* → YYYY-MM
    return JSON.stringify(makeEvent(id, `${month}-15T10:00:00Z`));
  });
  fsAppend(lines);
}

import { appendFileSync } from "node:fs";
function fsAppend(lines: string[]): void {
  appendFileSync(eventsFile(), lines.join("\n") + "\n");
}

describe("readEventsFile (.gz)", () => {
  it("transparently reads a .jsonl.gz archive path", async () => {
    setup();
    try {
      seedLog();
      await rotateEventsLog({ now: NOW });
      const file = archiveFilePath("2026-03");
      expect(file.endsWith(".jsonl.gz")).toBe(true);
      const events = readEventsFile(file);
      expect(events.map((e) => e.id).sort()).toEqual(["evt-2026-03-0", "evt-2026-03-1", "evt-2026-03-2"]);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});
