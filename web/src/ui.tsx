import type { ReactNode } from "react";

import { Badge, Banner, Button, Meter, Surface, Switch, Text, Tooltip } from "@cloudflare/kumo";

/**
 * Shared page primitives, built on Cloudflare Kumo. Layout stays Tailwind;
 * interactive/semantic components are Kumo so theming + a11y come for free.
 */

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <Surface className={`p-4 ${className}`} as="section">
      {children}
    </Surface>
  );
}

/** Single-select chip (period / dimension / account tabs). */
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
    <Button
      size="xs"
      variant={active ? "primary" : "outline"}
      className="rounded-full font-mono transition-colors duration-150"
      title={title}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function DeltaBadge({ current, previous }: { current: number; previous?: number }) {
  if (previous === undefined || previous <= 0) {
    if (current > 0 && previous !== undefined && previous <= 0) {
      return (
        <Badge variant="success" className="ml-1.5">
          ▲new
        </Badge>
      );
    }
    return null;
  }
  if (current <= 0) {
    return (
      <Badge variant="error" className="ml-1.5">
        ▼100%
      </Badge>
    );
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return null;
  // Neutral arrow for small moves; semantic color only past ±10% so a normal
  // week-over-week wobble doesn't read as an alarm (ui-review item 31).
  const significant = Math.abs(pct) >= 10;
  const variant = !significant ? "neutral" : pct > 0 ? "error" : "success";
  return (
    <Badge variant={variant} className="ml-1.5">
      {pct > 0 ? "▲" : "▼"}
      {Math.abs(pct)}%
    </Badge>
  );
}

/** Plan-quota gauge bar (replaces the cost cell for matched accounts). */
export function Gauge({
  frac,
  label,
  tooltip,
}: {
  frac: number;
  label: string;
  /** Exact usage-vs-cap text for hover; falls back to label. */
  tooltip?: string;
}) {
  const clamped = Math.max(0, Math.min(1, frac));
  const pct = Math.round(clamped * 100);
  return (
    <div className="flex min-w-36 flex-col gap-0.5" title={tooltip ?? `${pct}% ${label}`}>
      <Meter
        value={pct}
        label={`${pct}% ${label}`}
        showValue={false}
        aria-label={`plan quota ${pct}%`}
        className="[&_[data-slot]]:hidden"
      />
      <span className="text-[10px] whitespace-nowrap text-kumo-subtle">
        {pct}% {label}
      </span>
    </div>
  );
}

/** Persisted toggle (localStorage), Kumo Switch under the hood. */
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
    <Switch
      size="sm"
      label={label}
      checked={checked}
      onCheckedChange={(next) => onChange(next === true)}
    />
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <span className="mb-3 block text-[10px] tracking-wider text-kumo-subtle uppercase">
      {children}
    </span>
  );
}

export function ErrorNote({ error, hint }: { error: string; hint?: string }) {
  return (
    <Banner variant="error" title={error}>
      {hint ?? ""}
    </Banner>
  );
}

/** Small info tooltip wrapper for dense table headers. */
export function Info({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip content={text}>
      <span className="cursor-help">{children}</span>
    </Tooltip>
  );
}

/**
 * Loading placeholders built on Kumo tokens. Rendered only on first load —
 * refetches keep stale data visible (stale-while-revalidate) so toggling
 * filters or emails never collapses/shifts the layout.
 */
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-lg bg-kumo-recessed ${className}`}
    />
  );
}

export function SummaryCardsSkeleton() {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
      {Array.from({ length: 7 }, (_, i) => (
        <SkeletonBlock key={i} className="h-[68px]" />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 8, cols = 10 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      <SkeletonBlock className="h-5" />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-2">
          {Array.from({ length: cols }, (_, c) => (
            <SkeletonBlock key={c} className={`h-4 flex-1 ${r === 0 ? "opacity-60" : ""}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Friendly empty state with an actionable suggestion. */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-8 text-center">
      <span className="text-2xl opacity-40">∅</span>
      <p className="max-w-md whitespace-pre-line text-xs text-kumo-subtle">{message}</p>
    </div>
  );
}
