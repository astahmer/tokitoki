import { Switch } from "@base-ui-components/react/switch";
import type { ReactNode } from "react";

/** shadcn-style primitives, hand-rolled on Tailwind tokens + Base UI Switch. */

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-edge bg-panel p-4 ${className}`}>{children}</section>
  );
}

export function Pill({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-accent bg-accent text-bg"
          : "border-edge bg-panel text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function DeltaBadge({ current, previous }: { current: number; previous?: number }) {
  if (previous === undefined || previous <= 0) {
    if (current > 0 && previous !== undefined && previous <= 0) {
      return <span className="ml-1.5 text-[10px] text-good">▲new</span>;
    }
    return null;
  }
  if (current <= 0) return <span className="ml-1.5 text-[10px] text-bad">▼100%</span>;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return null;
  return pct > 0 ? (
    <span className="ml-1.5 text-[10px] text-bad">▲{pct}%</span>
  ) : (
    <span className="ml-1.5 text-[10px] text-good">▼{Math.abs(pct)}%</span>
  );
}

/** Plan-quota gauge bar (replaces the cost cell for matched accounts). */
export function Gauge({ frac, label }: { frac: number; label: string }) {
  const clamped = Math.max(0, Math.min(1, frac));
  const pct = Math.round(clamped * 100);
  const color = pct >= 90 ? "bg-bad" : pct >= 70 ? "bg-warn" : "bg-accent";
  return (
    <div className="flex min-w-32 items-center gap-2">
      <div className="relative h-2 flex-1 overflow-hidden rounded bg-edge">
        <div className={`absolute inset-y-0 left-0 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] whitespace-nowrap text-muted">
        {pct}% {label}
      </span>
    </div>
  );
}

/** Persisted toggle (localStorage), Base UI Switch under the hood. */
export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted select-none">
      <Switch.Root
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        className="relative h-4 w-8 shrink-0 rounded-full border border-edge bg-panel2 transition-colors data-checked:border-accent data-checked:bg-accent/40"
      >
        <Switch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-muted transition-transform data-checked:translate-x-4 data-checked:bg-accent" />
      </Switch.Root>
      {label}
    </label>
  );
}
