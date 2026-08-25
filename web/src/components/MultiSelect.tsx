import { useEffect, useMemo, useRef, useState } from "react";

import { Pill } from "../ui";

/**
 * Compact searchable multi-select combobox (reui.io filter-bar style).
 * Closed state renders one pill showing the selection count; open state
 * shows a search input + checkbox list. Hand-rolled: reui.io's registry
 * components are license-gated (401 without a key), so this adapts the same
 * interaction pattern to the repo's Kumo primitives.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  width = "w-56",
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q.length === 0 ? options : options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  const activeCount = selected.length;

  return (
    <div className="relative" ref={ref}>
      <Pill
        active={activeCount > 0}
        onClick={() => setOpen((o) => !o)}
        title={`${label}: ${activeCount === 0 ? "all" : selected.join(", ")}`}
      >
        {label}
        {activeCount > 0 ? ` · ${activeCount}` : ""} ▾
      </Pill>
      {open && (
        <div
          className={`absolute left-0 top-full z-30 mt-1 ${width} rounded-lg border border-edge bg-kumo-surface p-2 shadow-lg`}
          role="listbox"
          aria-label={label}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`search ${label}…`}
            className="mb-1.5 w-full rounded-md border border-edge bg-transparent px-2 py-1 text-xs"
          />
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 && <p className="px-2 py-1 text-[11px] text-muted">no matches</p>}
            {filtered.map((opt) => {
              const checked = selected.includes(opt);
              return (
                <button
                  key={opt}
                  role="option"
                  aria-selected={checked}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-kumo-recessed"
                  onClick={() =>
                    onChange(checked ? selected.filter((s) => s !== opt) : [...selected, opt])
                  }
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                      checked ? "border-transparent bg-kumo-info text-white" : "border-edge"
                    }`}
                  >
                    {checked ? "✓" : ""}
                  </span>
                  <span className="truncate">{opt}</span>
                </button>
              );
            })}
          </div>
          {activeCount > 0 && (
            <button
              className="mt-1 w-full rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-kumo-recessed"
              onClick={() => onChange([])}
            >
              clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
