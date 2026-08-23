import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import TOML from "@iarna/toml";

export interface ProviderConfig {
  /** Override roots to scan for this provider */
  paths?: string[];
}

export interface TokitokiConfig {
  /**
   * Extra events.jsonl files to merge into reports (other machines' logs,
   * typically synced via Syncthing). Deduped by event id — safe to point at
   * overlapping files.
   */
  extraEventFiles?: string[];
  providers?: Record<string, ProviderConfig>;
}

export function configPath(): string {
  const override = process.env.TOKITOKI_CONFIG;
  if (override !== undefined && override.length > 0) return override;
  return path.join(os.homedir(), ".config", "tokitoki", "config.json");
}

export function loadConfig(): TokitokiConfig {
  const p = configPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    // Also try config.toml next to the json default
    if (p.endsWith(".json")) {
      const tomlPath = p.replace(/\.json$/, ".toml");
      try {
        raw = fs.readFileSync(tomlPath, "utf8");
        return normalize(TOML.parse(raw) as unknown);
      } catch {
        /* fall through to empty config */
      }
    }
    return {};
  }
  if (p.endsWith(".toml")) return normalize(TOML.parse(raw) as unknown);
  try {
    return normalize(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

function normalize(value: unknown): TokitokiConfig {
  const cfg = (value ?? {}) as TokitokiConfig;
  if (!Array.isArray(cfg.extraEventFiles)) delete cfg.extraEventFiles;
  if (cfg.providers !== undefined && typeof cfg.providers !== "object") delete cfg.providers;
  return cfg;
}

export function providerConfig(id: string): ProviderConfig | undefined {
  return loadConfig().providers?.[id];
}
