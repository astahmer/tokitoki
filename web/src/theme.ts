export type ThemeMode = "light" | "dark";

const KEY = "tokitoki.mode";

export function resolveInitialMode(): ThemeMode {
  // URL override (?theme=dark|light) wins, then stored preference, then system.
  const qs = new URLSearchParams(window.location.search).get("theme");
  if (qs === "light" || qs === "dark") return qs;
  const stored = localStorage.getItem(KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyMode(mode: ThemeMode): void {
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
}

export function persistMode(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
}
