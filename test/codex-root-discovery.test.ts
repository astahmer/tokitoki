import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexProvider } from "../src/providers/codex.ts";

const previousHome = process.env.CODEX_HOME;
const previousConfig = process.env.TOKITOKI_CONFIG;
const directories: string[] = [];
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousConfig === undefined) delete process.env.TOKITOKI_CONFIG;
  else process.env.TOKITOKI_CONFIG = previousConfig;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("discovers active and archived sessions for every configured native Codex home", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tokitoki-codex-roots-"));
  directories.push(dir);
  const personal = path.join(dir, "personal");
  const work = path.join(dir, "work");
  process.env.CODEX_HOME = personal;
  process.env.TOKITOKI_CONFIG = path.join(dir, "config.json");
  writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify({ poll: { codexHomes: [work, personal] } }));
  const expected = [personal, work].flatMap(home => [path.join(home, "sessions"), path.join(home, "archived_sessions")]);
  for (const root of expected) {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "rollout-native.jsonl"), "{}\n");
  }
  expect(codexProvider.discoverRoots()).toEqual(expected);
  expect(expected.flatMap(root => codexProvider.listFiles(root))).toHaveLength(4);
  const explicit = path.join(dir, "explicit-session-root");
  writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify({ providers: { codex: { paths: [explicit] } }, poll: { codexHomes: [work] } }));
  expect(codexProvider.discoverRoots()).toEqual([explicit]);
});
