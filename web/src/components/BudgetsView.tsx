import { Surface } from "@cloudflare/kumo";

import { fetchBudgets } from "../lib/api";
import { formatCost } from "../lib/fmt";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { EmptyState, Heading, SkeletonBlock } from "../ui";

/** Budget gauge bars for every configured scope×pattern + firing alerts. */
export function BudgetsView() {
  const budgets = useAsyncStaleWhileRevalidate(() => fetchBudgets(), []);

  return (
    <Surface as="section" className="mb-4 p-4">
      <Heading>budgets · spend vs configured caps</Heading>
      {budgets.state === "loading" ? (
        <SkeletonBlock className="h-40" />
      ) : budgets.state === "error" ? (
        <p className="text-xs text-kumo-danger">{budgets.error}</p>
      ) : !budgets.data.configured ? (
        <EmptyState
          message={
            'no budgets configured — add a [budgets] section to ~/.config/tokitoki/config.toml\ne.g. budgets.monthly = 500 · [budgets.accounts."codex*"] monthly = 200'
          }
        />
      ) : (
        <>
          {budgets.data.alerts.length > 0 && (
            <div className="mb-3 rounded-md border border-kumo-warning/40 bg-kumo-warning/10 px-3 py-2 text-xs">
              {budgets.data.alerts.map((a, i) => (
                <div key={i} className="whitespace-nowrap">
                  ⚠ {Math.round(a.pct * 100)}% of {a.scope} budget used · {a.pattern}:{" "}
                  {formatCost(a.spend)} / {formatCost(a.cap)}
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {budgets.data.rows.map((r) => {
              const pct = Math.min(100, Math.round(r.pct * 100));
              return (
                <Surface
                  key={`${r.scope}-${r.pattern}`}
                  as="div"
                  className="p-3"
                  title={`${formatCost(r.spend)} of ${formatCost(r.cap)} ${r.scope} cap (${(r.pct * 100).toFixed(1)}%)`}
                >
                  <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium">{r.pattern}</span>
                    <span className="text-kumo-subtle">{r.scope}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-kumo-recessed">
                    <div
                      className={`h-full rounded-full ${
                        r.level >= 100 ? "bg-kumo-danger" : r.level >= 80 ? "bg-kumo-warning" : "bg-kumo-success"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] text-kumo-subtle">
                    <span>{formatCost(r.spend)}</span>
                    <span>
                      {pct}% / {formatCost(r.cap)}
                    </span>
                  </div>
                </Surface>
              );
            })}
          </div>
        </>
      )}
    </Surface>
  );
}
