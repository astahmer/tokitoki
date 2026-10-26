import type { TrackingSummary } from "./api.ts";

export function trackingPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${value.toFixed(1)}%` : "—";
}

export function trackingModelLabel(value: string): string {
  // Never surface arbitrary paths, emails, control characters or key-like IDs.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) || /^sk-/i.test(value)) return "other model identifier";
  return value.length > 40 ? `${value.slice(0, 37)}…` : value;
}

export function trackingRequestCounts(data: TrackingSummary): Array<{ label: string; value: number }> {
  return [
    { label: "Reported", value: data.reportedRequests },
    { label: "Estimated", value: data.estimatedRequests },
    { label: "Unpriced", value: data.unpricedRequests },
    { label: "Legacy unknown", value: data.unknownRequests },
  ];
}

export function trackingComposition(data: TrackingSummary): Array<{ label: string; value: number }> {
  return [
    { label: "Input", value: data.inputTokens },
    { label: "Output", value: data.outputTokens },
    { label: "Cache read", value: data.cacheReadTokens },
    { label: "Cache write", value: data.cacheWriteTokens },
  ];
}
