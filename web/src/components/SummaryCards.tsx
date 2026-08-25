import { Badge, Surface } from "@cloudflare/kumo";

import { formatCost, humanCount } from "../lib/fmt";
import type { SummaryPayload } from "../lib/api";

export function SummaryCards({ summary }: { summary: SummaryPayload }) {
  const w = summary.window;
  const until = w.until === null ? "now" : new Date(w.until).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  const since = new Date(w.since).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  // Cost label tracks the actual window ("week cost", "30d cost", …) instead
  // of a hardcoded name that drifts from the selected range.
  const costLabel = `${w.label} cost`;
  return (
    <div className="mb-4">
      <div className="mb-2 text-xs text-kumo-subtle">
        period: {since} → {until} ({w.label})
      </div>
      {/* Hero: money first and big, like openusage; the rest are secondary. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Surface as="div" className="px-4 py-3 lg:col-span-2">
          <div className="text-[10px] tracking-wider text-kumo-subtle uppercase">{costLabel}</div>
          <div className="mt-1 text-3xl font-semibold whitespace-nowrap tabular-nums">{formatCost(summary.cost)}</div>
          <div className="mt-0.5 whitespace-nowrap">
            {summary.prevWeekCost !== null && (
              <Badge variant={summary.cost >= summary.prevWeekCost ? "error" : "success"}>
                prev {formatCost(summary.prevWeekCost)}
              </Badge>
            )}
          </div>
        </Surface>
        <Card label="burn / day" value={formatCost(summary.burnPerDay)} />
        <Card label="projected month" value={formatCost(summary.projectedMonthEnd)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="requests" value={summary.requests.toLocaleString("en-US")} />
        <Card label="sessions" value={summary.sessions.toLocaleString("en-US")} />
        <Card label="tokens" value={humanCount(summary.tokens)} />
        <Card label="%cache" value={`${summary.cachePct}%`} />
      </div>
    </div>
  );
}

function Card({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Surface as="div" className="px-3 py-2">
      <div className="text-[10px] tracking-wider text-kumo-subtle uppercase">{label}</div>
      <div className="mt-1 text-sm font-semibold whitespace-nowrap tabular-nums">{value}</div>
    </Surface>
  );
}
