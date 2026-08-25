export type ThemeMode = "light" | "dark" | "system";

const KEY = "tokitoki.mode";
/** Cycle order for the single toggle button. */
export const MODE_CYCLE: ThemeMode[] = ["light", "dark", "system"];

function systemMode(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function normalize(raw: string | null): ThemeMode | null {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
}

export function resolveInitialMode(): ThemeMode {
  // URL override (?theme=dark|light|system) wins, then stored preference,
  // then system.
  const qs = normalize(new URLSearchParams(window.location.search).get("theme"));
  if (qs !== null) return qs;
  return normalize(localStorage.getItem(KEY)) ?? "system";
}

/** Effective light/dark after resolving "system" against the OS preference. */
export function effectiveMode(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? systemMode() : mode;
}

export function applyMode(mode: ThemeMode): void {
  const resolved = effectiveMode(mode);
  document.documentElement.dataset.mode = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function persistMode(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
}

/** Follow OS changes while in "system" mode. Returns a cleanup fn. */
export function watchSystemMode(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const handler = (): void => onChange();
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
