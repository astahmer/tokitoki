import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { antigravityCliProvider } from "../src/providers/antigravity-cli.ts";
import { SKELETON_PROVIDERS } from "../src/providers/skeletons.ts";
import { grokProvider } from "../src/providers/grok.ts";
import {
  extractT3SessionDocs,
  t3CodeProvider,
  T3CODE_NO_USAGE_NOTE,
} from "../src/providers/t3code.ts";
import { renderSources, collectSources } from "../src/sources.ts";

// Modeled on a real snapshot inspected in
// ~/Library/Application Support/t3code/IndexedDB/*.leveldb (2026-08-24).
const THREAD_A =
  '{"schemaVersion":2,"environmentId":"695d1d4c","threadId":"' +
  "e34f88a5-7e25-4d56-8f68-33eae4844122" +
  '","snapshot":{"snapshotSequence":1041,"thread":{"id":"e34f88a5-7e25-4d56-8f68-33eae4844122",' +
  '"projectId":"29f69879","title":"if it works just say \\"ok\\"","modelSelection":{"instanceId":"opencode",' +
  '"model":"commandcode/deepseek-v4-flash"},"createdAt":"2026-08-04T16:19:17.793Z","messages":' +
  '[{"id":"1","role":"user","text":"if it works just say \\"ok\\""},{"id":"2","role":"user","text":"say ok if it works"}]}}}';

const THREAD_B =
  '{"schemaVersion":2,"environmentId":"695d1d4c","threadId":"' +
  "0228aba2-07fc-4699-a632-d41c038b8d92" +
  '","snapshot":{"snapshotSequence":7,"thread":{"id":"0228aba2-07fc-4699-a632-d41c038b8d92",' +
  '"title":"fix flaky test","modelSelection":{"instanceId":"claudeAgent","model":"claude-sonnet-5"},' +
  '"createdAt":"2026-08-20T09:00:00.000Z","messages":[{"role":"user","text":"make the test pass"}]}}}';

const THREAD_C =
  '{"schemaVersion":2,"environmentId":"695d1d4c","threadId":"c8b1c6df-1ee8-42ec-9f3f-8d53686f0fd2",' +
  '"snapshot":{"snapshotSequence":8,"thread":{"title":"fallback timestamp",' +
  '"latestTurn":{"requestedAt":"2026-08-21T11:12:13.000Z"}}}}';

function tmpLevelDbWith(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-ldb-"));
  // .log = LevelDB write-ahead; content is binary junk + embedded JSON.
  const junk = Buffer.from([0x00, 0x9e, 0xff, 0x1f, 0x0a]);
  fs.writeFileSync(
    path.join(dir, "000458.log"),
    Buffer.concat([junk, Buffer.from(contents, "latin1"), junk]),
  );
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
    const dir = tmpLevelDbWith(THREAD_A + "\xff\x02junk" + THREAD_B + THREAD_C);
    try {
      const files = t3CodeProvider.listFiles(dir);
      assert.equal(files.length, 1, "lists the .log data file");

      const docs = extractT3SessionDocs(files[0]!);
      assert.equal(docs.length, 3, `all threads found, got ${docs.length}`);
      const a = docs.find((d) => d.sessionId === "e34f88a5-7e25-4d56-8f68-33eae4844122");
      const b = docs.find((d) => d.sessionId === "0228aba2-07fc-4699-a632-d41c038b8d92");
      const c = docs.find((d) => d.sessionId === "c8b1c6df-1ee8-42ec-9f3f-8d53686f0fd2");
      assert.ok(a && b && c, "docs keyed by threadId");
      assert.equal(a!.title, 'if it works just say "ok"');
      assert.ok(a!.body.includes('if it works just say "ok"') && a!.body.includes("say ok if it works"));
      assert.equal(a!.accountKey, "opencode");
      assert.equal(a!.startedAt, "2026-08-04T16:19:17.793Z");
      assert.equal(b!.title, "fix flaky test");
      assert.equal(b!.accountKey, "claudeAgent");
      assert.equal(c!.startedAt, "2026-08-21T11:12:13.000Z");

      // parseLine never emits — no usage data in this store.
      const events = t3CodeProvider.parseLine(THREAD_A, {
        path: files[0]!,
        state: {},
        freshFile: true,
        machineId: "test",
      });
      assert.deepEqual(events, []);
      assert.equal(t3CodeProvider.usageNote, T3CODE_NO_USAGE_NOTE);
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
