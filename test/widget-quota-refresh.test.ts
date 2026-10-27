import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeUsage } from "../src/poll.ts";
import { nativeCodexFixture } from "./support/quota-poll.ts";

it("distinguishes missing Claude usage from explicit empty quota windows", () => {
  expect(parseClaudeUsage({})).toBeUndefined();
  expect(parseClaudeUsage({ extra_usage: { is_enabled: false } })).toBeUndefined();
  expect(parseClaudeUsage({ five_hour: {} })).toBeUndefined();
  expect(parseClaudeUsage({ five_hour: null, seven_day: null })).toEqual({ windows: [] });
  expect(parseClaudeUsage({ five_hour: { utilization: 0 } })?.windows[0]?.usedPct).toBe(0);
});

it("CLI quota refresh preserves failed observations, honors cadence, and accepts verified empty topology", () => {
  const directory = mkdtempSync(join(tmpdir(), "tokitoki-widget-quota-"));
  const server = nativeCodexFixture(directory);
  try {
    mkdirSync(join(directory, ".codex"));
    writeFileSync(join(directory, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "fixture", account_id: "fixture-account" } }));
    writeFileSync(join(directory, "config.json"), JSON.stringify({
      poll: { enabled: true, intervalMinutes: 60 },
      statusIncidents: { enabled: false }, experimental: { zeroStateCards: false },
    }));
    const script = `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync } from "node:fs";
      const { main } = await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).pathname)});
      const { EventCache } = await import(${JSON.stringify(new URL("../src/cache.ts", import.meta.url).pathname)});
      let used = 33;
      let secondaryExpired = true;
      let status = 200;
      let body;
      const usage = () => ({ accountId: "fixture-account", rateLimits: {
        primary: { usedPercent: used, resetsAt: Math.floor(Date.now()/1000) + 18000, windowDurationMins: 300 },
        secondary: { usedPercent: 71, resetsAt: Math.floor(Date.now()/1000) + (secondaryExpired ? -60 : 86400), windowDurationMins: 10080 },
      } });
      globalThis.fetch = async (url) => { throw new Error("unexpected fixture request: " + url); };
      const syncNative = () => writeFileSync(${JSON.stringify(server.scenarioPath)}, JSON.stringify(status === 200
        ? { limits: body ?? usage() } : { error: { code: status, message: "HTTP " + status } }));
      const countCalls = () => {
        try { return readFileSync(${JSON.stringify(server.logPath)}, "utf8").split("\\n").filter(line => line.includes('"method":"account/rateLimits/read"')).length; }
        catch { return 0; }
      };
      const run = async (args) => {
        const lines = [];
        const original = console.log;
        const originalWrite = process.stdout.write;
        console.log = (...values) => lines.push(values.join(" "));
        process.stdout.write = (chunk, callback) => { lines.push(String(chunk).trim()); callback?.(); return true; };
        try { await main(args); } finally {
          console.log = original;
          process.stdout.write = originalWrite;
          process.exitCode = 0;
        }
        assert.equal(lines.length, 1);
        return JSON.parse(lines[0]);
      };
      const poll = () => { syncNative(); return run(["poll", "--provider", "codex", "--json"]); };
      const payload = (cached) => { syncNative(); return run(["widget-payload", cached ? "--cached" : "--skip-scan", "--json"]); };
      const card = (value) => value.limits.find(account => account.accountId === "fixture-account");
      assert.equal((await poll()).ok, true);
      let first = card(await payload(true));
      assert.equal(first.windows.find(w => w.windowId === "primary").usedPct, 33);
      const expired = first.windows.find(w => w.windowId === "secondary");
      assert.equal(expired.status, "expired");
      assert.equal(expired.usedPct, undefined);
      assert.equal(countCalls(), 1);
      used = 44;
      first = card(await payload(false));
      assert.equal(first.windows.find(w => w.windowId === "primary").usedPct, 44);
      assert.equal(countCalls(), 2);
      await payload(false);
      assert.equal(countCalls(), 2, "live widget must honor polling cadence");
      for (const failure of [{ body: {}, status: 200 }, { body: { rateLimits: null }, status: 200 },
        { body: { rateLimitsByLimitId: {} }, status: 200 },
        { body: { rateLimits: { primary: {} } }, status: 200 }, { body: {}, status: 401 }]) {
        await new Promise(resolve => setTimeout(resolve, 3));
        body = failure.body; status = failure.status;
        assert.equal((await poll()).ok, false);
        const failed = card(await payload(true));
        assert.equal(failed.windows.length, 2);
        assert.equal(failed.windows.find(w => w.windowId === "primary").status, "unknown");
        assert.equal(failed.windows.find(w => w.windowId === "primary").usedPct, undefined);
        assert.ok(failed.refreshError);
        assert.equal(failed.windows.find(w => w.windowId === "secondary").status, "expired");
      }
      body = undefined; status = 200; secondaryExpired = false;
      await new Promise(resolve => setTimeout(resolve, 3));
      assert.equal((await poll()).ok, true);
      assert.equal(card(await payload(true)).windows.find(w => w.windowId === "primary").usedPct, 44);
      body = { rateLimits: { primary: { usedPercent: 45 } } };
      await new Promise(resolve => setTimeout(resolve, 3));
      assert.equal((await poll()).ok, true);
      const partial = card(await payload(true));
      assert.equal(partial.windows.length, 2);
      assert.equal(partial.windows.find(w => w.windowId === "primary").usedPct, 45);
      assert.equal(partial.windows.find(w => w.windowId === "secondary").status, "unknown");
      assert.equal(partial.windows.find(w => w.windowId === "secondary").usedPct, undefined);
      body = undefined;
      await new Promise(resolve => setTimeout(resolve, 3));
      assert.equal((await poll()).ok, true);
      const ttlCache = new EventCache();
      assert.equal(ttlCache.metaValue("quota-poll-error:codex@fixture-account"), undefined);
      assert.throws(() => ttlCache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:fixture-account",
        accountId: "fixture-account", capturedAtIso: new Date().toISOString(), eventId: "poll:invalid",
        windows: [{ windowMinutes: 300, usedPct: NaN, resetsAtEpoch: 0 }] }));
      const observedAt = new Date(Date.now() - 90 * 60000).toISOString();
      ttlCache.database.query("UPDATE quota_snapshots SET observed_at = ?").run(observedAt);
      ttlCache.close();
      assert.equal(card(await payload(true)).windows.find(w => w.windowId === "primary").status, "current");
      writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify({ poll: { enabled: true, intervalMinutes: 5 }, statusIncidents: { enabled: false } }));
      const stale = card(await payload(true)).windows.find(w => w.windowId === "primary");
      assert.equal(stale.status, "stale");
      assert.equal(stale.usedPct, undefined);
      assert.equal(stale.observedAt, observedAt);
      body = { rateLimits: { primary: null, secondary: null } };
      assert.equal((await poll()).ok, true);
      assert.deepEqual(card(await payload(true)).windows, []);
      assert.deepEqual(card(await payload(false)).windows, []);
      const cache = new EventCache();
      assert.deepEqual(cache.latestQuotaSnapshots("codex", "openai:fixture-account"), []);
      cache.close();
      for (const provider of ["openrouter", "opencode-go"]) {
        const keyA = { id: provider + "-A", provider, key: "fixture-key-" + provider + "-A" };
        const keyB = { id: provider + "-B", provider, key: "fixture-key-" + provider + "-B" };
        const config = (keys) => writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify({
          poll: { enabled: false, extraKeys: keys }, statusIncidents: { enabled: false }, experimental: { zeroStateCards: false },
        }));
        let rejected = false;
        globalThis.fetch = async (url, init) => {
          const request = String(url);
          assert.ok(request.startsWith("https://openrouter.ai/api/v1/") || request === "https://opencode.ai/zen/go/v1/usage", "unexpected request: " + request);
          const key = new Headers(init?.headers).get("authorization");
          if (rejected && key === "Bearer " + keyB.key) return Response.json({}, { status: 401 });
          if (request.endsWith("/credits")) return Response.json({ data: { total_credits: 100, total_usage: 40 } });
          if (provider === "opencode-go") return Response.json({ usage: { weekly: { percent: 40, resetsAt: new Date(Date.now() + 86400000).toISOString() } } });
          return Response.json({ data: { limit: 100, limit_remaining: 60, limit_reset: "weekly" } });
        };
        const pollKeys = () => run(["poll", "--provider", provider, "--json"]);
        const find = (value, key) => value.limits.find(account => account.accountKey === key.id);
        config([keyB, keyA]);
        assert.equal((await pollKeys()).ok, true);
        await new Promise(resolve => setTimeout(resolve, 3));
        rejected = true;
        assert.equal((await pollKeys()).ok, true);
        const failed = await payload(true);
        assert.equal(find(failed, keyA).windows[0].status, "current");
        assert.equal(find(failed, keyB).windows[0].status, "unknown");
        assert.equal(find(failed, keyB).windows[0].usedPct, undefined);
        assert.match(find(failed, keyB).refreshError, /401/);
        config([keyA]);
        await pollKeys();
        assert.equal(find(await payload(true), keyB).windows[0].status, "unknown");
        const errors = new EventCache();
        const persistedProviders = provider === "openrouter" ? ["openrouter"] : ["pi", "opencode"];
        for (const persisted of persistedProviders) {
          assert.ok(errors.metaValue("quota-poll-error:" + persisted + "@" + keyB.id));
          assert.equal(errors.metaValue("quota-poll-error:" + persisted + "@" + keyA.id), undefined);
        }
        errors.close();
        config([keyB, keyA]);
        rejected = false;
        await new Promise(resolve => setTimeout(resolve, 3));
        assert.equal((await pollKeys()).ok, true);
        const recovered = find(await payload(true), keyB);
        assert.equal(recovered.windows[0].status, "current");
        assert.equal(recovered.refreshError, undefined);
      }
      console.log("fixture checks passed");
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { ...process.env, PATH: directory + ":" + process.env.PATH, HOME: directory, CODEX_HOME: join(directory, ".codex"),
        XDG_CONFIG_HOME: join(directory, ".config"), XDG_DATA_HOME: join(directory, ".local/share"),
        TOKITOKI_DATA_DIR: directory, TOKITOKI_CONFIG: join(directory, "config.json"),
        DEEPSEEK_API_KEY: "", ZAI_API_KEY: "", KIMI_API_KEY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).not.toContain("AssertionError");
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("fixture checks passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
