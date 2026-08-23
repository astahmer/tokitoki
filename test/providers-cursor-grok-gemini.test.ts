import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { afterAll, describe, expect, test } from "bun:test";

import { cursorFiles, extractCursorSessionDocs, cursorProvider } from "../src/providers/cursor.ts";
import { grokProvider } from "../src/providers/grok.ts";
import { geminiCliProvider } from "../src/providers/gemini.ts";
import type { EntryContext } from "../src/providers/types.ts";

const TMP = fs.mkdtempSync(path.join(import.meta.dir, ".fixture-"));
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function ctx(file: string, fresh = true): EntryContext {
  return { path: file, state: {}, freshFile: fresh, machineId: "test-mac" };
}

function ctxLines(file: string, lines: string[]): { events: number; state: Record<string, unknown> } {
  const c = ctx(file);
  let events = 0;
  for (const line of lines) events += grokProvider.parseLine(line, c).length;
  return { events, state: c.state };
}

describe("cursor provider", () => {
  const root = path.join(TMP, "cursor");
  fs.mkdirSync(path.join(root, "User/globalStorage"), { recursive: true });
  fs.mkdirSync(path.join(root, "ai-tracking"), { recursive: true });
  const vscdb = path.join(root, "User/globalStorage/state.vscdb");
  const tracking = path.join(root, "ai-tracking/ai-code-tracking.db");

  test("lists only existing store files", () => {
    // real (empty) sqlite files: reused by the indexing tests below
    new Database(tracking).close();
    expect(cursorFiles(root)).toEqual([tracking]);
    new Database(vscdb).close();
    expect(cursorFiles(root)).toEqual([vscdb, tracking]);
    expect(cursorProvider.listFiles(path.join(TMP, "missing"))).toEqual([]);
  });

  test("never emits usage events (no token data exists in cursor stores)", () => {
    expect(cursorProvider.parseLine("{}", ctx(vscdb))).toEqual([]);
  });

  test("indexes conversation summaries from ai-code-tracking.db", () => {
    const db = new Database(tracking);
    db.exec(`CREATE TABLE conversation_summaries (
      conversationId TEXT PRIMARY KEY, title TEXT, tldr TEXT,
      overview TEXT, summaryBullets TEXT, model TEXT, mode TEXT,
      updatedAt INTEGER NOT NULL)`);
    db.query(
      "INSERT INTO conversation_summaries VALUES ($id, $title, $tldr, $overview, $bullets, $model, 'agent', $ts)",
    ).run({
      $id: "conv-1",
      $title: "Fix flaky e2e",
      $tldr: "Retried screenshots",
      $overview: "Root cause was a race in the fixture.",
      $bullets: "- retry\n- assert ink",
      $model: "grok-4.5",
      $ts: 1756000000000,
    });
    db.close();

    const docs = extractCursorSessionDocs(tracking);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sessionId).toBe("conv-1");
    expect(docs[0]!.title).toBe("Fix flaky e2e");
    expect(docs[0]!.body).toContain("race in the fixture");
    expect(docs[0]!.accountKey).toBe("grok-4.5");
    expect(docs[0]!.startedAt).toBe(new Date(1756000000000).toISOString());
  });

  test("indexes composerData blobs from state.vscdb (tolerant shape)", () => {
    const db = new Database(vscdb);
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.query("INSERT INTO ItemTable VALUES ($k, $v)").run({
      $k: "composerData:abc-123",
      $v: JSON.stringify({
        name: "Refactor pricing module",
        conversation: [
          { type: 1, text: "why is the discount applied twice?" },
          { role: "user", text: "see stack trace below for details" },
          { uninteresting: "short" },
        ],
      }),
    });
    db.close();

    const docs = extractCursorSessionDocs(vscdb);
    if (docs.length !== 1) console.log("DEBUG-DOCS:", JSON.stringify(docs));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sessionId).toBe("abc-123");
    expect(docs[0]!.title).toBe("Refactor pricing module");
    expect(docs[0]!.body).toContain("discount applied twice");
    expect(docs[0]!.body).toContain("stack trace below");
    expect(docs[0]!.body).not.toContain("uninteresting");
  });

  test("sources note stays honest about missing usage", () => {
    expect(cursorProvider.usageNote).toMatch(/no token usage exposed/i);
  });
});

describe("grok provider", () => {
  const sessionsDir = path.join(TMP, "grok/sessions/sub");
  fs.mkdirSync(sessionsDir, { recursive: true });

  test("parses codex-family nested token_count deltas", () => {
    const file = path.join(sessionsDir, "rollout-1.jsonl");
    const r = ctxLines(file, [
      JSON.stringify({ type: "session_meta", payload: { session_id: "g1", cwd: "/repo" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "grok-4.5" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-24T10:00:00Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 9999, output_tokens: 99 },
            last_token_usage: { input_tokens: 1200, output_tokens: 30, cached_input_tokens: 800 },
          },
        },
      }),
    ]);
    expect(r.events).toBe(1);
    // cumulative-only line must be skipped, not double counted
    const r2 = ctxLines(file, [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 999999, output_tokens: 999 } } },
      }),
    ]);
    expect(r2.events).toBe(0);
  });

  test("parses flat usage shapes with prompt/completion spellings", () => {
    const file = path.join(sessionsDir, "flat.jsonl");
    const r = ctxLines(file, [
      JSON.stringify({ ts: "2026-08-24T11:00:00Z", model: "grok-3", usage: { prompt_tokens: 500, completion_tokens: 20, cached_tokens: 100 } }),
    ]);
    expect(r.events).toBe(1);
  });

  test("zero-token usage emits nothing (no fabricated events)", () => {
    const file = path.join(sessionsDir, "empty.jsonl");
    const r = ctxLines(file, [JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }), "not json at all"]);
    expect(r.events).toBe(0);
  });

  test("full pipeline produces valid events via scan-shaped loop", async () => {
    const file = path.join(sessionsDir, "rollout-full.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: "g-full", cwd: "/proj" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "grok-4.5" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the login bug" }] } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-08-24T12:00:00Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 640, output_tokens: 88 } } } }),
      ].join("\n"),
    );
    const c = ctx(file);
    const events = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((l) => (l.length === 0 ? [] : grokProvider.parseLine(l, c)));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.provider).toBe("grok");
    expect(ev.sessionId).toBe("g-full");
    expect(ev.model).toBe("grok-4.5");
    expect(ev.inputTokens).toBe(640);
    expect(ev.projectDir).toBe("/proj");
    expect(typeof ev.costUsd).toBe("number");

    const docs = grokProvider.extractSessionDocs!(file);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sessionId).toBe("g-full");
    expect(docs[0]!.title).toBe("fix the login bug");
  });
});

describe("gemini-cli provider", () => {
  const hashDir = path.join(TMP, "gemini/tmp/abc123/chats");
  fs.mkdirSync(hashDir, { recursive: true });

  test("parses array-of-records files with token objects", () => {
    const file = path.join(hashDir, "session-1724000000000.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { type: "user", text: "explain the build graph", timestamp: "2026-08-24T09:00:00.000Z" },
        { type: "gemini", text: "it is a dag", tokens: { input: 900, output: 40, cached: 700 }, model: "gemini-3-pro" },
      ]),
    );
    const events = geminiCliProvider.parseLine("[", ctx(file)); // first line of pretty json triggers full read
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.provider).toBe("gemini-cli");
    expect(ev.sessionId).toBe("session-1724000000000");
    expect(ev.inputTokens).toBe(900);
    expect(ev.cacheReadTokens).toBe(700);
    expect(ev.projectDir).toBe("abc123");

    const docs = geminiCliProvider.extractSessionDocs!(file);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("explain the build graph");
    expect(docs[0]!.body).toContain("dag");
  });

  test("messages-wrapper shape also works", () => {
    const file = path.join(hashDir, "session-wrapped.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ messages: [{ type: "gemini", text: "ok", timestamp: 1756000000000, tokens: { input: 10, output: 5 } }] }),
    );
    const events = geminiCliProvider.parseLine("{", ctx(file));
    expect(events).toHaveLength(1);
    expect(events[0]!.ts).toBe(new Date(1756000000000).toISOString());
  });

  test("sessions without stats produce zero events but remain searchable", () => {
    const file = path.join(hashDir, "session-nostats.json");
    fs.writeFileSync(file, JSON.stringify([{ type: "user", text: "hello without any counters" }]));
    expect(geminiCliProvider.parseLine("[", ctx(file))).toEqual([]);
    expect(geminiCliProvider.extractSessionDocs!(file)).toHaveLength(1);
  });

  test("listFiles finds session files under tmp/<hash>/chats", () => {
    const roots = path.join(TMP, "gemini/tmp");
    const found = geminiCliProvider.listFiles(roots);
    expect(found.some((f) => f.endsWith("session-1724000000000.json"))).toBe(true);
  });
});
