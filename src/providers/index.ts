import type { Provider } from "./types.ts";
import { claudeCodeProvider } from "./claude-code.ts";
import { piProvider } from "./pi.ts";
import { codexProvider } from "./codex.ts";
import { t3CodeProvider } from "./t3code.ts";
import { antigravityCliProvider } from "./antigravity-cli.ts";
import { cursorProvider } from "./cursor.ts";
import { grokProvider } from "./grok.ts";
import { geminiCliProvider } from "./gemini.ts";
import { opencodeProvider } from "./opencode.ts";
import { commandcodeProvider } from "./commandcode.ts";
import { SKELETON_PROVIDERS } from "./skeletons.ts";

/**
 * Provider registry — adding a harness means dropping a file exporting a
 * `Provider` and registering it here.
 *
 * Real adapters first (emit usage events), stores-found-but-no-usage next,
 * documented skeletons for absent harnesses last.
 */
export const PROVIDERS: Provider[] = [
  claudeCodeProvider,
  piProvider,
  codexProvider,
  opencodeProvider,
  commandcodeProvider,
  t3CodeProvider,
  antigravityCliProvider,
  cursorProvider,
  grokProvider,
  geminiCliProvider,
  ...SKELETON_PROVIDERS,
];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
