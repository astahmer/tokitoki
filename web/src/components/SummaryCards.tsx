import { Badge, Surface } from "@cloudflare/kumo";

import { formatCost, humanCount } from "../lib/fmt";
import type { SummaryPayload } from "../lib/api";

export function SummaryCards({ summary }: { summary: SummaryPayload }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
      <Card label="week cost" value={formatCost(summary.cost)}>
        {summary.prevWeekCost !== null && (
          <Badge variant={summary.cost >= summary.prevWeekCost ? "error" : "success"}>
            prev {formatCost(summary.prevWeekCost)}
          </Badge>
        )}
      </Card>
      <Card label="requests" value={summary.requests.toLocaleString("en-US")} />
      <Card label="sessions" value={summary.sessions.toLocaleString("en-US")} />
      <Card label="tokens" value={humanCount(summary.tokens)} />
      <Card label="%cache" value={`${summary.cachePct}%`} />
      <Card label="burn / day" value={formatCost(summary.burnPerDay)} />
      <Card label="projected month" value={formatCost(summary.projectedMonthEnd)} />
    </div>
  );
}

function Card({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Surface as="div" className="px-4 py-3">
      <div className="text-[10px] tracking-wider text-kumo-subtle uppercase">{label}</div>
      <div className="mt-1 text-xl font-semibold whitespace-nowrap">{value}</div>
      {children !== undefined && <div className="mt-0.5 whitespace-nowrap">{children}</div>}
    </Surface>
  );
}
