import { Badge, Surface } from "@cloudflare/kumo";

import { fetchSources, type MachinePresence as MachinePresenceT } from "../lib/api";
import { humanCount } from "../lib/fmt";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { Heading, SkeletonBlock } from "../ui";

export function SourcesView() {
  const sources = useAsyncStaleWhileRevalidate(() => fetchSources(), []);
  return (
    <Surface as="section" className="mb-4 p-4">
      <Heading>data sources · where usage comes from</Heading>
      {sources.state === "loading" ? (
        <SkeletonBlock className="h-64" />
      ) : sources.state === "error" ? (
        <p className="text-xs text-kumo-danger">{sources.error}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <MachinesStrip machines={sources.data.machines} />
          {sources.data.providers.map((p) => (
            <Surface key={p.id} as="div" className="p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{p.label}</span>
                <Badge variant={p.trackedFiles > 0 ? "success" : "neutral"}>
                  {p.trackedFiles > 0 ? `${p.filesFound} files · ${humanCount(p.events)} events` : "not found"}
                </Badge>
                {p.envVar !== undefined && (
                  <span title={`override root with ${p.envVar}`}>
                    <Badge variant="neutral">{p.envVar}</Badge>
                  </span>
                )}
              </div>
              {p.roots.length > 0 && (
                <div className="mb-1 font-mono text-[11px] text-kumo-subtle">{p.roots.join(" · ")}</div>
              )}
              {p.accounts.length > 0 ? (
                <div className="text-xs">
                  accounts:{" "}
                  {p.accounts.map((a) => (
                    <span key={a.key} className="mr-2 whitespace-nowrap">
                      {a.email !== null ? `${a.key} <${a.email}>` : a.key}
                    </span>
                  ))}
                </div>
              ) : null}
              {p.models.length > 0 && (
                <div className="mt-1 truncate text-xs text-kumo-subtle" title={p.models.join(", ")}>
                  models: {p.models.slice(0, 8).join(", ")}
                  {p.models.length > 8 ? ` +${p.models.length - 8}` : ""}
                </div>
              )}
            </Surface>
          ))}
        </div>
      )}
    </Surface>
  );
}

const STATE_COLOR: Record<string, string> = {
  active: "bg-emerald-500",
  recent: "bg-amber-500",
  stale: "bg-neutral-400 dark:bg-neutral-600",
};

/** One dot + label per known machine, from sync heartbeats. */
function MachinesStrip({ machines }: { machines: MachinePresenceT[] }) {
  if (machines.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-kumo-border p-2 text-xs">
      <span className="font-medium">machines</span>
      {machines.map((m) => (
        <span key={m.machineId} className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            className={`inline-block size-2 rounded-full ${STATE_COLOR[m.state] ?? STATE_COLOR.stale}`}
            title={`${m.state} · last seen ${new Date(m.ts).toLocaleString()}`}
          />
          <span>{m.host}</span>
          <span className="text-kumo-subtle">{m.state}</span>
        </span>
      ))}
    </div>
  );
}
