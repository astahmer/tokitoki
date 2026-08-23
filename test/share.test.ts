import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSharePayload,
  describePayload,
  hashRepoName,
  readShareState,
  topEntries,
  writeShareState,
} from "../src/share.ts";

// ---------------------------------------------------------------- topEntries

function row(bucket: string, costUsd: number, tokens: number) {
  return {
    bucket,
    requests: 1,
    sessions: 1,
    inputTokens: Math.floor(tokens * 0.8),
    outputTokens: Math.floor(tokens * 0.1),
    cacheReadTokens: Math.floor(tokens * 0.1),
    cacheWriteTokens: 0,
    costUsd,
  };
}

{
  const rows = [
    row("expensive-model", 10, 1000),
    row("cheap-model", 0.5, 500_000),
    row("free-model", 0, 400_000),
  ];
  const top = topEntries(rows, 2);
  // Cost > 0 anywhere → cost is the ranking metric.
  assert.equal(top[0]?.name, "expensive-model");
  assert.equal(top.length, 2);
  assert.ok(top[0]!.share > top[1]!.share);

  // All-free → tokens decide.
  const free = rows.map((r) => ({ ...r, costUsd: 0 }));
  const topFree = topEntries(free, 3);
  assert.equal(topFree[0]?.name, "cheap-model");
}

{
  // Zero rows → no entries, never NaN shares.
  const top = topEntries([], 5);
  assert.deepEqual(top, []);
  const zeroed = topEntries([row("m", 0, 0)], 5);
  assert.deepEqual(zeroed, []);
}

// ------------------------------------------------------------ repo hashing

{
  // Hashing is deterministic, non-reversible-looking, and stable across calls.
  const a = hashRepoName("/Users/me/dev/secret-project");
  const b = hashRepoName("/Users/me/dev/secret-project");
  const c = hashRepoName("/Users/me/dev/other");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.includes("secret"), false);
  assert.match(a, /^[0-9a-f]{16}$/);
}

// ------------------------------------------------------- payload sanitation

{
  process.env.TOKITOKI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-share-"));
  const payload = buildSharePayload("week", { includeRepos: true });
  const serialized = JSON.stringify(payload);
  // Privacy invariants: no raw paths, no emails, no session content.
  assert.equal(serialized.includes(os.homedir()), false);
  assert.equal(serialized.includes("@welii.io"), false);
  assert.equal(serialized.includes("gmail.com"), false);
  assert.equal(payload.$type, "dev.tokitoki.share");
  assert.ok(Array.isArray(payload.topModels));
  assert.ok(payload.totals.requests >= 0);
  if (payload.repos !== undefined) {
    for (const r of payload.repos) assert.match(r.hash, /^[0-9a-f]{16}$/);
  }
  const lines = describePayload(payload, true).join("\n");
  assert.match(lines, /never included: messages, prompts, emails/);

  // Default (no --include-repos): repos key absent entirely.
  const plain = buildSharePayload("week");
  assert.equal(plain.repos, undefined);
}

// ------------------------------------------------------------- share state

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-state-"));
  process.env.TOKITOKI_DATA_DIR = dir;
  // Fresh state defaults to disabled — sharing must never be on by accident.
  const fresh = readShareState();
  assert.equal(fresh.enabled, false);

  writeShareState({ enabled: true, lastPublished: { cid: "abc", rkey: "week-2026-08-24", at: "now", scope: "week" } });
  const read = readShareState();
  assert.equal(read.enabled, true);
  assert.equal(read.lastPublished?.cid, "abc");

  writeShareState({ enabled: false });
  assert.equal(readShareState().enabled, false);
}

console.log("share.test.ts ok");
