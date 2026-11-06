import os from "node:os";
import path from "node:path";

/**
 * The account's home directory.
 *
 * Bun's `os.homedir()` is the platform switch: `USERPROFILE`, then
 * `HOMEDRIVE` + `HOMEPATH`, then `HOME` on Windows, and `$HOME` on POSIX.
 */
export function userHome(): string {
  try {
    const dir = os.homedir();
    if (dir.length > 0) return dir;
  } catch {
    // No profile and no passwd entry.
  }
  return "~";
}

/** `suffix` is a POSIX path under home (`/.claude/projects`). `path.join` picks the separators. */
export function homeJoin(suffix: string): string {
  const relative = suffix.replace(/^[/\\]+/, "");
  const home = userHome();
  return relative.length === 0 ? home : path.join(home, relative);
}
