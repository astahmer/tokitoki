import { fetchTracking, type TrackingPayload, type WindowSelection } from "../lib/api";
import { formatCost, humanCount } from "../lib/fmt";
import { trackingComposition, trackingModelLabel, trackingPercent, trackingRequestCounts } from "../lib/tracking";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { Panel, SkeletonBlock } from "../ui";

/** The parent keys this view by window + refresh so a failed range change
 * cannot leave another period's quality visible as if it were current. */
export function TrackingQuality({ win }: { win: WindowSelection }) {
  const result = useAsyncStaleWhileRevalidate(() => fetchTracking(win), [JSON.stringify(win)]);
  if (result.state === "loading") return <SkeletonBlock className="mb-4 h-28" />;
  if (result.state === "error") return <Panel className="mb-4"><p className="text-xs text-kumo-subtle">Tracking quality unavailable for this period. Refresh to retry.</p></Panel>;
  // Older servers may omit provenance entirely. Do not turn absence into zeros.
  if (typeof result.data?.reportedRequests !== "number") return null;
  return <TrackingQualitySummary data={result.data} />;
}

export function TrackingQualitySummary({ data }: { data: TrackingPayload }) {
  const models = data.unpricedModels ?? [];
  return (
    <Panel className="mb-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold">Tracking quality</h2>
        <span className="text-[11px] text-kumo-subtle">{data.window.label} · all accounts and harnesses</span>
      </div>
      {data.requests === 0 ? <p className="text-xs text-kumo-subtle">No requests recorded in this period.</p> : (
        <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <span>{humanCount(data.totalTokens)} tokens</span>
          {trackingComposition(data).map(({ label, value }) => <span key={label} className="text-kumo-subtle">{label}: {humanCount(value)}</span>)}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {typeof data.reportedTokens === "number" && typeof data.estimatedTokens === "number" && typeof data.unknownTokens === "number" && (
          <div className="col-span-2 md:col-span-4">
            <dt className="text-[11px] text-kumo-subtle">Token counts</dt>
            <dd className="text-xs">{humanCount(data.reportedTokens)} reported · {humanCount(data.estimatedTokens)} estimated{data.unknownTokens > 0 ? ` · ${humanCount(data.unknownTokens)} source unknown` : ""}</dd>
            {data.estimatedTokens > 0 && <p className="mt-1 text-[11px] text-kumo-subtle">Estimated from visible text (characters ÷ 4); hidden context is not counted.</p>}
          </div>
        )}
        {trackingRequestCounts(data).map(({ label, value }) => (
          <div key={label}><dt className="text-[11px] text-kumo-subtle">{label} requests</dt><dd className="font-mono text-sm">{value.toLocaleString("en-US")}</dd></div>
        ))}
        <div><dt className="text-[11px] text-kumo-subtle">Pricing coverage</dt><dd>{trackingPercent(data.pricingCoveragePercent)}</dd></div>
        <div><dt className="text-[11px] text-kumo-subtle">Cached input</dt><dd>{trackingPercent(data.cachedInputPercent)}</dd></div>
        <div className="col-span-2"><dt className="text-[11px] text-kumo-subtle">Known / estimated API usage value</dt><dd>{formatCost(data.costUsd)}</dd></div>
      </dl>
      <p className="mt-3 text-[11px] text-kumo-subtle">Request counts by cost source. API-rate estimates are not a subscription bill. Unpriced and legacy unknown usage is not free. Pricing coverage counts reported + estimated requests. Cached input = cache read ÷ (input + cache read + cache write).</p>
      {models.length > 0 && <p className="mt-1 break-words text-[11px] text-kumo-subtle">Unpriced models: {models.slice(0, 4).map(trackingModelLabel).join(", ")}{models.length > 4 ? ` (+${models.length - 4} more)` : ""}</p>}
    </Panel>
  );
}
