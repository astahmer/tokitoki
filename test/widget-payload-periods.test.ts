import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("widget-payload yesterday excludes today for harness, provider and model breakdowns", () => {
  const directory = mkdtempSync(join(tmpdir(), "tokitoki-periods-"));
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const events = [yesterday, today].map((date, index) => ({
      id: `period-event-${index}`,
      ts: date.toISOString(),
      machineId: "test",
      provider: "claude-code",
      accountKey: "default",
      model: "claude-sonnet",
      inputTokens: index === 0 ? 100 : 900,
      outputTokens: 0,
      costUsd: index === 0 ? 1 : 9,
      sessionId: `session-${index}`,
    }));
    writeFileSync(join(directory, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    writeFileSync(join(directory, "config.json"), "{}");
    const script = `
      const { EventCache } = await import(${JSON.stringify(new URL("../src/cache.ts", import.meta.url).pathname)});
      const cache = new EventCache();
      cache.rebuild([]);
      cache.close();
      const { main } = await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).pathname)});
      await main(["widget-payload", "--cached", "--json"]);
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { ...process.env, TOKITOKI_DATA_DIR: directory, TOKITOKI_CONFIG: join(directory, "config.json") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(result.stdout));
    for (const key of ["spendPeriods", "providerPeriods", "modelPeriods"]) {
      const period = payload[key].find((item: { key: string }) => item.key === "yesterday");
      expect(period.rows).toHaveLength(1);
      expect(period.rows[0].inputTokens).toBe(100);
      expect(period.rows[0].costUsd).toBe(1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
