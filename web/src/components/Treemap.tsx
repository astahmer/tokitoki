import { useMemo, useState } from "react";

import { squarify, type TreemapItem } from "../lib/treemap";

export type { TreemapItem };
import { Surface } from "@cloudflare/kumo";

/**
 * Squarified treemap (Bruls, Huizing & van Wijk) over spend shares —
 * the "mosaic" idea from token-billing: rectangle area = share of cost.
 * No chart dependency; plain absolutely-positioned divs.
 */

const PALETTE = [
  "#6ea8fe",
  "#7ee2b8",
  "#ffd166",
  "#f4978e",
  "#c3a6ff",
  "#8ad4eb",
  "#f6a5c0",
  "#9bd35f",
];

function colorFor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function Treemap({ items, formatValue }: {
  items: TreemapItem[];
  formatValue?: (item: TreemapItem) => string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const active = useMemo(() => {
    if (selected === null) return items;
    const parent = items.find((i) => i.label === selected);
    return parent?.children && parent.children.length > 0 ? parent.children : items;
  }, [items, selected]);

  const placed = useMemo(() => squarify(active), [active]);
  if (placed.length === 0) return null;
  const max = Math.max(...active.map((i) => i.value), 1);

  return (
    <Surface className="p-2">
      {selected !== null && (
        <button
          type="button"
          className="mb-2 text-xs opacity-70 hover:opacity-100 underline"
          onClick={() => setSelected(null)}
        >
          ← back to all
        </button>
      )}
      <div className="relative h-72 w-full overflow-hidden rounded-md">
        {placed.map((p) => {
          const hasChildren = p.item.children !== undefined && p.item.children.length > 0;
          return (
            <button
              type="button"
              key={p.item.label}
              title={`${p.item.label} · ${formatValue ? formatValue(p.item) : String(p.item.value)}`}
              onClick={() => hasChildren && setSelected(selected === p.item.label ? null : p.item.label)}
              className={`absolute flex flex-col justify-end overflow-hidden p-1.5 text-left transition-[filter]
                ${hasChildren ? "cursor-pointer hover:brightness-110" : "cursor-default"}`}
              style={{
                left: `${(p.x / 1) * 100}%`,
                top: `${(p.y / 1) * 100}%`,
                width: `${p.w * 100}%`,
                height: `${p.h * 100}%`,
                background: colorFor(p.item.label),
                opacity: 0.35 + 0.65 * (p.item.value / max),
              }}
            >
              {p.w > 0.12 && p.h > 0.12 && (
                <>
                  <span className="truncate text-xs font-medium text-black/80">{p.item.label}</span>
                  <span className="truncate text-[10px] text-black/60">
                    {formatValue ? formatValue(p.item) : String(p.item.value)}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </Surface>
  );
}
