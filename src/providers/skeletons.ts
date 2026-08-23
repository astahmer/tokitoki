import fs from "node:fs";
import path from "node:path";

import { providerConfig } from "../config.ts";
import { homePath, type EntryContext, type Provider } from "./types.ts";

/**
 * Skeleton providers for well-known harnesses whose stores are NOT present on
 * this machine. They keep the supported-matrix honest (`tokitoki sources`
 * lists them with 0 files) and document the expected formats so wiring a real
 * adapter later is a matter of implementing parseLine.
 *
 * Each skeleton:
 * - resolves its canonical store path (env override honored where the harness
 *   documents one)
 * - lists candidate files when the directory exists
 * - emits no events until a real format adapter lands
 */

interface SkeletonSpec {
  id: string;
  label: string;
  envVar?: string;
  /** Directory under $HOME holding the store (ignored when env override set). */
  dirBase: string;
  /** Path always appended (to the default OR the env override), e.g. "/sessions". */
  subPath?: string;
  /** File extension filter inside the final directory. */
  extensions?: string[];
  /** Where usage lives / what to implement — shown in sources + README matrix. */
  note: string;
}

function makeSkeleton(spec: SkeletonSpec): Provider {
  const roots = (): string[] => {
    const configured = providerConfig(spec.id)?.paths;
    if (configured !== undefined && configured.length > 0) return configured;
    const override = spec.envVar !== undefined ? process.env[spec.envVar] : undefined;
    const hasOverride = override !== undefined && override.length > 0;
    if (!hasOverride && spec.dirBase.length === 0) return [];
    const base = hasOverride ? override! : homePath("", spec.dirBase);
    return [spec.subPath !== undefined ? base + spec.subPath : base];
  };
  return {
    id: spec.id,
    label: spec.label,
    envVar: spec.envVar,
    usageNote: `skeleton — ${spec.note}`,
    discoverRoots: roots,
    listFiles(root: string): string[] {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }
      if (spec.extensions === undefined) return entries.filter((e) => e.isFile()).map((e) => path.join(root, e.name));
      const exts = new Set(spec.extensions);
      return entries.filter((e) => e.isFile() && exts.has(path.extname(e.name))).map((e) => path.join(root, e.name));
    },
    parseLine(_line: string, _ctx: EntryContext): [] {
      return [];
    },
  };
}

export const cursorProvider = makeSkeleton({
  id: "cursor",
  label: "Cursor",
  envVar: "CURSOR_DIR",
  // Chats live in User/globalStorage/state.vscdb (sqlite, composerData keys).
  dirBase: "/.cursor",
  subPath: "/User/globalStorage",
  extensions: [".vscdb", ".db"],
  note: "expected store state.vscdb sqlite; parse ItemTable composerData keys for token counts",
});

export const grokProvider = makeSkeleton({
  id: "grok",
  label: "Grok CLI",
  envVar: "GROK_HOME",
  dirBase: "/.grok",
  subPath: "/sessions",
  extensions: [".jsonl"],
  note: "expected JSONL rollouts under $GROK_HOME/sessions (same shape family as codex)",
});

export const geminiCliProvider = makeSkeleton({
  id: "gemini-cli",
  label: "Gemini CLI",
  envVar: "GEMINI_CLI_DIR",
  dirBase: "/.gemini/tmp",
  extensions: [".json"],
  note: "expected ~/.gemini/tmp/<hash>/chats/session-*.json; tokens only present with /stats enabled",
});

export const aiderProvider = makeSkeleton({
  id: "aider",
  label: "Aider",
  envVar: "AIDER_HISTORY_DIR",
  // .aider.chat.history.jsonl lives per-project, so there is no single root.
  dirBase: "",
  note: "expected .aider.chat.history.jsonl per project dir; needs per-repo discovery, not a global root",
});

export const gooseProvider = makeSkeleton({
  id: "goose",
  label: "Goose",
  envVar: "GOOSE_DIR",
  dirBase: "/.config/goose",
  subPath: "/sessions",
  extensions: [".jsonl"],
  note: "expected session JSONL under ~/.config/goose/sessions",
});

export const ampProvider = makeSkeleton({
  id: "amp",
  label: "Amp",
  envVar: "AMP_DIR",
  dirBase: "/.local/share/amp",
  subPath: "/threads",
  extensions: [".json"],
  note: "expected thread JSON blobs under ~/.local/share/amp/threads",
});

export const zedProvider = makeSkeleton({
  id: "zed",
  label: "Zed",
  envVar: "ZED_DIR",
  dirBase: "/.local/share/zed",
  extensions: [".db"],
  note: "expected agent conversation state in ~/.local/share/zed (sqlite); schema needs inspection",
});

/** Registered after real providers; all emit no events on this machine. */
export const SKELETON_PROVIDERS: Provider[] = [
  cursorProvider,
  grokProvider,
  geminiCliProvider,
  aiderProvider,
  gooseProvider,
  ampProvider,
  zedProvider,
];
