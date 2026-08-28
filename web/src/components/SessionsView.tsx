import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, Button, Input, Surface, Table } from "@cloudflare/kumo";

import {
  fetchSessionDetail,
  fetchSessions,
  fetchSessionsSearch,
  type SessionDetailPayload,
  type SessionEvent,
  type SessionRow,
  type SessionSearchRow,
} from "../lib/api";
import { cachePct, formatCost, formatDurationSeconds, humanCount } from "../lib/fmt";
import type { WindowSelection } from "../lib/api";
import { EmptyState, Heading, SkeletonBlock, TableSkeleton } from "../ui";
import { sortIndicator, useSort } from "../lib/useSort";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";

const PAGE_SIZE = 25;

/**
 * Sessions landing view: full-text search across every harness's conversations,
 * falling back to the cost-first leaderboard when no query is typed. Shares the
 * dashboard's window / provider / account filters so both views stay in sync.
 */
export function SessionsView({
  win,
  providers,
  account,
  initialSessionProvider,
  initialSessionId,
}: {
  win: WindowSelection;
  providers: string[];
  account?: string;
  initialSessionProvider?: string;
  initialSessionId?: string;
}) {
  // Search text + page live in the URL (?q=, ?page=) so searched views are
  // shareable and pagination survives a tab switch.
  const initialQ = new URLSearchParams(window.location.search).get("q") ?? "";
  const initialPage = Math.max(1, Number(new URLSearchParams(window.location.search).get("page") ?? "1") || 1);
  const [query, setQuery] = useState(initialQ);
  const [submitted, setSubmitted] = useState(initialQ);
  const [page, setPage] = useState(initialPage);
  const [selected, setSelected] = useState<SessionRow | undefined>(() => (
    initialSessionProvider !== undefined && initialSessionId !== undefined
      ? {
          provider: initialSessionProvider,
          sessionId: initialSessionId,
          accountKey: "",
          startedAt: "",
          requests: 0,
          models: [],
          repos: [],
          totalTokens: 0,
          cachePct: 0,
          costUsd: 0,
        }
      : undefined
  ));
  const searchRef = useRef<HTMLInputElement>(null);

  const syncUrl = useCallback((q: string, pg: number): void => {
    const url = new URL(window.location.href);
    if (q.length > 0) url.searchParams.set("q", q);
    else url.searchParams.delete("q");
    if (pg > 1) url.searchParams.set("page", String(pg));
    else url.searchParams.delete("page");
    window.history.replaceState(null, "", url);
  }, []);

  const selectSession = useCallback((row: SessionRow): void => {
    setSelected(row);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "sessions");
    url.searchParams.set("provider", row.provider);
    url.searchParams.set("session", row.sessionId);
    window.history.replaceState(null, "", url);
  }, []);

  const clearSelectedSession = useCallback((): void => {
    setSelected(undefined);
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    url.searchParams.delete("provider");
    window.history.replaceState(null, "", url);
  }, []);

  // "/" focuses the search box from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Debounce: index updates are incremental but still touch disk on edit.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    if (query === debounced) return;
    const t = setTimeout(() => {
      setDebounced(query);
      setSubmitted(query);
      setPage(1);
      syncUrl(query, 1);
    }, 350);
    return () => clearTimeout(t);
  }, [query, debounced]);

  const searching = submitted.trim().length > 0;
  const sessions = useAsyncStaleWhileRevalidate(
    () =>
      searching
        ? // Leaderboard isn't rendered while searching; skip the fetch.
          Promise.resolve({ window: { since: "", until: null, label: "" }, rows: [] })
        : fetchSessions({ providers, account, top: PAGE_SIZE, ...win }),
    [win.from ?? "", win.to ?? "", win.last ?? "", providers.join("|"), account],
  );

  return selected === undefined ? (
    <Surface as="section" className="mb-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <Heading>sessions · click a row for its request timeline</Heading>
        </div>
        <div className="mb-3 flex items-center gap-2">
          <div className="relative w-full max-w-md">
            <span aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-muted">
              ⌕
            </span>
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSubmitted(query);
                if (e.key === "Escape") {
                  setQuery("");
                  setSubmitted("");
                }
              }}
              placeholder='search all conversations — press / to focus'
              className="max-w-md pl-6"
            />
          </div>
          {searching && (
            <Button variant="secondary" onClick={() => { setSubmitted(""); setQuery(""); syncUrl("", 1); }}>
              clear
            </Button>
          )}
        </div>
        {searching ? (
          <SearchResults query={submitted} page={page} setPage={setPage} providers={providers} win={win} onSelect={selectSession} />
        ) : sessions.state === "loading" ? (
          <TableSkeleton rows={8} cols={7} />
        ) : sessions.state === "error" ? (
          <p className="text-xs text-kumo-danger">{sessions.error}</p>
        ) : sessions.data.rows.length === 0 ? (
          <EmptyState message="no sessions recorded in this window — try widening the range or clearing filters" />
        ) : (
          <SessionTable rows={sessions.data.rows} selected={undefined} onSelect={selectSession} />
        )}
      </Surface>
  ) : (
    <Surface as="section" className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Button variant="secondary" onClick={clearSelectedSession}>← sessions</Button>
        <span className="truncate text-[11px] text-kumo-subtle">{selected.title || selected.sessionId}</span>
      </div>
      <SessionDetail provider={selected.provider} sessionId={selected.sessionId} />
    </Surface>
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

  if (res.state === "loading") return <TableSkeleton rows={8} cols={5} />;
  if (res.state === "error") return <p className="text-xs text-kumo-danger">{res.error}</p>;
  const data = res.data;
  if (data.rows.length === 0) {
    return <EmptyState message={`no sessions match “${query}” — check spelling or widen the range`} />;
  }
  return (
    <div>
      <p className="mb-2 text-[11px] text-kumo-subtle">
        {res.refreshing ? "searching…" : `${data.rows.length} match${data.rows.length === 1 ? "" : "es"}`} · search {data.searchMs}ms · indexed {data.indexedFiles} changed file(s)
        {(data.skippedLargeFiles ?? 0) > 0 && ` · ${data.skippedLargeFiles} large file(s) not indexed`}
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

const SESSION_COLUMNS: Array<{ key: string; label: string; numeric?: boolean }> = [
  { key: "startedAt", label: "started" },
  { key: "lastRequestAt", label: "last active" },
  { key: "provider", label: "provider" },
  { key: "accountKey", label: "account" },
  { key: "models", label: "model(s)" },
  { key: "repo", label: "repo" },
  { key: "requests", label: "req", numeric: true },
  { key: "totalTokens", label: "tokens", numeric: true },
  { key: "cachePct", label: "%cache", numeric: true },
  { key: "costUsd", label: "cost", numeric: true },
];

function SessionTable({
  rows,
  onSelect,
  selected,
}: {
  rows: SessionRow[];
  onSelect: (row: SessionRow) => void;
  selected?: string;
}) {
  const { sort, toggle, sorted } = useSort("lastRequestAt", "desc");
  const value = (r: SessionRow, key: string): number | string => {
    switch (key) {
      case "lastRequestAt": return r.lastRequestAt ?? r.startedAt;
      case "requests": return r.requests;
      case "totalTokens": return r.totalTokens;
      case "cachePct": return r.cachePct;
      case "costUsd": return r.costUsd;
      case "models": return r.models.join(", ");
      case "repo": return r.repos[0] ?? "";
      default: return String((r as unknown as Record<string, unknown>)[key] ?? "");
    }
  };
  const view = sorted(rows, value);
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-xs">
        <Table.Header>
          <Table.Row>
            {SESSION_COLUMNS.map((c) => (
              <Table.Head
                key={c.key}
                aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                onClick={() => toggle(c.key as never)}
                title={`sort by ${c.label}`}
                className={`cursor-pointer text-[10px] tracking-wider whitespace-nowrap uppercase select-none hover:text-kumo-default ${
                  c.numeric === true ? "text-right" : "text-left"
                } ${sort.key === c.key ? "text-kumo-default" : ""}`}
              >
                {c.label}{" "}
                <span aria-hidden="true">{sortIndicator(c.key, sort.key, sort.dir)}</span>
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {view.map((r) => (
            <Table.Row
              key={`${r.provider}/${r.sessionId}`}
              className={`cursor-pointer ${selected === r.sessionId ? "bg-kumo-recessed" : ""}`}
              onClick={() => onSelect(r)}
              title={`open ${r.sessionId}`}
            >
              <Table.Cell className="whitespace-nowrap">
                {r.startedAt.slice(5, 16).replace("T", " ")}
                <div className="max-w-56 truncate text-[10px] text-kumo-subtle" title={r.title ?? r.snippet}>
                  {r.title?.trim() || r.snippet?.trim() || "Conversation preview unavailable"}
                </div>
              </Table.Cell>
              <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                {(r.lastRequestAt ?? r.startedAt).slice(5, 16).replace("T", " ")}
              </Table.Cell>
              <Table.Cell className="whitespace-nowrap">{r.provider}</Table.Cell>
              <Table.Cell className="max-w-40 truncate">{r.accountKey}</Table.Cell>
              <Table.Cell className="max-w-52 truncate">
                {r.models
                  .map((m) =>
                    // Single-model sessions whose model name embeds the
                    // provider prefix read as duplication — strip it.
                    r.models.length === 1 && m.toLowerCase().startsWith(`${r.provider}-`)
                      ? m.slice(r.provider.length + 1)
                      : m,
                  )
                  .join(", ")}
              </Table.Cell>
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
    () => fetchSessionDetail(provider, sessionId, { limit: 40, offset: 0 }),
    [provider, sessionId],
  );
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestCount = detail.state === "ok" && Number.isFinite(detail.data.eventsTotal)
    ? detail.data.eventsTotal.toLocaleString("en-US")
    : "—";

  useEffect(() => {
    if (detail.state !== "ok") return;
    setEvents(detail.data.events);
    setEventsHasMore(detail.data.eventsHasMore);
  }, [detail.state, detail.state === "ok" ? detail.data.events : undefined]);

  const loadMore = async (): Promise<void> => {
    if (loadingMore || !eventsHasMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchSessionDetail(provider, sessionId, { limit: 40, offset: events.length });
      setEvents((current) => [...current, ...next.events]);
      setEventsHasMore(next.eventsHasMore);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <Heading>
        session · {sessionId} · {provider} ·{" "}
        {detail.state === "ok" ? `${requestCount} requests` : "…"}
      </Heading>
      {detail.state === "loading" ? (
        <SkeletonBlock className="h-48" />
      ) : detail.state === "error" ? (
        <p className="text-xs text-kumo-danger">{detail.error}</p>
      ) : (
        <div className="space-y-4">
          {detail.data.conversation !== null && detail.data.conversation.body.length > 0 && (
            <details open className="rounded-md border border-kumo-border/60 bg-kumo-surface p-3">
              <summary className="cursor-pointer text-xs font-medium">conversation</summary>
              <ConversationBody body={detail.data.conversation.body} title={detail.data.conversation.title} />
            </details>
          )}
          <Timeline payload={{ ...detail.data, events }} />
          {eventsHasMore && (
            <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "loading…" : `load next 40 requests (${events.length} of ${detail.data.eventsTotal})`}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string; level: number }
  | { kind: "code"; text: string; language?: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; text: string; ordered: boolean };

type ConversationRole = "user" | "assistant" | "tool" | "message";

interface ConversationGroup {
  role: ConversationRole;
  timestamp?: string;
  blocks: MarkdownBlock[];
}

function ConversationBody({ body, title }: { body: string; title?: string }) {
  const toolCounts = new Map<string, number>();
  let visibleLines = body.split("\n").filter((line) => {
    const trimmed = line.trim();
    let name: string | undefined;
    if (trimmed.toLowerCase() === "### tool call") name = "tool call";
    else if (trimmed.startsWith("[tool:")) name = trimmed.slice(6).split("]", 1)[0];
    else if (trimmed.startsWith("tools.") || trimmed.startsWith("functions.")) name = trimmed.split("(", 1)[0];
    if (name !== undefined && name.length > 0) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      return false;
    }
    return true;
  });
  const normalizedTitle = title?.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalizedTitle !== undefined && normalizedTitle.length > 0) {
    const first = visibleLines.findIndex((line) => line.trim().length > 0);
    if (first >= 0 && visibleLines[first]!.replace(/^[#>*-]+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase() === normalizedTitle) {
      visibleLines = visibleLines.slice(0, first).concat(visibleLines.slice(first + 1));
    }
  }
  const blocks = parseMarkdownBlocks(visibleLines);
  const groups = groupConversationBlocks(blocks);
  return (
    <div className="mt-3 max-h-[40rem] space-y-3 overflow-auto text-xs leading-relaxed text-kumo-subtle overscroll-contain">
      {toolCounts.size > 0 && (
        <details className="rounded-md border border-kumo-border/60 bg-kumo-recessed/50 p-2">
          <summary className="cursor-pointer font-medium text-kumo-default">
            tools used · {[...toolCounts.values()].reduce((sum, count) => sum + count, 0)}
          </summary>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            {[...toolCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => (
              <span key={name}>{name} · {count}</span>
            ))}
          </div>
        </details>
      )}
      {groups.map((group, i) => <ConversationGroup key={i} group={group} />)}
    </div>
  );
}

function roleFromHeading(block: MarkdownBlock): { role: ConversationRole; timestamp?: string } | undefined {
  if (block.kind !== "heading") return undefined;
  const match = /^(user|assistant|tool call)(?:\s+·\s+(.+))?$/i.exec(block.text.trim());
  if (match === null) return undefined;
  const role = match[1]!.toLowerCase();
  const timestamp = match[2]?.trim();
  if (role === "user") return { role: "user", timestamp };
  if (role === "assistant") return { role: "assistant", timestamp };
  if (role === "tool call") return { role: "tool", timestamp };
  return undefined;
}

function groupConversationBlocks(blocks: MarkdownBlock[]): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  let current: ConversationGroup = { role: "message", blocks: [] };
  const flush = (): void => {
    if (current.blocks.length > 0) groups.push(current);
    current = { role: current.role, blocks: [] };
  };
  for (const block of blocks) {
    const heading = roleFromHeading(block);
    if (heading !== undefined) {
      flush();
      current = { role: heading.role, timestamp: heading.timestamp, blocks: [] };
    } else {
      current.blocks.push(block);
    }
  }
  flush();
  return groups;
}

function ConversationGroup({ group }: { group: ConversationGroup }) {
  const label = group.role === "tool" ? "tool call" : group.role;
  const tone = group.role === "user"
    ? "ml-5 border-kumo-info/40 bg-kumo-info/10"
    : group.role === "assistant"
      ? "mr-5 border-kumo-border/70 bg-kumo-surface"
      : group.role === "tool"
        ? "border-kumo-warning/40 bg-kumo-warning/5"
        : "border-kumo-border/60 bg-kumo-surface/60";
  const content = <div className="space-y-3">{group.blocks.map((block, i) => <ConversationBlock key={i} block={block} />)}</div>;
  if (group.role === "tool") {
    return <details className={`rounded-lg border px-3 py-2 ${tone}`}>
      <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase tracking-wider text-kumo-warning">
        <span>⚒ {label} · {group.blocks.length} part{group.blocks.length === 1 ? "" : "s"}</span>
        {group.timestamp && <time className="ml-2 normal-case tracking-normal text-kumo-faint">{group.timestamp}</time>}
      </summary>
      <div className="mt-2">{content}</div>
    </details>;
  }
  return <section className={`rounded-lg border px-3 py-2 ${tone}`} aria-label={`${label} message`}>
    <div className={`mb-1 flex items-baseline gap-2 text-[10px] font-semibold uppercase tracking-wider ${group.role === "user" ? "text-kumo-info" : "text-kumo-success"}`}>
      <span>{group.role === "user" ? "↗" : "✦"} {label}</span>
      {group.timestamp && <time className="normal-case tracking-normal text-kumo-faint">{group.timestamp}</time>}
    </div>
    {content}
  </section>;
}

function parseMarkdownBlocks(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | undefined;
  let codeLanguage: string | undefined;
  let list: string[] = [];
  let listOrdered = false;
  const flushParagraph = (): void => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length > 0) blocks.push({ kind: "list", text: list.join("\n"), ordered: listOrdered });
    list = [];
  };
  const flushAll = (): void => { flushParagraph(); flushList(); };
  for (const line of lines) {
    const trimmed = line.trim();
    const fence = /^```\s*([\w-]+)?\s*$/.exec(trimmed);
    if (code !== undefined) {
      if (fence !== null) {
        blocks.push({ kind: "code", text: code.join("\n"), language: codeLanguage });
        code = undefined;
        codeLanguage = undefined;
      } else code.push(line);
      continue;
    }
    if (fence !== null) {
      flushAll();
      code = [];
      codeLanguage = fence[1];
      continue;
    }
    if (trimmed.length === 0) { flushAll(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading !== null) {
      flushAll();
      blocks.push({ kind: "heading", text: heading[2]!, level: heading[1]!.length });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushAll();
      blocks.push({ kind: "quote", text: trimmed.replace(/^>\s?/, "") });
      continue;
    }
    const item = /^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(trimmed);
    if (item !== null) {
      const ordered = /^\d/.test(trimmed);
      if (list.length > 0 && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      list.push(item[1]!);
      continue;
    }
    if (list.length > 0) flushList();
    paragraph.push(line);
  }
  if (code !== undefined) blocks.push({ kind: "code", text: code.join("\n"), language: codeLanguage });
  flushAll();
  return blocks;
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\)]+\))/g);
  return <>{parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-kumo-recessed px-1 py-0.5 font-mono text-[11px]">{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link !== null && /^(https?:|mailto:)/.test(link[2]!)) return <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="text-kumo-info underline">{link[1]}</a>;
    return <span key={i}>{part}</span>;
  })}</>;
}

function ConversationBlock({ block }: { block: MarkdownBlock }) {
  if (block.kind === "code") return <div className="overflow-hidden rounded-md border border-kumo-border/60 bg-kumo-recessed">
    {block.language && <div className="border-b border-kumo-border/50 px-3 py-1 text-[10px] uppercase tracking-wider text-kumo-subtle">{block.language}</div>}
    <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-kumo-default">{block.text}</pre>
  </div>;
  if (block.kind === "heading") {
    const Tag = block.level <= 2 ? "h3" : "h4";
    const role = block.text.trim().toLowerCase();
    if (role === "user" || role === "assistant" || role === "tool call") {
      const tone = role === "user" ? "border-kumo-info/50 bg-kumo-info/10 text-kumo-info" : role === "assistant" ? "border-kumo-success/50 bg-kumo-success/10 text-kumo-success" : "border-kumo-warning/50 bg-kumo-warning/10 text-kumo-warning";
      return <div className={`flex items-center gap-2 border-b px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${tone}`}>
        <span aria-hidden="true">{role === "user" ? "↗" : role === "assistant" ? "✦" : "⚒"}</span>
        <span>{role}</span>
      </div>;
    }
    return <Tag className="border-b border-kumo-border/50 pb-1 font-semibold text-kumo-default"><InlineMarkdown text={block.text} /></Tag>;
  }
  if (block.kind === "quote") return <blockquote className="border-l-2 border-kumo-info/60 pl-3 text-kumo-default"><InlineMarkdown text={block.text} /></blockquote>;
  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return <Tag className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5 text-kumo-default`}>{block.text.split("\n").map((item, i) => <li key={i}><InlineMarkdown text={item} /></li>)}</Tag>;
  }
  return <p className="whitespace-pre-wrap break-words text-kumo-default"><InlineMarkdown text={block.text} /></p>;
}

function Timeline({ payload }: { payload: SessionDetailPayload }) {
  const [hovered, setHovered] = useState<{ index: number; x: number; y: number } | null>(null);
  const events = payload.events;
  const maxTokens = Math.max(1, ...events.map((e) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens));
  let running = 0;
  const rows = events.map((e) => {
    running += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    return { ...e, running };
  });
  const totalCost = events.reduce((s, e) => s + e.costUsd, 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-kumo-subtle">
        <span>total cost {formatCost(totalCost)}</span>
        <span>loaded tokens {humanCount(running)}</span>
        <span>requests {events.length.toLocaleString("en-US")} / {payload.eventsTotal.toLocaleString("en-US")}</span>
        <span>
          %cache{" "}
          {cachePct(
            events.reduce((s, e) => s + e.inputTokens, 0),
            events.reduce((s, e) => s + e.cacheReadTokens, 0),
          )}
          %
        </span>
        <span>cache lifetime ≈ {formatDurationSeconds(payload.cacheDuration.estimatedSeconds)} · {payload.cacheDuration.confidence} confidence</span>
      </div>
      {/* Token volume per request — the shape of a session at a glance. */}
      <div className="relative pt-8">
        {hovered !== null && events[hovered.index] !== undefined && (
          <div
            className="pointer-events-none fixed z-50 w-max max-w-[min(24rem,90vw)] -translate-x-1/2 -translate-y-full rounded-md border border-kumo-border bg-kumo-elevated px-2.5 py-2 text-[11px] shadow-lg"
            style={{ left: hovered.x, top: hovered.y }}
          >
            <div className="font-medium text-kumo-default">Request {hovered.index + 1} · {events[hovered.index]!.ts.slice(11, 19)}</div>
            <div className="mt-0.5 text-kumo-subtle">{events[hovered.index]!.description || `model response · ${events[hovered.index]!.model}`}</div>
            <div className="mt-0.5 text-kumo-faint">{events[hovered.index]!.model} · {humanCount(events[hovered.index]!.inputTokens + events[hovered.index]!.outputTokens + events[hovered.index]!.cacheReadTokens + events[hovered.index]!.cacheWriteTokens)} tokens · {formatCost(events[hovered.index]!.costUsd)}</div>
          </div>
        )}
        <div className="flex h-12 items-end gap-[2px]" role="list" aria-label="request token volume">
          {events.map((e, i) => {
            const tokens = e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
            return (
              <button
                key={i}
                type="button"
                aria-label={`Request ${i + 1}, ${e.ts.slice(11, 19)}, ${e.description || e.model}`}
                onMouseEnter={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setHovered({ index: i, x: Math.max(8, Math.min(window.innerWidth - 8, rect.left + rect.width / 2)), y: Math.max(8, rect.top - 8) });
                }}
                onMouseLeave={() => setHovered(null)}
                onFocus={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setHovered({ index: i, x: Math.max(8, Math.min(window.innerWidth - 8, rect.left + rect.width / 2)), y: Math.max(8, rect.top - 8) });
                }}
                onBlur={() => setHovered(null)}
                style={{ height: `${Math.max(2, (tokens / maxTokens) * 100)}%` }}
                className="min-w-[3px] flex-1 rounded-t-sm bg-kumo-info/70 transition-colors hover:bg-kumo-info focus:bg-kumo-info focus:outline-none focus:ring-1 focus:ring-kumo-info"
              />
            );
          })}
        </div>
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
