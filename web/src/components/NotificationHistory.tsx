import { Badge, Surface } from "@cloudflare/kumo";

import { fetchNotificationHistory, type NotificationRecord } from "../lib/api";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { EmptyState, Heading, SkeletonBlock } from "../ui";

export function NotificationHistory() {
  const history = useAsyncStaleWhileRevalidate(() => fetchNotificationHistory(), []);
  return (
    <Surface as="section" className="mb-4 p-4">
      <Heading>alert history · what happened and why</Heading>
      {history.state === "loading" ? <SkeletonBlock className="h-28" /> : history.state === "error" ? (
        <p className="text-xs text-kumo-danger">{history.error}</p>
      ) : history.data.records.length === 0 ? (
        <EmptyState message="no local alerts yet — critical quota, reset, budget, and burn warnings will appear here" />
      ) : (
        <div className="space-y-2">
          {history.data.records.map((record) => <AlertRow key={record.id} record={record} />)}
        </div>
      )}
    </Surface>
  );
}

function AlertRow({ record }: { record: NotificationRecord }) {
  return (
    <details className="rounded-md border border-kumo-border bg-kumo-surface p-2.5">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 text-xs">
        <Badge variant={record.title.includes("available") ? "success" : "warning"}>{record.title.replace("tokitoki ", "")}</Badge>
        <span className="min-w-0 flex-1 truncate">{record.body}</span>
        <time className="whitespace-nowrap text-[10px] text-kumo-subtle" dateTime={record.at}>{new Date(record.at).toLocaleString()}</time>
      </summary>
      <p className="mt-2 border-t border-kumo-border pt-2 text-[11px] text-kumo-subtle">Why: {record.reason}</p>
    </details>
  );
}
