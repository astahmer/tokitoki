import os from "node:os";
import path from "node:path";
import { loadConfig, type TokitokiConfig } from "./config.ts";

export interface CodexHomesOptions {
  config?: TokitokiConfig;
  env?: Record<string, string | undefined>;
}

/** Native credential homes. Only a known sessions root can imply a home;
 * arbitrary scanner paths must never become credential directories. */
export function codexHomes(options: CodexHomesOptions = {}): string[] {
  const config = options.config ?? loadConfig();
  const env = options.env ?? process.env;
  const home = env.HOME ?? os.homedir();
  const expand = (value: string): string => path.resolve(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  const homes = [env.CODEX_HOME || path.join(home, ".codex"), ...(config.poll?.codexHomes ?? [])];
  for (const root of config.providers?.codex?.paths ?? []) {
    const resolved = expand(root);
    if (path.basename(resolved) === "sessions") homes.push(path.dirname(resolved));
  }
  return [...new Set(homes.filter(value => typeof value === "string" && value.length > 0).map(expand))];
}
