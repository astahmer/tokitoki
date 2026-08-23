/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk) — pure math, no DOM.
 * Used by the web spend-mosaic view; rectangle area = share of total.
 */

export interface TreemapItem {
  label: string;
  value: number;
  /** Optional nested breakdown revealed on click. */
  children?: TreemapItem[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed extends Rect {
  item: TreemapItem;
}

/** Squarified layout (Bruls et al.): greedily pack rows whose aspect ratios stay closest to 1. */
export function squarify(items: TreemapItem[], width = 1, height = 1): Placed[] {
  const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, i) => s + i.value, 0);
  if (!(total > 0) || !(width > 0) || !(height > 0)) return [];

  const fullArea = width * height;
  let queue: AreaItem[] = sorted.map((i) => ({ item: i, area: (i.value / total) * fullArea }));
  let rect: Rect = { x: 0, y: 0, w: width, h: height };
  const out: Placed[] = [];

  while (queue.length > 0) {
    const horizontal = rect.w >= rect.h;
    const side = horizontal ? rect.h : rect.w;
    const row: AreaItem[] = [queue[0]!];
    const rest = queue.slice(1);
    while (rest.length > 0 && worstRatio([...row, rest[0]!], side) <= worstRatio(row, side)) {
      row.push(rest.shift()!);
    }

    const rowSum = row.reduce((s, a) => s + a.area, 0);
    const thickness = rowSum / side;
    let offset = 0;
    for (const a of row) {
      const len = thickness > 0 ? a.area / thickness : 0;
      if (horizontal) {
        out.push({ item: a.item, x: rect.x, y: rect.y + offset, w: thickness, h: len });
      } else {
        out.push({ item: a.item, x: rect.x + offset, y: rect.y, w: len, h: thickness });
      }
      offset += len;
    }
    rect = horizontal
      ? { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h }
      : { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness };
    queue = rest;
  }
  return out;
}

interface AreaItem {
  item: TreemapItem;
  area: number;
}

function worstRatio(row: AreaItem[], side: number): number {
  const sumArea = row.reduce((s, a) => s + a.area, 0);
  const thickness = sumArea / side;
  let worst = 0;
  for (const a of row) {
    const len = thickness > 0 ? a.area / thickness : 0;
    const ratio = Math.max(thickness / len, len / thickness);
    if (ratio > worst) worst = ratio;
  }
  return worst;
}
