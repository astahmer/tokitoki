import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import TOML from "@iarna/toml";

import type { SyncConfig } from "./sync/types.ts";
import type { BudgetsConfig } from "./budgets.ts";

export interface ProviderConfig {
  /** Override roots to scan for this provider */
  paths?: string[];
}

/**
 * User-configured plan quota estimate. Providers don't expose subscription
 * caps, so these are honest user-set approximations used only for gauges.
 */
export interface PlanConfig {
  kind?: "subscription";
  monthlyRequestCap?: number;
  monthlyCostCap?: number;
}

export interface TokitokiConfig {
  /**
   * Extra events.jsonl files to merge into reports (other machines' logs,
   * typically synced via Syncthing). Deduped by event id — safe to point at
   * overlapping files.
   */
  extraEventFiles?: string[];
  /** Cross-machine sync transport ([sync] section). See src/sync/. */
  sync?: SyncConfig;
  providers?: Record<string, ProviderConfig>;
  /**
   * Plan quota estimates keyed by accountKey pattern (exact match, or
   * trailing `*` for prefix match). Matched rows render a usage gauge
   * instead of a cost cell. Most useful with `--by account`.
   */
  plans?: Record<string, PlanConfig>;
  /** [budgets] — USD caps per period + optional ntfy topic for push alerts. */
  budgets?: BudgetsConfig;
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
  if (cfg.plans !== undefined && typeof cfg.plans !== "object") delete cfg.plans;
  if (cfg.sync !== undefined && typeof cfg.sync !== "object") delete cfg.sync;
  if (cfg.budgets !== undefined && typeof cfg.budgets !== "object") delete cfg.budgets;
  return cfg;
}

export function providerConfig(id: string): ProviderConfig | undefined {
  return loadConfig().providers?.[id];
}
