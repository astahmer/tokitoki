import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import {
  escapeFtsQuery,
  rebuildSessionIndex,
  searchSessions,
  sessionConversation,
  updateSessionIndex,
} from "../src/sessionIndex.ts";
import type { Provider } from "../src/providers/types.ts";
import { extractClaudeSessionDocs } from "../src/providers/claude-code.ts";
import { extractCodexSessionDocs } from "../src/providers/codex.ts";
import { extractPiSessionDocs } from "../src/providers/pi.ts";
import { cleanSessionText, sessionTitle } from "../src/sessionText.ts";

function tmpDb(): Database {
  return new Database(path.join(os.tmpdir(), `tokitoki-fts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`), {
    create: true,
  });
}

const CLAUDE_LINE = (text: string): string =>
  JSON.stringify({
    type: "user",
    sessionId: "sess-1",
    timestamp: "2026-08-20T10:00:00Z",
    cwd: "/tmp/proj",
    message: { role: "user", content: text },
  });

describe("escapeFtsQuery", () => {
  it("quotes terms and ANDs them", () => {
    expect(escapeFtsQuery("kumo treemap")).toBe(`"kumo" "treemap"`);
  });

  it("neutralizes fts5 syntax in user input", () => {
    // Column filters, booleans, NEAR, quotes — all become inert literals.
    const out = escapeFtsQuery('body:password OR NEAR("x"');
    expect(out).toBe(`"body:password" "OR" "NEAR(""x"""`);
    // The escaped query must be accepted by a real FTS5 MATCH without error.
    const db = tmpDb();
    const res = searchSessions(db, { query: 'body:password OR NEAR("x"' });
    expect(res.rows).toEqual([]);
    db.close();
  });
});

describe("session display text", () => {
  it("removes injected context and chooses the actual request", () => {
    const raw = "<app-context>internal metadata</app-context>\n<recommended_plugins>plugin catalog</recommended_plugins>\n## My request:\nindex pi and claude conversations\n<image name=foo>ignored</image>";
    expect(cleanSessionText(raw)).toContain("index pi and claude conversations");
    expect(cleanSessionText(raw)).not.toContain("internal metadata");
    expect(sessionTitle(raw)).toBe("index pi and claude conversations");
  });

  it("removes unwrapped Codex instructions and keeps the full provider conversation", () => {
    const file = path.join(os.tmpdir(), `tokitoki-codex-${Date.now()}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: "codex-sess", timestamp: "2026-08-20T10:00:00Z" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>always use jj</INSTRUCTIONS>" }, { type: "input_text", text: "actual Codex request" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex answer" }] } }),
      ].join("\n"),
    );
    const doc = extractCodexSessionDocs(file)[0]!;
    expect(doc.title).toBe("actual Codex request");
    expect(doc.body).toContain("actual Codex request");
    expect(doc.body).toContain("Codex answer");
    expect(doc.body).not.toContain("AGENTS.md");
    fs.rmSync(file, { force: true });
  });

  it("indexes Pi and Claude user plus assistant text instead of no-content sessions", () => {
    const piFile = path.join(os.tmpdir(), `tokitoki-pi-${Date.now()}.jsonl`);
    fs.writeFileSync(piFile, [
      JSON.stringify({ type: "session", id: "pi-sess", timestamp: "2026-08-20T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Pi request" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Pi answer" }] } }),
    ].join("\n"));
    const claudeFile = path.join(os.tmpdir(), `tokitoki-claude-${Date.now()}.jsonl`);
    fs.writeFileSync(claudeFile, [
      JSON.stringify({ type: "user", sessionId: "claude-sess", timestamp: "2026-08-20T10:00:00Z", message: { role: "user", content: "Claude request" } }),
      JSON.stringify({ type: "assistant", sessionId: "claude-sess", message: { role: "assistant", content: [{ type: "text", text: "Claude answer" }] } }),
    ].join("\n"));
    const pi = extractPiSessionDocs(piFile)[0]!;
    const claude = extractClaudeSessionDocs(claudeFile)[0]!;
    expect(pi.title).toBe("Pi request");
    expect(pi.body).toContain("Pi request");
    expect(pi.body).toContain("Pi answer");
    expect(claude.title).toBe("Claude request");
    expect(claude.body).toContain("Claude request");
    expect(claude.body).toContain("Claude answer");
    fs.rmSync(piFile, { force: true });
    fs.rmSync(claudeFile, { force: true });
  });
});

describe("session index", () => {
  /** Fake provider deriving one doc per .jsonl file from its real content. */
  function fakeProvider(dir: string): Provider {
    return {
      id: "fake",
      label: "Fake",
      discoverRoots: () => [dir],
      listFiles: (root) =>
        fs
          .readdirSync(root)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => path.join(root, f)),
      parseLine: () => [],
      extractSessionDocs: (file) => {
        const raw = fs.readFileSync(file, "utf8");
        const texts = [...raw.matchAll(/"content":"([^"]+)"/g)].map((m) => m[1]!);
        if (texts.length === 0) return [];
        const id = path.basename(file, ".jsonl");
        return [
          {
            sessionId: `sess-${id}`,
            startedAt: "2026-08-20T10:00:00Z",
            title: texts[0]!,
            body: texts.join("\n"),
          },
        ];
      },
    };
  }

  it("indexes, finds by content, and respects incremental freshness", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-stores-"));
    const file = path.join(dir, "a.jsonl");
    fs.writeFileSync(file, `${CLAUDE_LINE("migrate the pds to cirrus")}\n`);
    fs.writeFileSync(path.join(dir, "b.jsonl"), `${CLAUDE_LINE("unrelated chat about weather")}\n`);

    const db = tmpDb();
    let stats = updateSessionIndex(db, [fakeProvider(dir)], { force: true });
    expect(stats.filesIndexed).toBe(2);
    expect(stats.docsIndexed).toBe(2);

    // Search hits the right session with a snippet around the match.
    const hit = searchSessions(db, { query: "cirrus" });
    expect(hit.rows.length).toBe(1);
    expect(hit.rows[0]!.sessionId).toBe("sess-a");
    expect(hit.rows[0]!.snippet).toContain("[[cirrus]]");
    expect(sessionConversation(db, "fake", "sess-a")).toEqual({
      title: "migrate the pds to cirrus",
      body: "migrate the pds to cirrus",
    });

    // Unchanged files are skipped on the next incremental pass.
    stats = updateSessionIndex(db, [fakeProvider(dir)], { force: true });
    expect(stats.filesIndexed).toBe(0);

    // Modified file gets reindexed.
    await new Promise((r) => setTimeout(r, 20));
    fs.appendFileSync(file, `${CLAUDE_LINE("follow-up question")}\n`);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 100));
    stats = updateSessionIndex(db, [fakeProvider(dir)], { force: true });
    expect(stats.filesIndexed).toBe(1);
    expect(searchSessions(db, { query: "follow-up" }).rows.length).toBe(1);
    db.close();
  });

  it("force rebuild replaces everything exactly once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-stores-"));
    fs.writeFileSync(path.join(dir, "only.jsonl"), `${CLAUDE_LINE("hello world")}\n`);
    const provider = fakeProvider(dir);
    const db = tmpDb();
    updateSessionIndex(db, [provider], { force: true });
    const first = rebuildSessionIndex(db, [provider]);
    expect(first.docsIndexed).toBe(1);
    // No duplicates after rebuild.
    expect(searchSessions(db, { query: "hello" }).rows.length).toBe(1);
    db.close();
  });

  it("multi-term queries require all terms", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-stores-"));
    fs.writeFileSync(
      path.join(dir, "s.jsonl"),
      `${CLAUDE_LINE("kumo treemap rollout")}\n${CLAUDE_LINE("plain text only")}\n`,
    );
    const db = tmpDb();
    rebuildSessionIndex(db, [fakeProvider(dir)]);
    expect(searchSessions(db, { query: "kumo treemap" }).rows.length).toBe(1);
    expect(searchSessions(db, { query: "kumo missingterm" }).rows.length).toBe(0);
    db.close();
  });
});

describe("session index perf guards", () => {
  /** Same fake provider shape as the suite above (scoped there). */
  function fakeProvider(dir: string): Provider {
    return {
      id: "fake",
      label: "Fake",
      discoverRoots: () => [dir],
      listFiles: (root) =>
        fs
          .readdirSync(root)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => path.join(root, f)),
      parseLine: () => [],
      extractSessionDocs: (file) => {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
        return lines.map((_, i) => ({
          sessionId: `sess-${path.basename(file)}-${i}`,
          title: lines[i]!.slice(0, 40),
          body: lines[i]!,
        }));
      },
    } satisfies Provider;
  }

  it("throttles rapid successive updates unless forced", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tk-fts-throttle-"));
    const db = tmpDb();
    try {
      const file = path.join(dir, "a.jsonl");
      fs.writeFileSync(file, `${CLAUDE_LINE("throttle probe")}\n`);
      const provider = fakeProvider(dir);
      expect(updateSessionIndex(db, [provider]).filesIndexed).toBe(1);
      // Within the throttle window: no-op even though mtime changed.
      fs.utimesSync(file, new Date(), new Date(Date.now() + 100));
      expect(updateSessionIndex(db, [provider]).throttled).toBe(true);
      // Force bypasses.
      expect(updateSessionIndex(db, [provider], { force: true }).filesIndexed).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips oversized files and reports them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tk-fts-big-"));
    const db = tmpDb();
    try {
      const small = path.join(dir, "s.jsonl");
      fs.writeFileSync(small, `${CLAUDE_LINE("small file")}\n`);
      const big = path.join(dir, "big.jsonl");
      const handle = fs.openSync(big, "w");
      fs.writeSync(handle, Buffer.alloc(5 * 1024 * 1024, 0x20)); // 5MB filler
      fs.writeSync(handle, `${CLAUDE_LINE("inside giant")}\n`);
      fs.closeSync(handle);
      const stats = updateSessionIndex(db, [fakeProvider(dir)], { maxFileBytes: 1024 });
      expect(stats.filesIndexed).toBe(1); // only the small one
      expect(stats.skippedLargeFiles).toBe(1);
      expect(searchSessions(db, { query: "small" }).rows.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
