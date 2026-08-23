import fs from "node:fs";
import path from "node:path";

import { providerConfig } from "../config.ts";
import { homePath, type EntryContext, type Provider } from "./types.ts";

/**
 * Gemini / Antigravity CLI keeps one sqlite DB per conversation under
 * ~/.gemini/antigravity-cli/conversations/<uuid>.db (tables: trajectory_meta,
 * steps, gen_metadata — protobuf blobs). Inspected 2026-08-24: the blobs
 * carry prompts and step metadata but no token usage or cost fields.
 * Registered so `tokitoki sources` shows the store; emits no events.
 */
export const ANTIGRAVITY_NO_USAGE_NOTE = "no usage data exposed (protobuf conversation blobs)";

function conversationsDir(): string {
  return path.join(homePath("ANTIGRAVITY_DIR", "/.gemini/antigravity-cli"), "conversations");
}

export const antigravityCliProvider: Provider = {
  id: "antigravity-cli",
  label: "Antigravity CLI",
  envVar: "ANTIGRAVITY_DIR",
  usageNote: ANTIGRAVITY_NO_USAGE_NOTE,

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return [conversationsDir()];
  },

  listFiles(root: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    // Main .db files only — -wal/-shm siblings are not independent stores.
    return entries.filter((e) => e.isFile() && e.name.endsWith(".db")).map((e) => path.join(root, e.name));
  },

  parseLine(_line: string, _ctx: EntryContext): [] {
    return [];
  },
};
