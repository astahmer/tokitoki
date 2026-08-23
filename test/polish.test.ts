import { describe, expect, it } from "bun:test";

import { starterMonthlyCap, seedBudgetsConfig, type DetectedAccount } from "../src/budgets.ts";
import { presenceState, readPresence, writeHeartbeat } from "../src/presence.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("starterMonthlyCap", () => {
  it("maps subscription providers to $200", () => {
    expect(starterMonthlyCap("codex")).toBe(200);
    expect(starterMonthlyCap("claude-code")).toBe(200);
  });
  it("defaults others to $50", () => {
    expect(starterMonthlyCap("pi")).toBe(50);
    expect(starterMonthlyCap("opencode")).toBe(50);
  });
});

describe("seedBudgetsConfig", () => {
  const accounts: DetectedAccount[] = [
    { provider: "codex", accountKey: "openai:plus", events: 100 },
    { provider: "pi", accountKey: "opencode-go", events: 50 },
  ];
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "toki-seed-"));

  it("creates a toml config with caps + global sum", () => {
    const dir = tmp();
    const file = path.join(dir, "config.toml");
    const res = seedBudgetsConfig(accounts, { configPath: file });
    expect(res.added.length).toBe(2);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain('[budgets.accounts."openai:plus"]');
    expect(text).toContain("monthly = 200");
    expect(text).toContain("monthly = 50");
    // global cap = sum of account caps
    expect(text).toContain("monthly = 250");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips already-configured patterns without force", () => {
    const dir = tmp();
    const file = path.join(dir, "config.toml");
    seedBudgetsConfig(accounts, { configPath: file });
    const second = seedBudgetsConfig(accounts, { configPath: file });
    expect(second.added.length).toBe(0);
    expect(second.skipped.length).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("force replaces account entries but keeps other sections", () => {
    const dir = tmp();
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, '[sync]\nbackend = "dir"\npath = "/tmp/x"\n\n[budgets]\nmonthly = 10\n');
    seedBudgetsConfig(accounts.slice(0, 1), { configPath: file, force: true });
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain('backend = "dir"'); // untouched section preserved
    expect(text).not.toContain("monthly = 10"); // old budgets block replaced
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("presence", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  it("classifies heartbeat freshness", () => {
    expect(presenceState(now.getTime() - 5 * 60_000, now)).toBe("active");
    expect(presenceState(now.getTime() - 30 * 60_000, now)).toBe("recent");
    expect(presenceState(now.getTime() - 3 * 60 * 60_000, now)).toBe("stale");
  });

  it("writes and reads heartbeats, tolerating junk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toki-presence-"));
    writeHeartbeat(dir, "macbook-1", now);
    fs.writeFileSync(path.join(dir, "garbage.hb"), "{not json");
    const seen = readPresence(dir, now);
    expect(seen.length).toBe(1);
    expect(seen[0]!.machineId).toBe("macbook-1");
    expect(seen[0]!.state).toBe("active");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
