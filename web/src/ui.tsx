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
      className="rounded-full font-mono"
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
  return pct > 0 ? (
    <Badge variant="error" className="ml-1.5">
      ▲{pct}%
    </Badge>
  ) : (
    <Badge variant="success" className="ml-1.5">
      ▼{Math.abs(pct)}%
    </Badge>
  );
}

/** Plan-quota gauge bar (replaces the cost cell for matched accounts). */
export function Gauge({ frac, label }: { frac: number; label: string }) {
  const clamped = Math.max(0, Math.min(1, frac));
  const pct = Math.round(clamped * 100);
  return (
    <div className="flex min-w-36 flex-col gap-0.5">
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
