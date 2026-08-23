import fs from "node:fs";

import type { Provider } from "./providers/types.ts";
import { PROVIDERS } from "./providers/index.ts";
import { loadCursors } from "./store.ts";
import type { EventCache } from "./cache.ts";
import { accountEmailMap } from "./accounts.ts";

/**
 * Provenance for `tokitoki sources` + /api/sources: where each provider's
 * data comes from, how much of it we see, and whether scans are current.
 */

export interface ProviderSource {
  id: string;
  label: string;
  /** Configured env override name, when the harness supports one. */
  envVar?: string;
  /** Effective roots scanned on the last/current discovery pass. */
  roots: string[];
  filesFound: number;
  /** Files with a persisted scan cursor (i.e. seen by at least one scan). */
  trackedFiles: number;
  /** Tracked files whose cursor offset still matches their size. */
  upToDateFiles: number;
  events: number;
  accounts: Array<{ key: string; email: string | null }>;
  models: string[];
}

export function collectSources(cache: EventCache, providers: Provider[] = PROVIDERS): ProviderSource[] {
  const cursors = loadCursors();
  const stats = cache.providerStats();

  return providers.map((p) => {
    const roots = p.discoverRoots();
    const files = roots.flatMap((r) => p.listFiles(r));
    const filesSet = new Set(files);

    let tracked = 0;
    let upToDate = 0;
    for (const [file, entry] of Object.entries(cursors)) {
      if (!filesSet.has(file)) continue;
      tracked++;
      try {
        if (entry.offset >= fs.statSync(file).size) upToDate++;
      } catch {
        // file vanished since the scan — count it as stale
      }
    }

    const stat = stats.get(p.id);
    const accounts = [...(stat?.accounts ?? [])].sort();
    // Emails resolve per (account → provider) so attribution stays unambiguous.
    const providersByKey = new Map(accounts.map((key) => [key, new Set([p.id])]));
    const emails = accountEmailMap(accounts, providersByKey);

    return {
      id: p.id,
      label: p.label,
      envVar: p.envVar,
      roots,
      filesFound: files.length,
      trackedFiles: tracked,
      upToDateFiles: upToDate,
      events: stat?.events ?? 0,
      accounts: accounts.map((key) => ({ key, email: emails.get(key) ?? null })),
      models: [...(stat?.models ?? [])].sort(),
    };
  });
}

/** Human-readable provenance table (one block per provider). */
export function renderSources(sources: ProviderSource[]): string {
  if (sources.length === 0) return "no providers registered";
  const lines: string[] = [];
  for (const s of sources) {
    const rootNote = s.envVar !== undefined ? ` (\`${s.envVar}\`)` : "";
    lines.push(`${s.id} — ${s.label}`);
    for (const root of s.roots) lines.push(`  root: ${root}${rootNote}`);
    lines.push(
      `  files: ${s.filesFound} found · ${s.trackedFiles} tracked · ${s.upToDateFiles} up-to-date`,
    );
    const accounts = s.accounts
      .map((a) => (a.email !== null ? `${a.key} <${a.email}>` : a.key))
      .join(", ");
    lines.push(
      `  events: ${s.events.toLocaleString("en-US")} · accounts: ${accounts.length > 0 ? accounts : "(none)"}`,
    );
    lines.push(`  models: ${s.models.length > 0 ? s.models.join(", ") : "(none)"}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
