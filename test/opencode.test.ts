import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { Database } from "bun:sqlite";

import { opencodeProvider } from "../src/providers/opencode.ts";

const MACHINE = "test-mac";
let rootDir: string;

function createOpencodeStore(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      directory text NOT NULL,
      title text NOT NULL,
      version text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      model text,
      agent text,
      cost real DEFAULT 0 NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL
    );
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated, agent) VALUES (?, 'prj', ?, ?, '1.0', ?, ?, 'build')",
  ).run("ses_1", "/Users/me/dev/fruit", "fix jj rebase", 1_000, 2_000);
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses_1', ?, ?, ?)",
  ).run(
    "msg_1",
    1_500,
    1_600,
    JSON.stringify({
      role: "assistant",
      cost: 0.25,
      tokens: { total: 100, input: 20, output: 30, reasoning: 5, cache: { write: 2, read: 40 } },
      modelID: "kimi-k2.7-code",
      providerID: "opencode-go",
      time: { created: 1_500, completed: 1_600 },
    }),
  );
  // user message with tokens shape but role=user → must be skipped
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses_1', ?, ?, ?)",
  ).run("msg_2", 1_400, 1_450, JSON.stringify({ role: "user", model: { providerID: "opencode-go", modelID: "kimi-k2.7-code" } }));
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, 'msg_2', 'ses_1', 1_400, 1_450, ?)")
    .run("part_1", JSON.stringify({ type: "text", text: "how do i split a jj commit?" }));
  db.close();
}

beforeAll(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-opencode-"));
});

afterAll(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("opencode provider", () => {
  const { scanDb } = opencodeProvider;
  if (scanDb === undefined) throw new Error("opencode provider must implement scanDb");
  it("discovers opencode*.db stores under the data home", () => {
    createOpencodeStore(path.join(rootDir, "opencode-stable.db"));
    fs.writeFileSync(path.join(rootDir, "opencode-stable.db-shm"), "noise");
    const roots = opencodeProvider.discoverRoots();
    expect(roots.length).toBe(1);
    const files = opencodeProvider.listFiles(rootDir); // direct dir probe
    expect(files).toEqual([path.join(rootDir, "opencode-stable.db")]);
  });

  it("emits one event per assistant message with stable ids", () => {
    const events = scanDb(path.join(rootDir, "opencode-stable.db"), {
      state: {},
      freshFile: true,
      machineId: MACHINE,
    });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe("opencode:opencode-go:ses_1:msg_1");
    expect(e.provider).toBe("opencode");
    expect(e.accountKey).toBe("opencode-go");
    expect(e.model).toBe("kimi-k2.7-code");
    expect(e.inputTokens).toBe(20);
    expect(e.outputTokens).toBe(35); // output + reasoning folded
    expect(e.cacheReadTokens).toBe(40);
    expect(e.cacheWriteTokens).toBe(2);
    expect(e.costUsd).toBe(0.25); // reported cost wins over estimate
    expect(e.projectDir).toBe("/Users/me/dev/fruit");
    expect(e.sessionId).toBe("ses_1");
    expect(new Date(e.ts).getTime()).toBe(1_500);
  });

  it("is incremental via the watermark cursor", () => {
    const dbPath = path.join(rootDir, "opencode-inc.db");
    createOpencodeStore(dbPath);
    const cursors: Record<string, { offset: number; state?: Record<string, unknown> }> = {};
    void cursors;

    // Provider-level incremental check (scanProviderCore wiring is covered by
    // the scan tests; here we exercise state persistence directly).
    const state: Record<string, unknown> = {};
    const first = scanDb(dbPath, { state, freshFile: true, machineId: MACHINE });
    expect(first).toHaveLength(1);
    const wm = state.watermark as number;

    // No new rows → nothing emitted
    const second = scanDb(dbPath, { state: { watermark: wm }, freshFile: false, machineId: MACHINE });
    expect(second).toHaveLength(0);

    // New assistant row above the watermark → exactly that one emitted
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_3', 'ses_1', 3000, 3100, ?)",
    ).run(
      JSON.stringify({
        role: "assistant",
        tokens: { input: 11, output: 7, cache: {} },
        modelID: "deepseek-v4-flash-free",
        providerID: "opencode",
        time: { created: 3_000, completed: 3_100 },
      }),
    );
    db.close();
    const third = scanDb(dbPath, { state: { watermark: wm }, freshFile: false, machineId: MACHINE });
    expect(third).toHaveLength(1);
    expect(third[0]!.id).toBe("opencode:opencode:ses_1:msg_3");
    expect(third[0]!.accountKey).toBe("opencode");
    expect((third[0]!.costUsd ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it("extracts searchable session docs from the store", () => {
    const docs = opencodeProvider.extractSessionDocs!(path.join(rootDir, "opencode-stable.db"));
    expect(docs).toHaveLength(1);
    const d = docs[0]!;
    expect(d.sessionId).toBe("ses_1");
    expect(d.title).toBe("fix jj rebase");
    expect(d.startedAt).toBe(new Date(1_000).toISOString());
    expect(d.body).toContain("how do i split a jj commit?");
  });

  it("tolerates non-opencode sqlite files and missing tables", () => {
    const notOpencode = path.join(rootDir, "random.db");
    const db = new Database(notOpencode);
    db.exec("CREATE TABLE stuff (x integer)");
    db.close();
    expect(scanDb(notOpencode, { state: {}, freshFile: true, machineId: MACHINE })).toEqual([]);
    expect(opencodeProvider.extractSessionDocs?.(notOpencode) ?? []).toEqual([]);
  });

  it("is registered in the provider registry", async () => {
    const { PROVIDERS } = await import("../src/providers/index.ts");
    expect(PROVIDERS.some((p) => p.id === "opencode")).toBe(true);
  });

  it("waits for time.completed instead of locking in a mid-stream partial count", () => {
    // A scan can catch an assistant message while it's still streaming:
    // time_updated already bumped, but tokens are a partial snapshot and
    // time.completed isn't set yet. Downstream dedupe is first-write-wins
    // (cache.ts INSERT OR IGNORE), so emitting here would permanently lock
    // in an undercount — the real final row later would be silently
    // discarded as a duplicate of the same event id.
    const dbPath = path.join(rootDir, "opencode-streaming.db");
    createOpencodeStore(dbPath);
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_stream', 'ses_1', 5000, 5050, ?)",
    ).run(
      JSON.stringify({
        role: "assistant",
        tokens: { input: 5, output: 3, cache: {} },
        modelID: "kimi-k2.7-code",
        providerID: "opencode-go",
        time: { created: 5_000 }, // still streaming — no completed yet
      }),
    );
    db.close();

    const state: Record<string, unknown> = {};
    const midStream = scanDb(dbPath, { state, freshFile: true, machineId: MACHINE });
    expect(midStream.find((e) => e.id.includes("msg_stream"))).toBeUndefined();

    const db2 = new Database(dbPath);
    db2.prepare("UPDATE message SET time_updated = 5200, data = ? WHERE id = 'msg_stream'").run(
      JSON.stringify({
        role: "assistant",
        cost: 0.4,
        tokens: { input: 20, output: 30, cache: {} },
        modelID: "kimi-k2.7-code",
        providerID: "opencode-go",
        time: { created: 5_000, completed: 5_200 },
      }),
    );
    db2.close();

    const finished = scanDb(dbPath, { state, freshFile: false, machineId: MACHINE });
    const final = finished.find((e) => e.id.includes("msg_stream"));
    expect(final).toBeDefined();
    expect(final!.inputTokens).toBe(20);
    expect(final!.outputTokens).toBe(30);
  });

  it("trusts an honest $0 reported cost instead of substituting an estimate", () => {
    const dbPath = path.join(rootDir, "opencode-zerocost.db");
    createOpencodeStore(dbPath);
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_cached', 'ses_1', 6000, 6050, ?)",
    ).run(
      JSON.stringify({
        role: "assistant",
        cost: 0, // fully served from cache — a real, honest zero
        tokens: { input: 500, output: 10, cache: { read: 5000 } },
        modelID: "kimi-k2.7-code",
        providerID: "opencode-go",
        time: { created: 6_000, completed: 6_050 },
      }),
    );
    db.close();

    const events = scanDb(dbPath, { state: {}, freshFile: true, machineId: MACHINE });
    const event = events.find((e) => e.id.includes("msg_cached"));
    expect(event).toBeDefined();
    expect(event!.costUsd).toBe(0);
  });
});
