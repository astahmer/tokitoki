import fs from "node:fs";

import { loadConfig, configPath, type TokitokiConfig } from "./config.ts";
import { UserError } from "./errors.ts";

/**
 * [ui] visibility toggles: which providers/accounts appear on which surface.
 * Entries are provider ids ("codex") or provider:account pairs
 * ("codex:codex:plus" → matched by suffix on accountKey).
 */

export interface UiToggleTarget {
  /** Provider id. */
  provider: string;
  /** Account key when the entry is provider:account (undefined = all). */
  accountKey?: string;
}

export function parseToggleTarget(raw: string): UiToggleTarget {
  const at = raw.indexOf(":");
  if (at <= 0) return { provider: raw };
  return { provider: raw.slice(0, at), accountKey: raw.slice(at + 1) };
}

function matches(target: UiToggleTarget, provider: string, accountKey: string): boolean {
  if (target.provider !== provider) return false;
  if (target.accountKey === undefined) return true;
  return accountKey.endsWith(target.accountKey) || accountKey.includes(target.accountKey);
}

/** True when the pair passes the ui filter for a surface. */
export function isVisibleOn(
  config: TokitokiConfig,
  surface: "menubar" | "dashboard",
  provider: string,
  accountKey: string,
): boolean {
  const hidden = config.ui?.hidden?.[surface] ?? [];
  for (const raw of hidden) {
    if (matches(parseToggleTarget(raw), provider, accountKey)) return false;
  }
  if (surface === "menubar") {
    const only = config.ui?.menubarProviders ?? [];
    if (only.length > 0 && !only.includes(provider)) return false;
  }
  return true;
}

function saveUiMutator(mutate: (cfg: TokitokiConfig) => void): void {
  // loadConfig reads json or toml; writes always go to the canonical path.
  const cfg = loadConfig();
  mutate(cfg);
  const p = configPath();
  fs.mkdirSync(p.replace(/[/][^/]+$/, ""), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

export function setSurfaceVisibility(
  targetRaw: string,
  surface: "menubar" | "dashboard",
  visible: boolean,
): void {
  const target = parseToggleTarget(targetRaw);
  saveUiMutator((cfg) => {
    cfg.ui ??= {};
    cfg.ui.hidden ??= {};
    const list = new Set(cfg.ui.hidden[surface] ?? []);
    // Removing any conflicting explicit entries keeps intent unambiguous.
    for (const existing of [...list]) {
      if (matches(parseToggleTarget(existing), target.provider, target.accountKey ?? "")) list.delete(existing);
    }
    if (!visible) list.add(targetRaw);
    cfg.ui.hidden[surface] = [...list].sort();
  });
}

export function setMenubarProviders(providers: string[]): void {
  saveUiMutator((cfg) => {
    cfg.ui ??= {};
    cfg.ui.menubarProviders = providers;
  });
}

export function assertValidSurface(surface: string | undefined): asserts surface is "menubar" | "dashboard" {
  if (surface !== "menubar" && surface !== "dashboard") {
    throw new UserError(`invalid --surface '${surface}'`, "tokitoki ui --hide codex --surface menubar");
  }
}
