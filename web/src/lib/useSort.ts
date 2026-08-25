import { useMemo, useState } from "react";

/**
 * Shared table-sorting state: click-to-sort columns with tri-state cycling
 * (asc → desc → back to the column default) and direction indicators.
 */
export interface SortState<K extends string> {
  key: K;
  dir: "asc" | "desc";
}

export function useSort<K extends string>(
  defaultKey: K,
  defaultDir: "asc" | "desc" = "desc",
): {
  sort: SortState<K>;
  toggle: (key: K) => void;
  /** Sorted copy of rows; comparators receive (row, key). */
  sorted: <T>(rows: T[], value: (row: T, key: K) => number | string) => T[];
} {
  const [sort, setSort] = useState<SortState<K>>({ key: defaultKey, dir: defaultDir });

  const toggle = (key: K): void => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : // New column starts desc for numeric-ish data (most-recent/highest first).
          { key, dir: "desc" },
    );
  };

  const sorted = useMemo(
    () =>
      <T,>(rows: T[], value: (row: T, key: K) => number | string): T[] => {
        const { key, dir } = sort;
        const mult = dir === "asc" ? 1 : -1;
        return [...rows].sort((a, b) => {
          const va = value(a, key);
          const vb = value(b, key);
          if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
          return String(va).localeCompare(String(vb)) * mult;
        });
      },
    [sort],
  );

  return { sort, toggle, sorted };
}

/** Sort indicator glyph for a column header. */
export function sortIndicator(sortKey: string, activeKey: string, dir: "asc" | "desc"): string {
  return sortKey === activeKey ? (dir === "asc" ? "▲" : "▼") : "";
}
