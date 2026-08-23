import type { TokitokiConfig } from "./config.ts";
import { loadConfig } from "./config.ts";

/** Rolling window boundaries in ISO-8601 UTC. */
export function sinceIsoFor(period: "day" | "week" | "month"): string {
  const now = new Date();
  if (period === "day") {
    // Local calendar day start
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return d.toISOString();
  }
  const ms = period === "week" ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000;
  return new Date(now.getTime() - ms).toISOString();
}

export function resolveExtraFiles(config?: TokitokiConfig): string[] {
  const cfg = config ?? loadConfig();
  const extra = cfg.extraEventFiles ?? [];
  return extra.filter((f) => typeof f === "string" && f.length > 0);
}
