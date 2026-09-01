import { loadConfig, writeConfig, type TokitokiConfig } from "./config.ts";
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
  // Suffix only, per the documented contract above — a substring match
  // would also hide an unrelated account that merely contains the target
  // text somewhere in the middle (e.g. hiding "codex:plus" hiding
  // "plus-team-extra" too).
  return accountKey.endsWith(target.accountKey);
}

/** True when the pair passes the ui filter for a surface. */
export function isVisibleOn(
  config: TokitokiConfig,
  surface: "menubar" | "dashboard",
  provider: string,
  accountKey: string,
): boolean {
  if (surface === "menubar") return isCardVisibleOn(config, provider, accountKey);
  const hidden = config.ui?.hidden?.dashboard ?? [];
  for (const raw of hidden) {
    if (matches(parseToggleTarget(raw), provider, accountKey)) return false;
  }
  return true;
}

/**
 * Popover-CARD visibility (menubar surface): entries in ui.hidden.menubar
 * hide accounts from the popover cards. The status-bar STRIP has its own
 * switch — see isPreviewVisible.
 */
export function isCardVisibleOn(config: TokitokiConfig, provider: string, accountKey: string): boolean {
  const hidden = config.ui?.hidden?.menubar ?? [];
  for (const raw of hidden) {
    if (matches(parseToggleTarget(raw), provider, accountKey)) return false;
  }
  const only = config.ui?.menubarProviders ?? [];
  if (only.length > 0 && !only.includes(provider)) return false;
  return true;
}

/**
 * STATUS-BAR STRIP visibility: ui.previewHidden lists UPSTREAM provider ids
 * (openai, claude, opencode, openrouter, ...) whose marks are hidden from
 * the strip while their cards stay visible.
 */
export function isPreviewVisible(config: TokitokiConfig, upstreamProvider: string): boolean {
  return !(config.ui?.previewHidden ?? []).includes(upstreamProvider);
}

function saveUiMutator(mutate: (cfg: TokitokiConfig) => void): void {
  const cfg = loadConfig();
  mutate(cfg);
  writeConfig(cfg);
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

/** Well-known menubar popover cards, in default display order. */
export const MENUBAR_CARDS = [
  "limits",
  "usage",
  "spend",
  "harness",
  "activity",
  "anomalies",
  "repos",
  "tools",
] as const;

/** Native popover destinations. The first four are shown in the header; the
 * remainder are grouped under More. Keeping this list here gives the CLI and
 * Swift client one canonical validation boundary. */
export const MENUBAR_TABS = [
  "overview",
  "quotas",
  "tokens",
  "reports",
  "sources",
  "mcp",
  "settings",
] as const;

export function setMenubarTabs(ids: string[]): void {
  const order: string[] = [];
  for (const id of ids) {
    if ((MENUBAR_TABS as readonly string[]).includes(id) && !order.includes(id)) order.push(id);
  }
  for (const id of MENUBAR_TABS) if (!order.includes(id)) order.push(id);
  saveUiMutator((cfg) => {
    cfg.ui ??= {};
    cfg.ui.menubarTabs = order;
  });
}

/**
 * Persist the popover card layout from a Customize-sheet save:
 * "limits:1,tools:0,..." — argument order = display order, value = visible.
 * Unknown ids are ignored; known ids missing from the input keep defaults
 * appended at the end (visible).
 */
export function setMenubarCards(spec: string): void {
  const parsed: Array<{ id: string; hidden: boolean }> = [];
  for (const part of spec.split(",")) {
    const [id, flag] = part.split(":");
    if (id === undefined || !(MENUBAR_CARDS as readonly string[]).includes(id)) continue;
    parsed.push({ id, hidden: flag !== "1" });
  }
  const seen = new Set(parsed.map((p) => p.id));
  for (const id of MENUBAR_CARDS) {
    if (!seen.has(id)) parsed.push({ id, hidden: false });
  }
  saveUiMutator((cfg) => {
    cfg.ui ??= {};
    cfg.ui.menubarCards = parsed.map((p) => (p.hidden ? `!${p.id}` : p.id));
  });
}

/** Toggle opt-in background quota polling. */
export function setPollEnabled(enabled: boolean): void {
  saveUiMutator((cfg) => {
    cfg.poll ??= {};
    cfg.poll.enabled = enabled;
  });
}

/** Persist the account-card display order (menubar popover drag & drop). */
export function setMenubarAccountOrder(ids: string[]): void {
  saveUiMutator((cfg) => {
    cfg.ui ??= {};
    cfg.ui.menubarAccountOrder = ids;
  });
}

/** Effective card layout: every known id in display order with hidden flags. */
export function menubarCardLayout(config: TokitokiConfig): Array<{ id: string; hidden: boolean }> {
  const saved = config.ui?.menubarCards ?? [];
  const byId = new Map<string, boolean>();
  const order: string[] = [];
  for (const raw of saved) {
    const id = raw.startsWith("!") ? raw.slice(1) : raw;
    if (!(MENUBAR_CARDS as readonly string[]).includes(id) || order.includes(id)) continue;
    order.push(id);
    byId.set(id, !raw.startsWith("!"));
  }
  for (const id of MENUBAR_CARDS) {
    if (!order.includes(id)) {
      order.push(id);
      byId.set(id, true);
    }
  }
  return order.map((id) => ({ id, hidden: !(byId.get(id) ?? true) }));
}

export function assertValidSurface(surface: string | undefined): asserts surface is "menubar" | "dashboard" {
  if (surface !== "menubar" && surface !== "dashboard") {
    throw new UserError(`invalid --surface '${surface}'`, "tokitoki ui --hide codex --surface menubar");
  }
}
