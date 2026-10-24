import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import { codexProvider } from "../src/providers/codex.ts";
import { EXTRACTION_VERSION, extractionVersionFor, scanProvider, scanProviderCore } from "../src/scan.ts";
import { eventsFile, loadProviderCursors, saveProviderCursors } from "../src/store.ts";
import type { QuotaObservationEvent } from "../src/types.ts";

const fixture = (): string => [
  { type: "session_meta", payload: { session_id: "fixture", model_provider: "openai", account_id: "login-a" } },
  ...[null, undefined, { last_token_usage: { input_tokens: 0, output_tokens: 0 } }, {},
    { last_token_usage: { input_tokens: 10, output_tokens: 5 } }].map((info, index) => ({
    type: "event_msg",
    timestamp: `2026-10-24T10:00:0${index}.000Z`,
    payload: {
      type: "token_count", info,
      rate_limits: {
        limit_id: "meter-a", primary: { used_percent: index + 10, window_minutes: 300, resets_at: 1800000000 },
        secondary: null,
      },
    },
  })),
].map((line) => JSON.stringify(line)).join("\n") + "\n";

const setup = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tk-codex-scan-"));
  const file = path.join(directory, "rollout-fixture.jsonl");
  writeFileSync(file, fixture());
  return { directory, file, provider: { ...codexProvider, discoverRoots: () => [file] } };
};

describe("Codex quota scanner sink", () => {
  it("persists quota-only files with no usage log or request rows", () => {
    const env = setup();
    const previous = process.env.TOKITOKI_DATA_DIR;
    process.env.TOKITOKI_DATA_DIR = path.join(env.directory, "data");
    writeFileSync(env.file, fixture().trimEnd().split("\n").slice(0, -1).join("\n") + "\n");
    try {
      expect(scanProvider(env.provider, "test").eventsEmitted).toBe(0);
      expect(existsSync(eventsFile())).toBe(false);
      const cache = new EventCache();
      try {
        cache.sync([]);
        expect(cache.latestQuotaSnapshots("codex", "account:login-a")).toHaveLength(1);
        expect(cache.database.query("SELECT COUNT(*) AS n FROM quota_observations").get()).toEqual({ n: 4 });
        expect(cache.database.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
        expect(cache.database.query("SELECT COUNT(*) AS n FROM daily_rollups").get()).toEqual({ n: 0 });
      } finally {
        cache.close();
      }
    } finally {
      if (previous === undefined) delete process.env.TOKITOKI_DATA_DIR;
      else process.env.TOKITOKI_DATA_DIR = previous;
      rmSync(env.directory, { recursive: true, force: true });
    }
  });

  it("streams quota-only observations before cursor saves without adding usage requests", () => {
    const env = setup();
    const previous = process.env.TOKITOKI_DATA_DIR;
    process.env.TOKITOKI_DATA_DIR = env.directory;
    try {
      const quotas: QuotaObservationEvent[] = [];
      const result = scanProviderCore(env.provider, "test", {
        onQuotas: (batch) => quotas.push(...batch),
        onSaveCursors: () => expect(quotas).toHaveLength(5),
      });
      expect(result.eventsEmitted).toBe(1);
      expect(quotas.map((report) => report.id)).toEqual(
        [1, 2, 3, 4, 5].map((line) => `codex:meter-a:fixture:line-${line}`),
      );
      expect(quotas.every((report) => report.quota.accountId === "login-a")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TOKITOKI_DATA_DIR;
      else process.env.TOKITOKI_DATA_DIR = previous;
      rmSync(env.directory, { recursive: true, force: true });
    }
  });

  it("persists standalone scan quotas and replays only Codex without double counting", () => {
    const env = setup();
    const previous = process.env.TOKITOKI_DATA_DIR;
    process.env.TOKITOKI_DATA_DIR = env.directory;
    try {
      expect(scanProvider(env.provider, "test").eventsEmitted).toBe(1);
      const cache = new EventCache();
      try {
        cache.sync([]);
        expect(cache.latestQuotaSnapshots("codex", "account:login-a")).toHaveLength(1);
        expect(cache.database.query("SELECT COUNT(*) AS n FROM quota_observations").get()).toEqual({ n: 5 });
        expect(cache.database.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
        const cursors = loadProviderCursors("codex");
        const cursor = cursors[env.file]!;
        cursor.state = { ...cursor.state, extractionVersion: EXTRACTION_VERSION };
        saveProviderCursors("codex", cursors);
        expect(scanProvider(env.provider, "test").eventsEmitted).toBe(1);
        cache.sync([]);
        expect(cache.database.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
        expect(cache.database.query("SELECT SUM(requests) AS n FROM daily_rollups").get()).toEqual({ n: 1 });
        expect(cache.database.query("SELECT COUNT(*) AS n FROM quota_observations").get()).toEqual({ n: 5 });
        const lines = readFileSync(eventsFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(lines).toHaveLength(2);
        expect(lines[0].id).toBe(lines[1].id);
        expect(extractionVersionFor("codex")).toBeGreaterThan(EXTRACTION_VERSION);
        expect(extractionVersionFor("claude-code")).toBe(EXTRACTION_VERSION);
      } finally {
        cache.close();
      }
    } finally {
      if (previous === undefined) delete process.env.TOKITOKI_DATA_DIR;
      else process.env.TOKITOKI_DATA_DIR = previous;
      rmSync(env.directory, { recursive: true, force: true });
    }
  });

  it("persists worker quota batches through the scan CLI and leaves request counts unchanged", () => {
    const env = setup();
    try {
      const configFile = path.join(env.directory, "config.json");
      writeFileSync(configFile, JSON.stringify({ providers: { codex: { paths: [env.file] } } }));
      const script = `
        const { main } = await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).pathname)});
        await main(["scan", "--provider", "codex", "--if-needed"]);
      `;
      const run = () => Bun.spawnSync([process.execPath, "--eval", script], {
        env: { ...process.env, TOKITOKI_DATA_DIR: env.directory, TOKITOKI_CONFIG: configFile },
        stdout: "pipe", stderr: "pipe",
      });
      const first = run();
      expect(new TextDecoder().decode(first.stderr)).not.toContain("error:");
      expect(first.exitCode).toBe(0);
      expect(new TextDecoder().decode(first.stdout)).toContain("+1 events");
      const second = run();
      expect(second.exitCode).toBe(0);
      expect(new TextDecoder().decode(second.stdout)).toContain("already initialized");
      const cursorFile = path.join(env.directory, "cursors", "codex.json");
      const cursors = JSON.parse(readFileSync(cursorFile, "utf8"));
      cursors[env.file].state.extractionVersion = EXTRACTION_VERSION;
      writeFileSync(cursorFile, JSON.stringify(cursors));
      const replay = run();
      expect(replay.exitCode).toBe(0);
      expect(new TextDecoder().decode(replay.stdout)).toContain("+1 events");
      const cache = new EventCache(path.join(env.directory, "cache.db"));
      try {
        expect(cache.database.query("SELECT COUNT(*) AS n FROM quota_observations").get()).toEqual({ n: 5 });
        expect(cache.database.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
        expect(cache.database.query("SELECT SUM(requests) AS n FROM daily_rollups").get()).toEqual({ n: 1 });
      } finally {
        cache.close();
      }
    } finally {
      rmSync(env.directory, { recursive: true, force: true });
    }
  }, 20000);
});
