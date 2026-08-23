import type { Provider } from "./types.ts";
import { claudeCodeProvider } from "./claude-code.ts";
import { piProvider } from "./pi.ts";
import { codexProvider } from "./codex.ts";
import { t3CodeProvider } from "./t3code.ts";
import { antigravityCliProvider } from "./antigravity-cli.ts";
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
  t3CodeProvider,
  antigravityCliProvider,
  ...SKELETON_PROVIDERS,
];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
