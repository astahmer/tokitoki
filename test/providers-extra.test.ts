import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { antigravityCliProvider } from "../src/providers/antigravity-cli.ts";
import { SKELETON_PROVIDERS } from "../src/providers/skeletons.ts";
import { grokProvider } from "../src/providers/grok.ts";
import {
  extractT3SessionDocs,
  t3CodeProvider,
  T3CODE_NO_USAGE_NOTE,
} from "../src/providers/t3code.ts";
import { renderSources, collectSources } from "../src/sources.ts";

/**
 * Modeled on ~/.t3/userdata/state.sqlite's real schema (inspected
 * 2026-09-01) — T3 Code's actual local server database, not the Electron
 * IndexedDB store an earlier version of this provider read.
 */
function tmpT3StateDbWith(
  threads: Array<{ threadId: string; title: string; createdAt: string; modelSelectionJson: string | null }>,
  messages: Array<{ messageId: string; threadId: string; role: string; text: string; createdAt: string }>,
  runtimes: Array<{ threadId: string; providerName: string; providerInstanceId: string }>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-sqlite-"));
  const dbPath = path.join(dir, "state.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
      model_selection_json TEXT, deleted_at TEXT
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY, provider_name TEXT NOT NULL, provider_instance_id TEXT
    );
  `);
  const insertThread = db.query(
    "INSERT INTO projection_threads VALUES ($id, $title, $createdAt, $modelSelectionJson, NULL)",
  );
  for (const t of threads) {
    insertThread.run({ $id: t.threadId, $title: t.title, $createdAt: t.createdAt, $modelSelectionJson: t.modelSelectionJson });
  }
  const insertMsg = db.query("INSERT INTO projection_thread_messages VALUES ($id, $threadId, $role, $text, $createdAt)");
  for (const m of messages) {
    insertMsg.run({ $id: m.messageId, $threadId: m.threadId, $role: m.role, $text: m.text, $createdAt: m.createdAt });
  }
  const insertRuntime = db.query("INSERT INTO provider_session_runtime VALUES ($threadId, $providerName, $providerInstanceId)");
  for (const r of runtimes) {
    insertRuntime.run({ $threadId: r.threadId, $providerName: r.providerName, $providerInstanceId: r.providerInstanceId });
  }
  db.close();
  return dir;
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

void (async () => {
  // --- t3code docs extraction -------------------------------------------------
  await t3codeExtraction();

  async function t3codeExtraction(): Promise<void> {
    const THREAD_A = "e34f88a5-7e25-4d56-8f68-33eae4844122";
    const THREAD_B = "0228aba2-07fc-4699-a632-d41c038b8d92";
    const THREAD_C = "c8b1c6df-1ee8-42ec-9f3f-8d53686f0fd2";
    const dir = tmpT3StateDbWith(
      [
        {
          threadId: THREAD_A,
          title: 'if it works just say "ok"',
          createdAt: "2026-08-04T16:19:17.793Z",
          modelSelectionJson: '{"instanceId":"opencode","model":"commandcode/deepseek-v4-flash"}',
        },
        {
          threadId: THREAD_B,
          title: "fix flaky test",
          createdAt: "2026-08-20T09:00:00.000Z",
          modelSelectionJson: '{"instanceId":"claudeAgent","model":"claude-sonnet-5"}',
        },
        { threadId: THREAD_C, title: "fallback thread, no model yet", createdAt: "2026-08-21T11:12:13.000Z", modelSelectionJson: null },
      ],
      [
        { messageId: "a1", threadId: THREAD_A, role: "user", text: 'if it works just say "ok"', createdAt: "2026-08-04T16:19:17.793Z" },
        { messageId: "a2", threadId: THREAD_A, role: "assistant", text: "ok", createdAt: "2026-08-04T16:19:20.000Z" },
        { messageId: "a3", threadId: THREAD_A, role: "user", text: "say ok if it works", createdAt: "2026-08-04T16:19:25.000Z" },
        { messageId: "b1", threadId: THREAD_B, role: "user", text: "make the test pass", createdAt: "2026-08-20T09:00:00.000Z" },
        {
          messageId: "b2",
          threadId: THREAD_B,
          role: "assistant",
          text: "Fixed the flaky test by adding a retry around the screenshot assertion.",
          createdAt: "2026-08-20T09:00:05.000Z",
        },
      ],
      [{ threadId: THREAD_A, providerName: "opencode", providerInstanceId: "opencode" }],
    );
    try {
      const files = t3CodeProvider.listFiles(dir);
      assert.equal(files.length, 1, "lists the state.sqlite file");

      const docs = extractT3SessionDocs(files[0]!);
      assert.equal(docs.length, 3, `all threads found, got ${docs.length}`);
      const a = docs.find((d) => d.sessionId === THREAD_A);
      const b = docs.find((d) => d.sessionId === THREAD_B);
      const c = docs.find((d) => d.sessionId === THREAD_C);
      assert.ok(a && b && c, "docs keyed by threadId");
      assert.equal(a!.title, 'if it works just say "ok"');
      assert.ok(a!.body.includes('if it works just say "ok"') && a!.body.includes("say ok if it works") && a!.body.includes("ok"));
      assert.equal(a!.accountKey, "opencode");
      assert.equal(a!.startedAt, "2026-08-04T16:19:17.793Z");
      assert.equal(b!.title, "fix flaky test");
      assert.equal(b!.accountKey, "claudeAgent");
      // No runtime row and no model_selection_json yet → falls back to "default".
      assert.equal(c!.accountKey, "default");

      // parseLine never emits — usage comes from scanDb instead.
      const events = t3CodeProvider.parseLine("{}", {
        path: files[0]!,
        state: {},
        freshFile: true,
        machineId: "test",
      });
      assert.deepEqual(events, []);
      assert.equal(t3CodeProvider.usageNote, T3CODE_NO_USAGE_NOTE);

      // scanDb estimates usage from both sides of each turn (real user AND
      // assistant text, unlike the old IndexedDB-based extraction) — one
      // event per assistant reply, paired with its preceding user message.
      const dbCtx = { state: {}, freshFile: true, machineId: "test" };
      const usageEvents = t3CodeProvider.scanDb!(files[0]!, dbCtx);
      assert.equal(usageEvents.length, 2, "one estimated event per assistant reply across threads A+B");
      for (const e of usageEvents) {
        assert.ok(e.inputTokens > 0, "estimated input tokens from the paired user message");
        assert.ok(e.outputTokens > 0, "estimated output tokens from real assistant text");
        assert.equal(e.provider, "t3code");
      }
      const aEvent = usageEvents.find((e) => e.sessionId === THREAD_A);
      assert.ok(aEvent);
      assert.equal(aEvent!.accountKey, "opencode");
      assert.equal(aEvent!.model, "commandcode/deepseek-v4-flash");
      const bEvent = usageEvents.find((e) => e.sessionId === THREAD_B);
      assert.ok(bEvent);
      assert.equal(bEvent!.accountKey, "claudeAgent");

      // Rowid watermark: no new rows since last scan → no re-emission.
      assert.deepEqual(t3CodeProvider.scanDb!(files[0]!, dbCtx), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- sources note rendering ---------------------------------------------------
  {
    const fake = { ...t3CodeProvider, discoverRoots: () => [], listFiles: () => [] };
    const rendered = renderSources(collectSources({ providerStats: () => new Map() } as never, [fake]));
    assert.ok(rendered.includes(`note: ${T3CODE_NO_USAGE_NOTE}`), "sources renders the usage note");
  }

  // --- antigravity-cli ----------------------------------------------------------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agc-"));
    try {
      fs.writeFileSync(path.join(dir, "a.db"), "x");
      fs.writeFileSync(path.join(dir, "a.db-wal"), "x");
      fs.writeFileSync(path.join(dir, "b.txt"), "x");
      const files = antigravityCliProvider.listFiles(dir);
      assert.deepEqual(files, [path.join(dir, "a.db")], "only main .db files listed");
      const events = antigravityCliProvider.parseLine("{}", {
        path: files[0]!,
        state: {},
        freshFile: true,
        machineId: "test",
      });
      assert.deepEqual(events, []);
      assert.ok(antigravityCliProvider.usageNote?.startsWith("no usage data exposed"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- skeletons ------------------------------------------------------------------
  for (const p of SKELETON_PROVIDERS) {
    assert.ok(p.usageNote?.startsWith("skeleton —"), `${p.id} marked as skeleton`);
    assert.deepEqual(p.parseLine("{}" as never, {
      path: "x",
      state: {},
      freshFile: true,
      machineId: "test",
    }), []);
  }

  {
    // grok (real adapter) honors GROK_HOME and filters to .jsonl; missing dirs list nothing.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    try {
      withEnv("GROK_HOME", home, () => {
        assert.deepEqual(grokProvider.listFiles(grokProvider.discoverRoots()[0]!), []);
        const sessions = path.join(home, "sessions", "2026", "08");
        fs.mkdirSync(sessions, { recursive: true });
        fs.writeFileSync(path.join(sessions, "rollout-x.jsonl"), "{}");
        fs.writeFileSync(path.join(sessions, "notes.txt"), "x");
        const files = grokProvider.listFiles(grokProvider.discoverRoots()[0]!);
        assert.deepEqual(files, [path.join(sessions, "rollout-x.jsonl")]);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  console.log("providers-extra tests passed");
})();
