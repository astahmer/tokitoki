import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { fetchTable } from "../lib/api";
import type { WindowSelection } from "../lib/api";
import { Heading, Panel, SkeletonBlock } from "../ui";
import { useMemo } from "react";
import { Treemap, type TreemapItem } from "./Treemap";

/**
 * Spend mosaic: cost share per tool, grouped under each provider.
 * Data comes from the standard table endpoint with by=tool; the
 * provider-qualified bucket names ("codex/shell:rtk") are split into
 * a two-level treemap — click a provider to zoom into its tools.
 */
export function ToolsView({ win, providers }: {
  win: WindowSelection;
  providers: string[];
}) {
  const table = useAsyncStaleWhileRevalidate(
    () => fetchTable({ by: "tool", providers, ...win }),
    [JSON.stringify(win), providers.join(",")],
  );

  const items: TreemapItem[] = useMemo(() => {
    if (table.state !== "ok") return [];
    const byProvider = new Map<string, TreemapItem>();
    for (const row of table.data.rows) {
      const slash = row.bucket.indexOf("/");
      const provider = slash > 0 ? row.bucket.slice(0, slash) : row.bucket;
      const tool = slash > 0 ? row.bucket.slice(slash + 1) : "(all)";
      const item: TreemapItem = { label: tool, value: row.costUsd };
      const parent = byProvider.get(provider);
      if (parent) {
        parent.value += row.costUsd;
        parent.children!.push(item);
      } else {
        byProvider.set(provider, { label: provider, value: row.costUsd, children: [item] });
      }
    }
    return Array.from(byProvider.values());
  }, [table]);

  if (table.state === "loading") {
    return <SkeletonBlock className="h-72 w-full" />;
  }
  if (table.state === "error") {
    return <p className="text-xs text-kumo-danger">{table.error}</p>;
  }
  if (items.length === 0) {
    return (
      <Panel>
        <Heading>spend mosaic</Heading>
        <p className="text-sm opacity-60">no usage in this window — widen it or run `tokitoki scan`.</p>
      </Panel>
    );
  }

  return (
    <Panel>
      <Heading>spend mosaic · area = share of cost, click a provider to drill into its tools</Heading>
      <Treemap
        items={items}
        formatValue={(i) => {
          const total = items.find((p) => p.label === i.label)?.value ?? (i.children !== undefined ? i.value : 0);
          const parentTotal =
            i.children === undefined
              ? // tool leaf: share of its provider's total
                (items.find((p) => p.children?.some((c) => c.label === i.label))?.value ?? 0)
              : total;
          const pct =
            parentTotal > 0 && i.children === undefined
              ? ` · ${Math.round((i.value / parentTotal) * 100)}% of provider`
              : "";
          return `$${i.value.toFixed(2)}${pct}`;
        }}
      />
    </Panel>
  );
}
