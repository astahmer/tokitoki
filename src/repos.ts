import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Repo rollup for the `--by repo` dimension.
 *
 * Resolution strategy (cheapest reliable):
 * - walk up from a stored cwd to the nearest ancestor containing `.git`
 *   (dir or worktree file)
 * - no `.git` found → fall back to the first 3 segments under $HOME
 * Display name: path relative to `~/dev/` when applicable (e.g. `emisoup`,
 * `welii/apps/backend` for nested non-git dirs), else home-relative, else
 * basename for paths outside $HOME.
 */

export interface RepoResolution {
  /** Stable grouping key: repo root, or fallback truncated path */
  key: string;
  /** Human-facing display name */
  name: string;
}

type ExistsFn = (p: string) => boolean;

function defaultExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Deepest ancestor of `dir` (inclusive) containing `.git`; null when none. */
export function findRepoRoot(
  dir: string,
  home: string = os.homedir(),
  exists: ExistsFn = defaultExists,
): string | null {
  let current = path.resolve(dir);
  const homeRoot = path.resolve(home);
  // Walk at most until the filesystem root; never escape above $HOME so a
  // stray ~/.git can't claim everything.
  while (current.startsWith(homeRoot)) {
    if (exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** First 3 segments of the home-relative path ("dev/foo/bar"), or basename. */
export function fallbackKey(dir: string, home: string = os.homedir()): string {
  const rel = path.relative(path.resolve(home), path.resolve(dir));
  if (rel === "" || rel.startsWith("..")) return path.basename(path.resolve(dir));
  const segments = rel.split(path.sep).slice(0, 3);
  return segments.join("/");
}

export function repoDisplayName(key: string, home: string = os.homedir()): string {
  const resolved = path.resolve(key);
  const devRoot = path.join(path.resolve(home), "dev");
  if (resolved === devRoot || resolved.startsWith(devRoot + path.sep)) {
    const rel = path.relative(devRoot, resolved);
    return rel.split(path.sep).length > 1 ? `${rel.split(path.sep)[0]}/…` : rel;
  }
  const rel = path.relative(path.resolve(home), resolved);
  if (rel !== "" && !rel.startsWith("..")) return rel;
  return path.basename(resolved);
}

/**
 * Full resolution for a stored projectDir. Pure given `exists`, so tests can
 * stub the filesystem.
 */
export function resolveRepo(
  dir: string,
  home: string = os.homedir(),
  exists: ExistsFn = defaultExists,
): RepoResolution {
  const root = findRepoRoot(dir, home, exists);
  if (root !== null) {
    return { key: root, name: repoDisplayName(root, home) };
  }
  // Fallback naming must not re-resolve against process.cwd, so derive the
  // display straight from the home-relative segments.
  const resolved = path.resolve(dir);
  const rel = path.relative(path.resolve(home), resolved);
  if (rel === "" || rel.startsWith("..")) {
    const base = path.basename(resolved);
    return { key: base, name: base };
  }
  const key = rel.split(path.sep).slice(0, 3).join("/");
  return { key, name: key };
}
