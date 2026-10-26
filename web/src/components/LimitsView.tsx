import { useEffect, useMemo, useState } from "react";

import { Badge, Button, Surface } from "@cloudflare/kumo";

import { fetchLimits, saveAccountOrder, saveAccountVisibility, type LimitsAccount, type LimitsWindow } from "../lib/api";
import { completeAccountOrder, moveAccountOrder } from "../../../src/account-order";
import { formatCost, humanCount } from "../lib/fmt";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { EmptyState, Heading, SkeletonBlock } from "../ui";

const formatBalance = (amount: number, currency: string): string =>
  currency === "USD" ? formatCost(amount) : `${amount.toFixed(2)} ${currency}`;

/** "2d 4h", "3h 12m", "45m", "<1m" until (or since) an instant. */
const formatSpan = (ms: number): string => {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
};

const fillClass = (window: LimitsWindow): string => {
  const used = window.usedPercent ?? 0;
  if (used >= 90) return "bg-kumo-danger";
  if (used >= 70 || window.pace?.status === "over") return "bg-kumo-warning";
  return "bg-kumo-success";
};

const paceText = (window: LimitsWindow): string | undefined => {
  const pace = window.pace;
  if (pace === undefined) return undefined;
  const delta = Math.abs(Math.round(pace.deltaPercent));
  if (pace.status === "on") return "on pace";
  return pace.status === "over" ? `${delta}% ahead of pace` : `${delta}% under pace`;
};

function WindowRow({ window, now }: { window: LimitsWindow; now: number }) {
  const used = window.usedPercent;
  const resetMs = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt) - now;
  const runsOutMs = window.pace?.runsOutAt === undefined ? undefined : Date.parse(window.pace.runsOutAt) - now;
  const pace = paceText(window);
  const usage = window.tokens > 0 || window.costUsd > 0
    ? `${humanCount(window.tokens)} tok · ${formatCost(window.costUsd)}`
    : undefined;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{window.label}</span>
        <span className="font-mono text-kumo-subtle">
          {window.amountUsd !== undefined
            ? `${formatCost(window.amountUsd)} spent`
            : used !== null
              ? `${Math.round(used)}%`
              : (usage ?? "no cap")}
        </span>
      </div>
      {used !== null && window.amountUsd === undefined && (
        <div
          className="relative h-2 w-full overflow-hidden rounded-full bg-kumo-recessed"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used)}
          aria-label={`${window.label} ${Math.round(used)}% used`}
        >
          <div className={`h-full rounded-full ${fillClass(window)}`} style={{ width: `${Math.min(100, used)}%` }} />
          {window.pace !== undefined && (
            <div
              className="absolute top-0 h-full w-0.5 bg-kumo-default/70"
              style={{ left: `${Math.min(100, window.pace.expectedPercent)}%` }}
              title={`even pace: ${Math.round(window.pace.expectedPercent)}% by now`}
            />
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-between gap-x-3 text-[11px] text-kumo-subtle">
        <span>
          {resetMs === undefined ? (window.source === "derived" ? "calendar window" : "") : resetMs > 0 ? `resets in ${formatSpan(resetMs)}` : "reset due"}
          {pace !== undefined ? ` · ${pace}` : ""}
        </span>
        {runsOutMs !== undefined && runsOutMs > 0 ? (
          <span className="text-kumo-danger">runs out in {formatSpan(runsOutMs)}</span>
        ) : used !== null && usage !== undefined ? (
          <span>{usage}</span>
        ) : null}
      </div>
    </div>
  );
}

function AccountCard({ account, now, moveUp, moveDown }: {
  account: LimitsAccount; now: number; moveUp?: () => void; moveDown?: () => void;
}) {
  const title = account.label ?? account.email ?? account.accountKey;
  const harnesses = [account.harness, ...account.alsoOn].join(" · ");
  const extra = account.extraUsage;
  const extraPercent = extra?.usedPercent ??
    (extra?.usedUsd !== undefined && extra.limitUsd !== undefined && extra.limitUsd > 0 ? (extra.usedUsd / extra.limitUsd) * 100 : undefined);
  const observed = account.observedAt === undefined ? undefined : now - Date.parse(account.observedAt);

  return (
    <Surface as="div" className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{account.vendorName}</Badge>
        <span className="truncate text-sm font-medium" title={account.id}>{title}</span>
        {account.plan !== undefined && <Badge variant="primary">{account.plan}</Badge>}
        {account.freshness === "stale" && <Badge variant="warning">stale</Badge>}
        <span className="ml-auto font-mono text-[10px] text-kumo-subtle" title="harnesses reporting this account">
          {harnesses}
        </span>
        <Button size="sm" variant="secondary" aria-label={`Move ${title} up`} title="Move account up" disabled={!moveUp} onClick={moveUp}>↑</Button>
        <Button size="sm" variant="secondary" aria-label={`Move ${title} down`} title="Move account down" disabled={!moveDown} onClick={moveDown}>↓</Button>
      </div>
      {account.balance !== undefined && (
        <div className="flex justify-between text-xs">
          <span className="font-medium">Balance</span>
          <span className="font-mono text-kumo-subtle">
            {formatBalance(account.balance.remaining, account.balance.currency)}
            {account.balance.total !== undefined ? ` / ${formatBalance(account.balance.total, account.balance.currency)}` : ""}
          </span>
        </div>
      )}
      {account.windows.length > 0
        ? account.windows.map((window) => <WindowRow key={window.id} window={window} now={now} />)
        : account.balance === undefined && <p className="text-[11px] text-kumo-subtle">no quota windows yet — run `tokitoki poll`</p>}
      {extra !== undefined && extra.enabled && (
        <div className="space-y-1 border-t border-kumo-border pt-2">
          <div className="flex justify-between text-xs">
            <span className="font-medium">Extra usage</span>
            <span className="font-mono text-kumo-subtle">
              {extra.usedUsd !== undefined ? formatCost(extra.usedUsd) : "—"}
              {extra.limitUsd !== undefined ? ` / ${formatCost(extra.limitUsd)}` : ""}
            </span>
          </div>
          {extraPercent !== undefined && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-kumo-recessed">
              <div className="h-full rounded-full bg-kumo-warning" style={{ width: `${Math.min(100, extraPercent)}%` }} />
            </div>
          )}
        </div>
      )}
      {(account.bankedResets !== undefined || observed !== undefined) && (
        <div className="flex justify-between text-[10px] text-kumo-subtle">
          <span>{account.bankedResets !== undefined ? `${account.bankedResets} banked reset${account.bankedResets === 1 ? "" : "s"}` : ""}</span>
          <span>{observed !== undefined ? `observed ${formatSpan(observed)} ago` : ""}</span>
        </div>
      )}
    </Surface>
  );
}

/** Provider quota windows grouped vendor → account → plan → windows. */
export function LimitsView({ refreshTick, showEmail }: { refreshTick: number; showEmail: boolean }) {
  const [reload, setReload] = useState(0);
  const limits = useAsyncStaleWhileRevalidate(() => fetchLimits(showEmail), [refreshTick, showEmail, reload]);
  const [order, setOrder] = useState<string[] | undefined>();
  const [showHidden, setShowHidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => { setOrder(undefined); }, [refreshTick, showEmail]);
  const accounts = useMemo(() => {
    if (limits.state !== "ok") return [];
    const saved = order ?? limits.data.accountOrder ?? [];
    const rank = (id: string) => { const index = saved.indexOf(id); return index < 0 ? saved.length : index; };
    return limits.data.accounts.slice().sort((a, b) => rank(a.id) - rank(b.id));
  }, [limits, order]);

  const preferences = limits.state === "ok" ? limits.data.uiPreview : undefined;
  const globallyHidden = (a: LimitsAccount) => (preferences?.menubarHidden ?? []).some((entry) => {
    const at = entry.indexOf(":");
    return at < 0 ? entry === a.harness : entry.slice(0, at) === a.harness && a.accountKey.endsWith(entry.slice(at + 1));
  });
  const visibleAccounts = accounts.filter((a) => !globallyHidden(a));
  const hiddenAccounts = accounts.filter(globallyHidden);
  const barOrder = preferences?.barAccountOrder ?? (limits.state === "ok" ? limits.data.accountOrder ?? [] : []);
  const barAccounts = visibleAccounts.filter((a) => !(preferences?.barHiddenAccounts ?? []).includes(a.id) && !(preferences?.previewHidden ?? []).includes(a.vendor)).slice().sort((a, b) => {
    const rank = (id: string) => { const index = barOrder.indexOf(id); return index < 0 ? barOrder.length : index; };
    return rank(a.id) - rank(b.id);
  });
  async function saveVisibility(id: string, preference: { hidden?: boolean; barHidden?: boolean }) {
    if (saving) return;
    setSaving(true); setOrderError("");
    try { await saveAccountVisibility(id, preference); setReload((value) => value + 1); }
    catch (error) { setOrderError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  async function moveBarAccount(id: string, direction: -1 | 1) {
    if (saving) return;
    const next = moveAccountOrder({ saved: barOrder, accounts: accounts.map((a) => a.id), visible: barAccounts.map((a) => a.id), id, direction });
    if (!next) return;
    setSaving(true); setOrderError("");
    try { await saveAccountOrder(next, true); setReload((value) => value + 1); }
    catch (error) { setOrderError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  async function moveAccount(id: string, direction: -1 | 1) {
    if (saving || limits.state !== "ok") return;
    const next = moveAccountOrder({ saved: order ?? limits.data.accountOrder ?? [], accounts: limits.data.accounts.map((a) => a.id), visible: visibleAccounts.map((a) => a.id), id, direction });
    if (next === undefined) return;
    setSaving(true);
    setOrderError("");
    try {
      await saveAccountOrder(next, false, completeAccountOrder(barOrder, accounts.map((a) => a.id)));
      setOrder(next);
      setReload((value) => value + 1);
    } catch (error) { setOrderError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  return (
    <Surface as="section" className="mb-4 p-4">
      <Heading>limits · provider quotas per account</Heading>
      <p className="mb-3 text-xs text-kumo-subtle">Reorder quota cards and the bar independently. Hide an account everywhere or only on the bar.</p>
      {orderError && <p role="alert" className="text-xs text-kumo-danger">{orderError}</p>}
      {hiddenAccounts.length > 0 && <div className="mb-3">
        <Button size="sm" onClick={() => setShowHidden((value) => !value)} aria-expanded={showHidden}>Hidden quotas ({hiddenAccounts.length})</Button>
        {showHidden && hiddenAccounts.map((a) => <div key={a.id} className="flex items-center gap-2 py-1"><span>{a.label ?? a.accountKey}</span><Button size="sm" disabled={saving} onClick={() => void saveVisibility(a.id, { hidden: false })}>{(preferences?.menubarHidden ?? []).includes(a.harness) ? `Restore all ${a.harness} accounts` : "Restore"}</Button></div>)}
      </div>}
      {barAccounts.length > 0 && <details className="mb-3"><summary>Bar order</summary>{barAccounts.map((a, index) => <div key={a.id} className="flex items-center gap-2 py-1"><span>{a.label ?? a.accountKey}</span><Button size="sm" disabled={saving || index === 0} onClick={() => void moveBarAccount(a.id, -1)}>←</Button><Button size="sm" disabled={saving || index === barAccounts.length - 1} onClick={() => void moveBarAccount(a.id, 1)}>→</Button></div>)}</details>}
      {limits.state === "loading" ? (
        <SkeletonBlock className="h-40" />
      ) : limits.state === "error" ? (
        <p className="text-xs text-kumo-danger">{limits.error}</p>
      ) : accounts.length === 0 ? (
        <EmptyState message={"no accounts detected yet\nrun `tokitoki scan` for usage, then `tokitoki poll` for provider-reported quotas"} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleAccounts.map((account, index) => <div key={account.id}><AccountCard account={account} now={now}
            moveUp={!saving && index > 0 ? () => void moveAccount(account.id, -1) : undefined}
            moveDown={!saving && index < visibleAccounts.length - 1 ? () => void moveAccount(account.id, 1) : undefined} />
            <div className="flex gap-2 py-1">
              <Button size="sm" disabled={saving} onClick={() => void saveVisibility(account.id, { hidden: true })}>Hide everywhere</Button>
              <Button size="sm" disabled={saving} onClick={() => void saveVisibility(account.id, { barHidden: !(preferences?.barHiddenAccounts ?? []).includes(account.id) })}>{(preferences?.barHiddenAccounts ?? []).includes(account.id) ? "Show on bar" : "Hide from bar"}</Button>
            </div>
          </div>)}
        </div>
      )}
    </Surface>
  );
}
