import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import TOML from "@iarna/toml";
import { z } from "zod";

import type { SyncConfig } from "./sync/types.ts";
import type { BudgetsConfig } from "./budgets.ts";

export interface NotificationsConfig {
  /** Native/local alerts are opt-in; absent means disabled. */
  enabled?: boolean;
  /** Notify when a previously exhausted quota becomes available again. Opt-in. */
  resetAware?: boolean;
  /** Remaining percentage at which a quota becomes critical. */
  quotaCriticalPercent?: number;
  /** Warn when the month-end spend projection reaches this fraction of cap. Opt-in. */
  burnWarnings?: boolean;
  burnWarningRatio?: number;
  /** Notification categories disabled by the user (kept as stable ids for Nix). */
  disabled?: string[];
}

export interface PrivacyConfig {
  /** Redact account emails, ids, and credential hints in the native UI. */
  hideIdentities?: boolean;
}

export interface ProviderConfig {
  /** Override roots to scan for this provider */
  paths?: string[];
}

/**
 * User-configured plan quota estimate for accounts without provider-reported
 * quotas (API keys, gateways); an honest approximation used only for gauges.
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
   * Upstream provider for custom account or model-prefix names that cannot be
   * inferred, e.g. { "work-gateway": "openai" } for "work-gateway/gpt-5" models.
   */
  accountAliases?: Record<string, string>;
  /**
   * Plan quota estimates keyed by accountKey pattern (exact match, or
   * trailing `*` for prefix match). Matched rows render a usage gauge
   * instead of a cost cell. Most useful with `--by account`.
   */
  plans?: Record<string, PlanConfig>;
  /** [budgets] — USD caps per period + optional ntfy topic for push alerts. */
  budgets?: BudgetsConfig;
  /** [notifications] — local quota/reset alerts and spend-burn warnings. */
  notifications?: NotificationsConfig;
  /** [privacy] — local-only display redaction for screenshots/shared screens. */
  privacy?: PrivacyConfig;
  /** [statusIncidents] — vendor status-page checks (5 min cache); on by default. */
  statusIncidents?: { enabled?: boolean };
  /**
   * [poll] — provider quota polling (`tokitoki poll`). Reuses locally stored
   * OAuth credentials to fetch real rate-limit windows. The menubar scheduler
   * runs only when enabled; intervalMinutes controls its cadence.
   */
  poll?: {
    /** Additional native Codex homes, each with its own harness-managed login. */
    codexHomes?: string[];
    /** Menubar app runs `tokitoki poll` every ~15 minutes when true. */
    enabled?: boolean;
    /** Menubar background poll cadence in minutes (minimum 1; default 15). */
    intervalMinutes?: number;
    /** Adapt the cadence to upcoming quota resets (bounded 5–30 minutes). */
    adaptive?: boolean;
    /**
     * Manually registered provider API keys (multi-account): each is polled
     * as its own synthetic account and gets a card even with zero scanned
     * events.
     */
    extraKeys?: Array<{
      /** Stable id = accountKey on the card (and quota_snapshots key). */
      id: string;
      /** Optional display label; defaults to the id. */
      label?: string;
      /** zai/kimi/deepseek keys feed that provider's single "default" account (first key wins). */
      provider?: "opencode-go" | "openrouter" | "zai" | "kimi" | "deepseek";
      key: string;
    }>;
    /** z.ai API host: "global" (api.z.ai, default) or "bigmodel-cn" (open.bigmodel.cn). */
    zaiRegion?: "global" | "bigmodel-cn";
  };
  /** Escape-hatch flags for features not yet stable enough to document. */
  experimental?: {
    /** Zero-usage placeholder cards for detected-but-empty harnesses (default on). */
    zeroStateCards?: boolean;
  };
  /**
   * [ui] — visibility toggles for widget/dashboard surfaces. Entries are
   * provider ids or `provider:account` pairs; hidden ones are excluded from
   * the widget payload / dashboard queries respectively.
   */
  ui?: {
    hidden?: {
      /** Globally hidden from shell-widget quota cards and the status bar. */
      widget?: string[];
      /** @deprecated pre-rename names for `widget`; still read, folded forward on write. */
      menubar?: string[];
      bar?: string[];
      /** Hidden from the web dashboard. */
      dashboard?: string[];
    };
    /** Show only these providers in the menubar preview (empty = all). */
    menubarProviders?: string[];
    /**
     * UPSTREAM providers hidden from the STATUS-BAR STRIP only (openai,
     * claude, opencode, openrouter, gemini, grok, cursor) — popover cards
     * are unaffected. Distinct from hidden.widget, which hides accounts
     * from both the popover CARDS and the bar.
     */
    previewHidden?: string[];
    /** Stable provider@accountKey ids hidden only from the status bar. */
    previewHiddenAccounts?: string[];
    /** Status-bar order; undefined inherits menubarAccountOrder, [] uses source order. */
    previewAccountOrder?: string[];
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
    /** Show the compact usage preview in the menu bar (default: true). */
    menubarPreviewEnabled?: boolean;
    /** "inline" (default): preview always in the status item. "hover": only while pointing at it. */
    menubarPreviewMode?: "inline" | "hover";
    /** Show the floating vertical usage rail attached to the right screen edge (default: false). */
    sideNotchEnabled?: boolean;
    /** Providers hidden from the side-notch rail; independent from previewHidden. */
    sideNotchHidden?: string[];
    /** Side-notch display metric: "percent" (default) | "tokens" | "smart". */
    sideNotchMetric?: "percent" | "tokens" | "smart";
    /** Quota window that drives the side-notch ring/value; smart follows the provider's governing window. */
    sideNotchWindow?: "smart" | "day" | "week" | "month";
    /** Side-notch information mode: quota glance, recent activity, or runway guidance. */
    sideNotchMode?: "quota" | "activity" | "runway";
    /** Mirror enabled/providers/metric between the side-notch and menubar preview. */
    sideNotchSyncPreview?: boolean;
    /** Side-notch perimeter anchor: three positions on each screen edge. */
    sideNotchPlacement?: "top-left" | "top" | "top-right" | "right-top" | "right" | "right-bottom" | "bottom-left" | "bottom" | "bottom-right" | "left-top" | "left" | "left-bottom";
    /** Optional local labels keyed by the stable side-notch entry id. Blank restores the automatic name. */
    sideNotchDisplayNames?: Record<string, string>;
    /**
     * Menubar popover card layout: ordered ids; an id prefixed "!" is hidden
     * (e.g. ["limits", "!tools", "hero"]). Ids missing from the list keep
     * their default position/visibility.
     */
    menubarCards?: string[];
    /** Account-card display order ("provider@accountKey" ids), menubar popover. */
    menubarAccountOrder?: string[];
    /** Popover tabs in display order; the first four stay in the header. */
    menubarTabs?: string[];
    /** Show separate usage cards for each harness/account variant instead of collapsing shared account keys. */
    showHarnessVariants?: boolean;
  };
}

export function configPath(): string {
  const override = process.env.TOKITOKI_CONFIG;
  if (override !== undefined && override.length > 0) return override;
  const jsonPath = path.join(os.homedir(), ".config", "tokitoki", "config.json");
  const tomlPath = path.join(os.homedir(), ".config", "tokitoki", "config.toml");
  // Keep a user's existing TOML config as the writable source of truth. This
  // matters for Nix/Home Manager users: a UI change must not silently create a
  // higher-priority JSON sidecar that drifts from the declarative file.
  if (!fs.existsSync(jsonPath) && fs.existsSync(tomlPath)) return tomlPath;
  return jsonPath;
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

/** Persist the same config file that loadConfig() considers authoritative. */
export function writeConfig(config: TokitokiConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (p.endsWith(".toml")) {
    fs.writeFileSync(p, TOML.stringify(config as never));
  } else {
    fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
  }
}

function normalize(value: unknown): TokitokiConfig {
  const cfg = (value ?? {}) as TokitokiConfig;
  if (!Array.isArray(cfg.extraEventFiles)) delete cfg.extraEventFiles;
  if (cfg.providers !== undefined && typeof cfg.providers !== "object") delete cfg.providers;
  if (cfg.plans !== undefined && typeof cfg.plans !== "object") delete cfg.plans;
  if (cfg.accountAliases !== undefined && !z.record(z.string(), z.string()).safeParse(cfg.accountAliases).success) {
    delete cfg.accountAliases;
  }
  if (cfg.sync !== undefined && typeof cfg.sync !== "object") delete cfg.sync;
  if (cfg.budgets !== undefined && typeof cfg.budgets !== "object") delete cfg.budgets;
  if (cfg.notifications !== undefined && typeof cfg.notifications !== "object") delete cfg.notifications;
  if (cfg.privacy !== undefined && typeof cfg.privacy !== "object") delete cfg.privacy;
  if (cfg.statusIncidents !== undefined && typeof cfg.statusIncidents !== "object") delete cfg.statusIncidents;
  if (cfg.ui !== undefined && (cfg.ui === null || typeof cfg.ui !== "object")) delete cfg.ui;
  // Shell plugins write these lists with `config set`; a wrongly encoded empty
  // list ({} from some JSON encoders) must not break every payload consumer.
  const stringList = z.array(z.string());
  if (cfg.ui !== undefined) {
    for (const key of ["menubarProviders", "previewHidden", "previewHiddenAccounts", "previewAccountOrder", "menubarAccountOrder", "sideNotchHidden"] as const) {
      const value = cfg.ui[key];
      if (value === undefined) continue;
      if (!stringList.safeParse(value).success) delete cfg.ui[key];
    }
    if (cfg.ui.hidden !== undefined) {
      if (cfg.ui.hidden === null || typeof cfg.ui.hidden !== "object") delete cfg.ui.hidden;
      else for (const surface of ["widget", "menubar", "bar", "dashboard"] as const) {
        if (cfg.ui.hidden[surface] !== undefined && !stringList.safeParse(cfg.ui.hidden[surface]).success) delete cfg.ui.hidden[surface];
      }
    }
  }
  if (cfg.poll !== undefined && (cfg.poll === null || typeof cfg.poll !== "object")) delete cfg.poll;
  if (cfg.poll?.codexHomes !== undefined) {
    if (!Array.isArray(cfg.poll.codexHomes)) delete cfg.poll.codexHomes;
    else cfg.poll.codexHomes = cfg.poll.codexHomes.filter((home): home is string => typeof home === "string" && home.length > 0);
  }
  return cfg;
}

const ALIAS_RECHECK_MS = 5_000;
const aliasCache = new Map<string, { aliases: ReadonlyMap<string, string>; mtimeMs: number; checkedAt: number }>();

/**
 * [accountAliases] lowercased. Hot path in rollups, so the config file is
 * re-stat'ed at most every few seconds; long-lived `serve`/`web`/`mcp`
 * processes still pick up edits.
 */
export const accountAliases = (): ReadonlyMap<string, string> => {
  const key = configPath();
  const now = Date.now();
  const cached = aliasCache.get(key);
  if (cached !== undefined && now - cached.checkedAt < ALIAS_RECHECK_MS) return cached.aliases;
  const mtimeMs = fs.statSync(key, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    cached.checkedAt = now;
    return cached.aliases;
  }
  const aliases = new Map(
    Object.entries(loadConfig().accountAliases ?? {}).map(([name, provider]) => [name.toLowerCase(), provider.toLowerCase()]),
  );
  aliasCache.set(key, { aliases, mtimeMs, checkedAt: now });
  return aliases;
};

export function providerConfig(id: string): ProviderConfig | undefined {
  return loadConfig().providers?.[id];
}
