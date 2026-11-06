import { escapeHtml, formatCost, humanCount, providerName, sliceColor } from "./format.ts";

export interface HistorySeries {
  bucket?: string;
  values?: number[];
}

export interface HistoryBlock {
  days?: string[];
  series?: HistorySeries[];
}

export interface PanelCard {
  id: string;
  title: string;
  text: string;
  html: string;
  accountOrderId?: string;
}

export interface PanelLayout {
  hidden: string[];
  order: string[];
}

export function includesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return text.toLowerCase().includes(needle);
}

export function polylinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  let max = 0;
  for (const value of values) if (value > max) max = value;
  const span = max <= 0 ? 1 : max;
  const points: string[] = [];
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    const x = index * step;
    const y = height - (value / span) * (height - 4) - 2;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(" ");
}

export function reorderCards(order: string[], dragged: string, target: string): string[] {
  const next = order.filter((id) => id !== dragged);
  const index = next.indexOf(target);
  if (index < 0) {
    next.push(dragged);
    return next;
  }
  next.splice(index, 0, dragged);
  return next;
}

export function moveCard(order: string[], id: string, direction: -1 | 1): string[] {
  const index = order.indexOf(id);
  if (index < 0) return order.slice();
  const destination = index + direction;
  if (destination < 0 || destination >= order.length) return order.slice();
  const next = order.slice();
  const swapped = next[destination];
  next[destination] = id;
  next[index] = swapped ?? id;
  return next;
}

export function orderedCards(cards: PanelCard[], layout: PanelLayout, query: string): PanelCard[] {
  const known = new Set<string>();
  for (const card of cards) known.add(card.id);
  const ordered: PanelCard[] = [];
  const seen = new Set<string>();
  for (const id of layout.order) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const card = cards.find((candidate) => candidate.id === id);
    if (card !== undefined) ordered.push(card);
  }
  for (const card of cards) {
    if (!seen.has(card.id)) ordered.push(card);
  }
  const visible: PanelCard[] = [];
  for (const card of ordered) {
    if (layout.hidden.includes(card.id)) continue;
    if (!includesQuery(`${card.title} ${card.text}`, query)) continue;
    visible.push(card);
  }
  return visible;
}

export function joinCards(cards: PanelCard[]): string {
  const parts: string[] = [];
  for (const card of cards) parts.push(card.html);
  return parts.join("");
}

export function traySummaryText(weekCost: number, todayCost: number): string {
  if (weekCost > 0) return `tokitoki ${formatCost(weekCost)} this week`;
  return `tokitoki ${formatCost(todayCost)} today`;
}

export function historyChart(block: HistoryBlock | undefined, limit: number): string {
  const series = (block?.series ?? []).slice(0, limit);
  if (series.length === 0) return `<p class="muted">No history in this window</p>`;
  const width = 360;
  const height = 72;
  const lines: string[] = [];
  const legend: string[] = [];
  for (let index = 0; index < series.length; index += 1) {
    const entry = series[index];
    const values = entry?.values ?? [];
    const color = sliceColor(index);
    const points = polylinePoints(values, width, height);
    lines.push(`<polyline fill="none" stroke="${color}" stroke-width="2" points="${points}" />`);
    let last = 0;
    if (values.length > 0) last = values[values.length - 1] ?? 0;
    legend.push(`<div class="row"><span class="swatch" style="background:${color}"></span><span class="grow">${escapeHtml(providerName(entry?.bucket ?? ""))}</span><span class="muted">${escapeHtml(humanCount(last))}</span></div>`);
  }
  const days = block?.days ?? [];
  const start = days[0] ?? "";
  const end = days.length > 0 ? days[days.length - 1] ?? "" : "";
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">${lines.join("")}</svg><div class="tiny">${escapeHtml(start)} → ${escapeHtml(end)}</div>${legend.join("")}`;
}

export interface CompositionPart {
  label: string;
  value: number;
}

export function compositionParts(row: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): CompositionPart[] {
  return [
    { label: "input", value: row.inputTokens ?? 0 },
    { label: "output", value: row.outputTokens ?? 0 },
    { label: "cache read", value: row.cacheReadTokens ?? 0 },
    { label: "cache write", value: row.cacheWriteTokens ?? 0 },
  ];
}

export function compositionBars(parts: CompositionPart[]): string {
  let max = 0;
  for (const part of parts) if (part.value > max) max = part.value;
  if (max <= 0) return `<p class="muted">No token mix in this period</p>`;
  const lines: string[] = [];
  for (const part of parts) {
    const width = Math.round((part.value / max) * 100);
    lines.push(`<div class="row"><span class="grow">${escapeHtml(part.label)}</span><span class="muted">${escapeHtml(humanCount(part.value))}</span></div><div class="bar ok"><span style="width:${width}%"></span></div>`);
  }
  return lines.join("");
}

export function trackingLines(period: {
  pricingCoveragePercent?: number;
  cachedInputPercent?: number;
  reportedTokens?: number;
  estimatedTokens?: number;
  unknownTokens?: number;
  unpricedModels?: string[];
} | undefined): string {
  if (period === undefined) return `<p class="muted">No tracking breakdown for this period</p>`;
  const coverage = Math.round(period.pricingCoveragePercent ?? 0);
  const cached = Math.round(period.cachedInputPercent ?? 0);
  const models = period.unpricedModels ?? [];
  const modelText = models.length === 0 ? "none" : models.join(", ");
  return [
    `<div class="row"><span class="grow">priced requests</span><span class="muted">${coverage}%</span></div>`,
    `<div class="row"><span class="grow">cached input</span><span class="muted">${cached}%</span></div>`,
    `<div class="row"><span class="grow">reported</span><span class="muted">${escapeHtml(humanCount(period.reportedTokens ?? 0))}</span></div>`,
    `<div class="row"><span class="grow">estimated</span><span class="muted">${escapeHtml(humanCount(period.estimatedTokens ?? 0))}</span></div>`,
    `<div class="row"><span class="grow">unknown</span><span class="muted">${escapeHtml(humanCount(period.unknownTokens ?? 0))}</span></div>`,
    `<div class="row"><span class="grow">unpriced models</span><span class="muted">${escapeHtml(modelText)}</span></div>`,
  ].join("");
}

export function shareMarkdown(input: {
  generatedAt: string;
  weekRows: Array<{ bucket?: string; costUsd?: number; tokens?: number }>;
  todayCost: number;
  monthToDate: number;
  projected: number;
}): string {
  const lines = [`# tokitoki ${input.generatedAt}`, ""];
  lines.push(`Today ${formatCost(input.todayCost)}`);
  lines.push(`Month to date ${formatCost(input.monthToDate)}, projected ${formatCost(input.projected)}`);
  lines.push("", "## This week");
  for (const row of input.weekRows) {
    lines.push(`- ${providerName(row.bucket ?? "")}: ${formatCost(row.costUsd ?? 0)}`);
  }
  return lines.join("\n");
}
