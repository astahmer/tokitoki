import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nativeCodexIdentities } from "../src/accounts.ts";
import { codexHomes } from "../src/codex-homes.ts";
import { readNativeCodexAccount } from "../src/codex-rpc.ts";
import { pollQuotas } from "../src/poll.ts";
import { buildAccountLimits } from "../src/limits-document.ts";
import { hermeticPoll, nativeCodexFixture } from "./support/quota-poll.ts";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const window = (usedPercent = 12, windowDurationMins: number | null = 300) => ({ usedPercent, windowDurationMins, resetsAt: NOW / 1000 + 3600 });
const setup = () => {
  const fixture = hermeticPoll({ providers: ["codex"] });
  const server = nativeCodexFixture(fixture.dir);
  const home = (id?: string, name = id ?? "unknown") => {
    const home = path.join(fixture.dir, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { ...(id ? { account_id: id } : {}), access_token: "fixture-only" } }));
    return home;
  };
  const options = { ...fixture.options, authPath: undefined, now: NOW, codexCommand: server.command };
  return { ...fixture, server, home, options };
};

describe("native Codex quota provenance", () => {
  it("uses native account identity, plan, email, and a metadata-only handshake", async () => {
    const f = setup();
    try {
      const home = f.home("personal");
      const before = readFileSync(path.join(home, "auth.json"), "utf8");
      f.server.update({ limits: { accountId: "personal", rateLimits: { primary: window(), secondary: window(40, 10080) } } });
      const calls = { fetcher: Object.assign(async () => { throw new Error("HTTP forbidden"); }, { preconnect() {} }) as typeof fetch };
      const result = await pollQuotas({ ...f.options, ...calls, codexHomes: [home] });
      expect(result.ok).toBe(true);
      expect(result.accounts[0]).toMatchObject({ accountKey: "openai:personal", accountId: "personal", email: "native@example.com", planType: "plus", inserted: 2 });
      expect(f.cache.quotaAccountMeta("codex", "openai:personal")).toMatchObject({ plan: "plus", codexHome: home });
      expect(f.server.requests().map(r => r.method)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
      expect(f.server.requests()[2]?.params).toEqual({ refreshToken: true });
      expect(readFileSync(path.join(home, "auth.json"), "utf8")).toBe(before);
      const rows = f.cache.database.query("SELECT event_id AS id FROM quota_snapshots").all() as Array<{id:string}>;
      expect(rows.every(row => row.id.startsWith("poll:"))).toBe(true);
    } finally { f.cache.close(); }
  });

  it("preserves independent meters, actual monthly/custom durations, and unknown window fields", async () => {
    const f = setup();
    try {
      f.server.update({ limits: { rateLimits: { limitId: "codex", primary: window(130, 44640), secondary: null }, rateLimitsByLimitId: {
        codex: { primary: window(130, 44640), secondary: null },
        "code-review": { limitName: "Review", primary: window(20, 91), secondary: null },
        model: { primary: { usedPercent: 15 }, secondary: null },
      } } });
      const result = await pollQuotas({ ...f.options, codexHomes: [f.home("personal")] });
      expect(result.accounts[0]?.windows.map(w => [w.bucketId, w.windowMinutes, w.scope, w.usedPct])).toEqual([
        ["codex", 44640, "monthly", 100], ["code-review", 91, "other", 20], ["model", 0, "other", 15],
      ]);
      expect(result.accounts[0]?.windows[2]?.resetsAtEpoch).toBe(0);
      expect(result.accounts[0]?.windows.every(w => w.observedAt === new Date(NOW).toISOString())).toBe(true);
    } finally { f.cache.close(); }
  });

  it("keeps banked reset inventory separate from workspace credit amount", async () => {
    const f = setup();
    try {
      f.server.update({ limits: { rateLimits: { primary: window(), secondary: null, credits: { hasCredits: true, unlimited: false, balance: "123.45" } },
        rateLimitResetCredits: { availableCount: 7, credits: [
          { status: "redeemed", expiresAt: NOW / 1000 + 1 },
          { status: "available", expiresAt: NOW / 1000 + 200 },
          { status: "available", expiresAt: NOW / 1000 + 100 },
        ] } } });
      const result = await pollQuotas({ ...f.options, codexHomes: [f.home("work")] });
      expect(result.accounts[0]?.credits?.balance).toBe("123.45");
      expect(result.accounts[0]?.bankedResets).toBe(7);
      expect(result.accounts[0]?.bankedExpiresAt).toBe(new Date(NOW + 100_000).toISOString());
      expect(f.cache.quotaAccountMeta("codex", "openai:work")).toMatchObject({ bankedResets: 7 });
      f.server.update({ limits: { rateLimits: { primary: window(), secondary: null }, rateLimitResetCredits: { availableCount: 0, credits: [] } } });
      await pollQuotas({ ...f.options, now: NOW + 1000, codexHomes: [path.join(f.dir, "work")] });
      expect(f.cache.quotaAccountMeta("codex", "openai:work")).toMatchObject({ bankedResets: 0 });
      expect(f.cache.quotaAccountMeta("codex", "openai:work")?.bankedExpiresAt).toBeUndefined();
    } finally { f.cache.close(); }
  });

  it("polls separate native homes, dedupes proven identities, and lets the native home own refresh", async () => {
    const f = setup();
    try {
      const personal = f.home("personal"), work = f.home("work"), duplicate = f.home("personal", "duplicate");
      f.server.update({ byHome: {
        [personal]: { limits: { accountId: "personal", rateLimits: { primary: window(), secondary: null } } },
        [work]: { rotate: { tokens: { account_id: "work", access_token: "native-rotated-fixture" } }, limits: { accountId: "work", rateLimits: { primary: window(65), secondary: null } } },
      } });
      const before = readFileSync(path.join(personal, "auth.json"), "utf8");
      const result = await pollQuotas({ ...f.options, codexHomes: [personal, work, duplicate, work] });
      expect(result.accounts.map(a => a.accountId)).toEqual(["personal", "work"]);
      expect(f.server.requests().filter(r => r.method === "account/read").map(r => r.home)).toEqual([personal, work]);
      expect(readFileSync(path.join(personal, "auth.json"), "utf8")).toBe(before);
      expect(JSON.parse(readFileSync(path.join(work, "auth.json"), "utf8")).tokens.access_token).toBe("native-rotated-fixture");
    } finally { f.cache.close(); }
  });

  it("uses backend account ids for keychain homes and never joins unknown identity by email", async () => {
    const f = setup();
    try {
      const unknown = f.home();
      unlinkSync(path.join(unknown, "auth.json"));
      f.server.update({ limits: { accountId: "keychain-id", rateLimits: { primary: window(), secondary: null } } });
      expect((await pollQuotas({ ...f.options, codexHomes: [unknown] })).accounts[0]?.accountId).toBe("keychain-id");
      f.server.update({ limits: { rateLimits: { primary: window(), secondary: null } } });
      expect((await pollQuotas({ ...f.options, now: NOW + 1000, codexHomes: [unknown] })).reason).toContain("identity unavailable");
      f.server.update({ limits: { accountId: "other", rateLimits: { primary: window(), secondary: null } } });
      expect((await pollQuotas({ ...f.options, codexHomes: [f.home("personal")] })).reason).toContain("identity does not match");
    } finally { f.cache.close(); }
  });

  it("attributes keyring home failures to the last verified account without crossing native logins", async () => {
    const f = setup();
    try {
      const work = f.home(undefined, "keyring"), personal = f.home("personal");
      unlinkSync(path.join(work, "auth.json"));
      const good = { limits: { accountId: "work", rateLimits: { primary: window(), secondary: null } } };
      const own = { limits: { accountId: "personal", rateLimits: { primary: window(20), secondary: null } } };
      f.server.update({ byHome: { [work]: good, [personal]: own } });
      await pollQuotas({ ...f.options, codexHomes: [work, personal] });
      f.server.update({ byHome: { [work]: { accountError: { code: -1, message: "401 unauthorized" } }, [personal]: own } });
      await pollQuotas({ ...f.options, now: NOW + 1000, codexHomes: [work, personal] });
      expect(f.cache.metaValue("quota-poll-error:codex@work")).toContain("authentication required");
      expect(f.cache.metaValue("quota-poll-error:codex")).toBeUndefined();
      const cards = buildAccountLimits({ cache: f.cache, config: {}, now: new Date(NOW + 1000) });
      expect(cards.find(card => card.accountId === "work")?.windows[0]?.status).toBe("unknown");
      expect(cards.find(card => card.accountId === "personal")?.windows[0]?.status).toBe("current");
      f.server.update({ byHome: { [work]: good } });
      await pollQuotas({ ...f.options, now: NOW + 2000, codexHomes: [work] });
      expect(f.cache.metaValue("quota-poll-error:codex@work")).toBeUndefined();
      // A locally changed login overrides the historical keyring association.
      writeFileSync(path.join(work, "auth.json"), JSON.stringify({ tokens: { account_id: "changed" } }));
      f.server.update({ error: { code: -1, message: "401 unauthorized" } });
      await pollQuotas({ ...f.options, now: NOW + 3000, codexHomes: [work] });
      expect(f.cache.metaValue("quota-poll-error:codex@changed")).toContain("authentication required");
      expect(f.cache.metaValue("quota-poll-error:codex@work")).toBeUndefined();
      expect(f.cache.quotaAccountMeta("codex", "openai:work")?.codexHome).toBeUndefined();
    } finally { f.cache.close(); }
  });

  it("clears obsolete home bindings after keyring account switches and confirmed logout", async () => {
    const f = setup();
    try {
      const home = f.home(undefined, "keyring");
      unlinkSync(path.join(home, "auth.json"));
      for (const [index, accountId] of ["old", "new"].entries()) {
        f.server.update({ limits: { accountId, rateLimits: { primary: window(), secondary: null } } });
        await pollQuotas({ ...f.options, now: NOW + index * 1000, codexHomes: [home] });
      }
      expect(f.cache.quotaAccountMeta("codex", "openai:old")?.codexHome).toBeUndefined();
      expect(f.cache.quotaAccountMeta("codex", "openai:new")?.codexHome).toBe(home);
      f.server.update({ account: { account: null, requiresOpenaiAuth: true } });
      await pollQuotas({ ...f.options, now: NOW + 2000, codexHomes: [home] });
      expect(f.cache.metaValue("quota-poll-error:codex@new")).toContain("not logged in");
      expect(f.cache.quotaAccountMeta("codex", "openai:new")?.codexHome).toBeUndefined();
      expect(f.cache.quotaAccountMeta("codex", "openai:new")?.reauthHome).toBe(home);
      expect(buildAccountLimits({ cache: f.cache, config: {}, now: new Date(NOW + 2000) }).find(card => card.accountId === "new")?.codexHome).toBe(home);
    } finally { f.cache.close(); }
  });

  it("retires explicitly null slots in sparse responses while omitted slots stay unknown", async () => {
    const f = setup();
    try {
      const home = f.home("personal");
      f.server.update({ limits: { rateLimits: { primary: window(), secondary: window(20, 10080) } } });
      await pollQuotas({ ...f.options, codexHomes: [home] });
      f.server.update({ limits: { rateLimits: { primary: null } } });
      await pollQuotas({ ...f.options, now: NOW + 1000, codexHomes: [home] });
      expect(f.cache.latestQuotaSnapshots("codex", "openai:personal").map(row => row.windowId)).toEqual(["secondary"]);
      const card = buildAccountLimits({ cache: f.cache, config: {}, now: new Date(NOW + 1000) }).find(card => card.accountId === "personal");
      expect(card?.windows).toHaveLength(1);
      expect(card?.windows[0]).toMatchObject({ windowId: "secondary", status: "unknown" });
      expect(card?.windows[0]?.usedPct).toBeUndefined();
    } finally { f.cache.close(); }
  });

  it("persists workspace credit metadata on empty quota topology, including unlimited and unknown balances", async () => {
    const f = setup();
    try {
      const home = f.home("personal");
      const variants = [
        { hasCredits: true, unlimited: false, balance: "123.45" },
        { hasCredits: true, unlimited: true, balance: null },
        { hasCredits: true, unlimited: false, balance: "unknown" },
        { hasCredits: false, unlimited: false, balance: "0" },
      ];
      for (const [index, credits] of variants.entries()) {
        f.server.update({ limits: { rateLimits: { primary: null, secondary: null, credits } } });
        const result = await pollQuotas({ ...f.options, now: NOW + index * 1000, codexHomes: [home] });
        expect(result.accounts[0]?.windows).toEqual([]);
        const meta = f.cache.quotaAccountMeta("codex", "openai:personal");
        expect(meta?.credits).toEqual(credits);
        expect(meta?.bankedResets).toBeUndefined();
        if (index === 0) {
          expect(meta?.balance).toEqual({ currency: "credits", remaining: 123.45, available: true });
          expect(result.accounts[0]?.balance).toEqual(meta?.balance);
        } else expect(meta?.balance).toBeUndefined();
      }
    } finally { f.cache.close(); }
  });

  it("restricts explicit auth fixtures to their home and never launches for missing fixtures", async () => {
    const f = setup();
    try {
      const home = f.home("personal");
      await pollQuotas({ ...f.options, authPath: path.join(home, "auth.json"), codexHomes: [f.home("work")] });
      expect(new Set(f.server.requests().map(r => r.home))).toEqual(new Set([home]));
      const count = f.server.requests().length;
      const result = await pollQuotas({ ...f.options, authPath: path.join(f.dir, "missing.json") });
      expect(result.reason).toContain("not logged in");
      expect(f.server.requests()).toHaveLength(count);
    } finally { f.cache.close(); }
  });

  it("preserves sparse observations, retires explicit empty topology, and records auth/error state", async () => {
    const f = setup();
    try {
      const home = f.home("personal");
      const bodies = [
        { primary: window(), secondary: window(20, 10080) },
        { primary: window(15) },
        { primary: window(30, 43200), secondary: null },
        { primary: null, secondary: null },
      ];
      const lengths = [];
      for (const [index, rateLimits] of bodies.entries()) {
        f.server.update({ limits: { rateLimits } });
        await pollQuotas({ ...f.options, now: NOW + index * 1000, codexHomes: [home] });
        lengths.push(f.cache.latestQuotaSnapshots("codex", "openai:personal").length);
      }
      expect(lengths).toEqual([2, 2, 1, 0]);
      f.server.update({ error: { code: -1, message: "401 secret fixture-token" } });
      const failure = await pollQuotas({ ...f.options, now: NOW + 5000, codexHomes: [home] });
      expect(failure.providerAuthStates?.codex).toBe("login-required");
      expect(failure.reason).not.toContain("fixture-token");
      expect(f.cache.metaValue("quota-poll-error:codex@personal")).toContain("authentication required");
    } finally { f.cache.close(); }
  });

  it("coalesces concurrent callers into one native read", async () => {
    const f = setup();
    try {
      const options = { ...f.options, codexHomes: [f.home("personal")] };
      const [one, two] = await Promise.all([pollQuotas(options), pollQuotas(options)]);
      expect(one).toEqual(two);
      expect(f.server.requests().filter(r => r.method === "account/read")).toHaveLength(1);
    } finally { f.cache.close(); }
  });

  it("isolates temporary caches from production locks and concurrent unrelated polls", async () => {
    const one = setup(), two = setup();
    const previous = process.env.TOKITOKI_POLL_LOCK;
    const productionLock = path.join(one.dir, "desktop-poll.lock");
    writeFileSync(productionLock, JSON.stringify({ pid: process.pid }));
    process.env.TOKITOKI_POLL_LOCK = productionLock;
    try {
      const [personal, work] = await Promise.all([
        pollQuotas({ ...one.options, codexHomes: [one.home("personal")] }),
        pollQuotas({ ...two.options, codexHomes: [two.home("work")] }),
      ]);
      expect(personal.accounts[0]?.accountId).toBe("personal");
      expect(work.accounts[0]?.accountId).toBe("work");
      expect(readFileSync(productionLock, "utf8")).toContain(String(process.pid));
    } finally {
      one.cache.close(); two.cache.close();
      if (previous === undefined) delete process.env.TOKITOKI_POLL_LOCK;
      else process.env.TOKITOKI_POLL_LOCK = previous;
    }
  });

  it("handles missing logins and API-key accounts without asking for subscription usage", async () => {
    const f = setup();
    try {
      const home = f.home("personal");
      for (const account of [null, { type: "apiKey" }, { type: "amazonBedrock" }]) {
        f.server.update({ account: { account, requiresOpenaiAuth: true } });
        const result = await pollQuotas({ ...f.options, codexHomes: [home] });
        expect(result.ok).toBe(false);
        expect(f.server.requests().filter(r => r.method === "account/rateLimits/read")).toHaveLength(0);
      }
    } finally { f.cache.close(); }
  });

  it("discovers only native homes and known sessions roots, with stable account identity exports", () => {
    const f = setup();
    try {
      const home = f.home("work");
      const config = { poll: { codexHomes: [home, home] }, providers: { codex: { paths: ["/scan/sessions", "/arbitrary/logs"] } } };
      expect(codexHomes({ config, env: { HOME: "/fixture", CODEX_HOME: "/native" } })).toEqual(["/native", home, "/scan"]);
      expect(nativeCodexIdentities({ config }).get("work")).toEqual({ accountId: "work" });
    } finally { f.cache.close(); }
  });

  it("handles split UTF-8 and bounds malformed, oversized, stuck, early-exit and external-request servers", async () => {
    const f = setup();
    try {
      const home = f.home("personal");
      f.server.update({ mode: "utf8", account: { account: { type: "chatgpt", email: "é@example.com", planType: "plus" }, requiresOpenaiAuth: true } });
      const result = await readNativeCodexAccount({ home, command: f.server.command, timeoutMs: 3000 });
      expect(result.account.account?.type === "chatgpt" && result.account.account.email).toBe("é@example.com");
      await expect(readNativeCodexAccount({ home, command: [path.join(f.dir, "nonexistent-command")] })).rejects.toThrow("could not start");
      for (const error of [{ code: -1, message: { toString: null } }, { code: "bad", message: "401 secret" }, null, []]) {
        f.server.update({ error });
        await expect(readNativeCodexAccount({ home, command: f.server.command })).rejects.toThrow("invalid RPC error metadata");
      }
      for (const mode of ["null", "overflow", "hang", "exit", "external"]) {
        f.server.update({ mode });
        await expect(readNativeCodexAccount({ home, command: f.server.command, timeoutMs: 150, maxOutputBytes: 1024 })).rejects.toThrow(/native Codex/);
        const pid = f.server.requests().at(-1)?.pid;
        if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally { f.cache.close(); }
  });
});
