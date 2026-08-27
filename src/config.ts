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
  /**
   * [poll] — provider quota polling (`tokitoki poll`). Reuses locally stored
   * OAuth credentials to fetch real rate-limit windows. The menubar scheduler
   * runs only when enabled; intervalMinutes controls its cadence.
   */
  poll?: {
    /** Menubar app runs `tokitoki poll` every ~15 minutes when true. */
    enabled?: boolean;
    /** Menubar background poll cadence in minutes (default 15). */
    intervalMinutes?: number;
    /**
     * Manually registered opencode gateway keys (multi-account): each is
     * polled as its own synthetic account and gets a card even with zero
     * scanned events.
     */
    extraKeys?: Array<{
      /** Stable id = accountKey on the card (and quota_snapshots key). */
      id: string;
      /** Optional display label; defaults to the id. */
      label?: string;
      provider?: "opencode-go";
      key: string;
    }>;
  };
  /** Escape-hatch flags for features not yet stable enough to document. */
  experimental?: {
    /** Zero-usage placeholder cards for detected-but-empty harnesses (default on). */
    zeroStateCards?: boolean;
  };
  /**
   * [ui] — visibility toggles for menubar/dashboard surfaces. Entries are
   * provider ids or `provider:account` pairs; hidden ones are excluded from
   * the menubar payload / dashboard queries respectively.
   */
  ui?: {
    hidden?: {
      /** Hidden from the menu-bar preview rows. */
      menubar?: string[];
      /** Hidden from the web dashboard. */
      dashboard?: string[];
    };
    /** Show only these providers in the menubar preview (empty = all). */
    menubarProviders?: string[];
    /**
     * UPSTREAM providers hidden from the STATUS-BAR STRIP only (openai,
     * claude, opencode, openrouter, gemini, grok, cursor) — popover cards
     * are unaffected. Distinct from hidden.menubar, which hides accounts
     * from the popover CARDS.
     */
    previewHidden?: string[];
    /**
     * Uniform status-strip metric: "percent" (default) shows real
     * provider-reported remaining % and nothing when unknown; "tokens"
     * shows a compact usage estimate (~764M); "smart" favors the governing
     * quota window or its next reset.
     */
    stripMetric?: "percent" | "tokens" | "smart";
    /** When every visible quota is exhausted: keep %, hide the mark, or show the governing reset countdown. */
    stripExhausted?: "show" | "hide" | "reset";
    /** Max provider percentages shown in the status-item preview line. */
    menubarPreviewLines?: number;
    /** "inline" (default): preview always in the status item. "hover": only while pointing at it. */
    menubarPreviewMode?: "inline" | "hover";
    /**
     * Menubar popover card layout: ordered ids; an id prefixed "!" is hidden
     * (e.g. ["limits", "!tools", "hero"]). Ids missing from the list keep
     * their default position/visibility.
     */
    menubarCards?: string[];
    /** Account-card display order ("provider@accountKey" ids), menubar popover. */
    menubarAccountOrder?: string[];
  };
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
  if (cfg.poll !== undefined && typeof cfg.poll !== "object") delete cfg.poll;
  return cfg;
}

export function providerConfig(id: string): ProviderConfig | undefined {
  return loadConfig().providers?.[id];
}
