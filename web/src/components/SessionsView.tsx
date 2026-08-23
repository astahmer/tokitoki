import { useState } from "react";

import { Badge, Surface, Table } from "@cloudflare/kumo";

import {
  fetchSessionDetail,
  fetchSessions,
  type SessionDetailPayload,
  type SessionRow,
} from "../lib/api";
import { cachePct, formatCost, humanCount } from "../lib/fmt";
import { Heading, SkeletonBlock } from "../ui";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";

/**
 * Session leaderboard + request-timeline drill-down. Shares the dashboard's
 * period / provider / account filters so both views stay in sync.
 */
export function SessionsView({
  period,
  providers,
  account,
}: {
  period: string;
  providers: string[];
  account?: string;
}) {
  const sessions = useAsyncStaleWhileRevalidate(
    () => fetchSessions({ period, providers, account, top: 25 }),
    [period, providers.join("|"), account],
  );
  const [selected, setSelected] = useState<SessionRow | undefined>(undefined);

  return (
    <>
      <Surface as="section" className="mb-4 p-4">
        <Heading>sessions · costliest first</Heading>
        {sessions.state === "loading" ? (
          <SkeletonBlock className="h-72" />
        ) : sessions.state === "error" ? (
          <p className="text-xs text-kumo-danger">{sessions.error}</p>
        ) : sessions.data.rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-kumo-subtle">
            no sessions recorded in this window
          </p>
        ) : (
          <SessionTable
            rows={sessions.data.rows}
            selected={selected?.sessionId}
            onSelect={setSelected}
          />
        )}
      </Surface>
      {selected !== undefined && (
        <Surface as="section" className="p-4">
          <SessionDetail provider={selected.provider} sessionId={selected.sessionId} />
        </Surface>
      )}
    </>
  );
}

function SessionTable({
  rows,
  onSelect,
  selected,
}: {
  rows: SessionRow[];
  onSelect: (row: SessionRow) => void;
  selected?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-xs">
        <Table.Head>
          {["date", "provider", "account", "model(s)", "repo", "req", "tokens", "%cache", "cost"].map(
            (h, i) => (
              <Table.Header
                key={h}
                className={`text-[10px] tracking-wider whitespace-nowrap uppercase select-none ${
                  i >= 5 ? "text-right" : "text-left"
                }`}
              >
                {h}
              </Table.Header>
            ),
          )}
        </Table.Head>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row
              key={`${r.provider}/${r.sessionId}`}
              className={`cursor-pointer ${selected === r.sessionId ? "bg-kumo-recessed" : ""}`}
              onClick={() => onSelect(r)}
              title={`open ${r.sessionId}`}
            >
              <Table.Cell className="whitespace-nowrap">
                {r.startedAt.slice(5, 16).replace("T", " ")}
              </Table.Cell>
              <Table.Cell className="whitespace-nowrap">{r.provider}</Table.Cell>
              <Table.Cell className="max-w-40 truncate">{r.accountKey}</Table.Cell>
              <Table.Cell className="max-w-52 truncate">{r.models.join(", ")}</Table.Cell>
              <Table.Cell className="max-w-40 truncate">{r.repos[0] ?? "(no repo)"}</Table.Cell>
              <Table.Cell className="text-right">{r.requests.toLocaleString("en-US")}</Table.Cell>
              <Table.Cell className="text-right">{humanCount(r.totalTokens)}</Table.Cell>
              <Table.Cell className="text-right">{r.cachePct}%</Table.Cell>
              <Table.Cell className="text-right">
                {formatCost(r.costUsd)}
                {r.costUsd === 0 && r.totalTokens > 0 && (
                  <Badge variant="neutral" className="ml-1.5">
                    plan
                  </Badge>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

function SessionDetail({ provider, sessionId }: { provider: string; sessionId: string }) {
  const detail = useAsyncStaleWhileRevalidate(
    () => fetchSessionDetail(provider, sessionId),
    [provider, sessionId],
  );

  return (
    <>
      <Heading>
        session · {sessionId} · {provider} ·{" "}
        {detail.state === "ok" ? `${detail.data.events.length} requests` : "…"}
      </Heading>
      {detail.state === "loading" ? (
        <SkeletonBlock className="h-48" />
      ) : detail.state === "error" ? (
        <p className="text-xs text-kumo-danger">{detail.error}</p>
      ) : (
        <Timeline payload={detail.data} />
      )}
    </>
  );
}

function Timeline({ payload }: { payload: SessionDetailPayload }) {
  const events = payload.events;
  const maxTokens = Math.max(1, ...events.map((e) => e.inputTokens + e.outputTokens + e.cacheReadTokens));
  let running = 0;
  const rows = events.map((e) => {
    running += e.inputTokens + e.outputTokens + e.cacheReadTokens;
    return { ...e, running };
  });
  const totalCost = events.reduce((s, e) => s + e.costUsd, 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-kumo-subtle">
        <span>total cost {formatCost(totalCost)}</span>
        <span>final tokens {humanCount(running)}</span>
        <span>
          %cache{" "}
          {cachePct(
            events.reduce((s, e) => s + e.inputTokens, 0),
            events.reduce((s, e) => s + e.cacheReadTokens, 0),
          )}
          %
        </span>
      </div>
      {/* Token volume per request — the shape of a session at a glance. */}
      <div className="flex h-12 items-end gap-[2px]" aria-hidden="true">
        {events.map((e, i) => {
          const tokens = e.inputTokens + e.outputTokens + e.cacheReadTokens;
          return (
            <div
              key={i}
              title={`${e.ts.slice(11, 19)} ${e.model}: ${tokens} tok, ${formatCost(e.costUsd)}`}
              style={{ height: `${Math.max(2, (tokens / maxTokens) * 100)}%` }}
              className="min-w-[3px] flex-1 rounded-t-sm bg-kumo-info/70"
            />
          );
        })}
      </div>
      <div className="max-h-96 overflow-y-auto">
        <Table className="w-full text-xs">
          <Table.Head>
            {["#", "time", "model", "input", "output", "cache-rd", "%cache", "cost", "run.tok"].map(
              (h, i) => (
                <Table.Header
                  key={h}
                  className={`text-[10px] tracking-wider whitespace-nowrap uppercase select-none ${
                    i >= 3 ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </Table.Header>
              ),
            )}
          </Table.Head>
          <Table.Body>
            {rows.map((r, i) => (
              <Table.Row key={i}>
                <Table.Cell>{i + 1}</Table.Cell>
                <Table.Cell className="whitespace-nowrap">{r.ts.slice(11, 19)}</Table.Cell>
                <Table.Cell className="max-w-52 truncate">{r.model}</Table.Cell>
                <Table.Cell className="text-right">{humanCount(r.inputTokens)}</Table.Cell>
                <Table.Cell className="text-right">{humanCount(r.outputTokens)}</Table.Cell>
                <Table.Cell className="text-right">{humanCount(r.cacheReadTokens)}</Table.Cell>
                <Table.Cell className="text-right">{cachePct(r.inputTokens, r.cacheReadTokens)}%</Table.Cell>
                <Table.Cell className="text-right">{formatCost(r.costUsd)}</Table.Cell>
                <Table.Cell className="text-right">{humanCount(r.running)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    </div>
  );
}
