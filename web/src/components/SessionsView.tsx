import { useEffect, useState } from "react";

import { Badge, Button, Input, Surface, Table } from "@cloudflare/kumo";

import {
  fetchSessionDetail,
  fetchSessions,
  fetchSessionsSearch,
  type SessionDetailPayload,
  type SessionRow,
  type SessionSearchRow,
} from "../lib/api";
import { cachePct, formatCost, humanCount } from "../lib/fmt";
import type { WindowSelection } from "../lib/api";
import { EmptyState, Heading, SkeletonBlock } from "../ui";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";

const PAGE_SIZE = 50;

/**
 * Sessions landing view: full-text search across every harness's conversations,
 * falling back to the cost-first leaderboard when no query is typed. Shares the
 * dashboard's window / provider / account filters so both views stay in sync.
 */
export function SessionsView({
  win,
  providers,
  account,
}: {
  win: WindowSelection;
  providers: string[];
  account?: string;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SessionRow | undefined>(undefined);

  // Debounce: index updates are incremental but still touch disk on edit.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    if (query === debounced) return;
    const t = setTimeout(() => {
      setDebounced(query);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [query, debounced]);

  const searching = submitted.trim().length > 0;
  const sessions = useAsyncStaleWhileRevalidate(
    () =>
      searching
        ? // Leaderboard isn't rendered while searching; skip the fetch.
          Promise.resolve({ window: { since: "", until: null, label: "" }, rows: [] })
        : fetchSessions({ providers, account, top: 25, ...win }),
    [win.from ?? "", win.to ?? "", win.last ?? "", providers.join("|"), account],
  );

  return (
    <>
      <Surface as="section" className="mb-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <Heading>sessions · click a row for its request timeline</Heading>
        </div>
        <div className="mb-3 flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setSubmitted(query);
            }}
            placeholder='search all conversations — try "kumo treemap" or "migrate pds"'
            className="max-w-md"
          />
          {searching && (
            <Button variant="secondary" onClick={() => { setSubmitted(""); setQuery(""); }}>
              clear
            </Button>
          )}
        </div>
        {searching ? (
          <SearchResults query={submitted} page={page} setPage={setPage} providers={providers} win={win} onSelect={setSelected} selectedId={selected?.sessionId} />
        ) : sessions.state === "loading" ? (
          <SkeletonBlock className="h-72" />
        ) : sessions.state === "error" ? (
          <p className="text-xs text-kumo-danger">{sessions.error}</p>
        ) : sessions.data.rows.length === 0 ? (
          <EmptyState message="no sessions recorded in this window — try widening the range or clearing filters" />
        ) : (
          <SessionTable rows={sessions.data.rows} selected={selected?.sessionId} onSelect={setSelected} />
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

function SearchResults({
  query,
  page,
  setPage,
  providers,
  win,
  onSelect,
  selectedId,
}: {
  query: string;
  page: number;
  setPage: (p: number) => void;
  providers: string[];
  win: WindowSelection;
  onSelect: (row: SessionRow) => void;
  selectedId?: string;
}) {
  const res = useAsyncStaleWhileRevalidate(
    () => fetchSessionsSearch({ q: query, page, providers, ...win }),
    [query, String(page), win.from ?? "", win.to ?? "", win.last ?? "", providers.join("|")],
  );

  if (res.state === "loading") return <SkeletonBlock className="h-72" />;
  if (res.state === "error") return <p className="text-xs text-kumo-danger">{res.error}</p>;
  const data = res.data;
  if (data.rows.length === 0) {
    return <EmptyState message={`no sessions match “${query}” — check spelling or widen the range`} />;
  }
  return (
    <div>
      <p className="mb-2 text-[11px] text-kumo-subtle">
        {res.refreshing ? "searching…" : `${data.rows.length} match${data.rows.length === 1 ? "" : "es"}`} · search {data.searchMs}ms · indexed {data.indexedFiles} changed file(s)
        {data.hasMore && ` · page ${data.page}`}
      </p>
      <div className="space-y-2">
        {data.rows.map((r) => (
          <SearchHit key={`${r.provider}/${r.sessionId}`} row={r} onClick={() => onSelect(toRow(r))} dimmed={selectedId === r.sessionId} />
        ))}
      </div>
      {(page > 1 || data.hasMore) && (
        <div className="mt-3 flex items-center gap-2">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← prev
          </Button>
          <span className="text-[11px] text-kumo-subtle">page {page}</span>
          <Button variant="secondary" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>
            next →
          </Button>
        </div>
      )}
    </div>
  );
}

/** Render [[match]] markers as highlighted spans. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return (
    <span>
      {parts.map((p, i) =>
        p.startsWith("[[") && p.endsWith("]]") ? (
          <mark key={i} className="rounded-sm bg-kumo-warning/30 px-0.5 text-inherit">
            {p.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

function SearchHit({ row: r, onClick, dimmed }: { row: SessionSearchRow; onClick: () => void; dimmed?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-md border border-kumo-border/60 p-2.5 text-left transition-colors hover:bg-kumo-recessed ${dimmed ? "bg-kumo-recessed/60" : "bg-kumo-surface"}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs font-medium">
          {r.title.length > 0 ? r.title : "(no title)"}
        </span>
        <span className="whitespace-nowrap text-right text-[10px] text-kumo-subtle">
          {r.requests.toLocaleString("en-US")} req · {humanCount(r.totalTokens)} tok · {r.cachePct}% cache · {formatCost(r.costUsd)}
        </span>
      </div>
      <div className="mt-0.5 line-clamp-2 text-[11px] text-kumo-subtle">
        <Snippet text={r.snippet} />
      </div>
      <div className="mt-1 flex gap-2 text-[10px] text-kumo-faint">
        <span>{r.startedAt.slice(0, 16).replace("T", " ")}</span>
        <Badge variant="neutral">{r.provider}</Badge>
        <span className="truncate">{r.accountKey}</span>
        {r.repos[0] && <span className="truncate">{r.repos[0]}</span>}
        <span className="ml-auto truncate opacity-70">{r.sessionId}</span>
      </div>
    </button>
  );
}

function toRow(r: SessionSearchRow): SessionRow {
  return {
    provider: r.provider,
    sessionId: r.sessionId,
    startedAt: r.startedAt || new Date().toISOString(),
    accountKey: r.accountKey,
    models: [],
    repos: r.repos,
    requests: r.requests,
    totalTokens: r.totalTokens,
    cachePct: r.cachePct,
    costUsd: r.costUsd,
  };
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
        <Table.Header>
          <Table.Row>
            {["date", "provider", "account", "model(s)", "repo", "req", "tokens", "%cache", "cost"].map(
              (h, i) => (
                <Table.Head
                  key={h}
                  className={`text-[10px] tracking-wider whitespace-nowrap uppercase select-none ${
                    i >= 5 ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </Table.Head>
              ),
            )}
          </Table.Row>
        </Table.Header>
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
          <Table.Header>
            {["#", "time", "model", "input", "output", "cache-rd", "%cache", "cost", "run.tok"].map(
              (h, i) => (
                <Table.Head
                  key={h}
                  className={`text-[10px] tracking-wider whitespace-nowrap uppercase select-none ${
                    i >= 3 ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </Table.Head>
              ),
            )}
          </Table.Header>
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
