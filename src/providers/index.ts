import type { Provider } from "./types.ts";
import { claudeCodeProvider } from "./claude-code.ts";
import { piProvider } from "./pi.ts";
import { codexProvider } from "./codex.ts";

/**
 * Provider registry — adding a harness means dropping a file exporting a
 * `Provider` and registering it here.
 */
export const PROVIDERS: Provider[] = [claudeCodeProvider, piProvider, codexProvider];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
