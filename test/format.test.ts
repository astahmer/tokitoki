import { describe, expect, it } from "bun:test";

import { bar, cachePct, formatCost, formatInt, humanCount, sparkline } from "../src/format.ts";

describe("humanCount", () => {
  it("uses letter suffixes with trimmed decimals", () => {
    expect(humanCount(1_710_000_000)).toBe("1.71B");
    expect(humanCount(23_700_000)).toBe("23.7M");
    expect(humanCount(3_900_000_000)).toBe("3.9B");
    expect(humanCount(812_300)).toBe("812.3K");
    expect(humanCount(999)).toBe("999");
    expect(humanCount(1_000)).toBe("1K");
  });
});

describe("formatCost", () => {
  it("shows cents under $10 and no decimals at $10+", () => {
    expect(formatCost(9.42)).toBe("$9.42");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1080.904)).toBe("$1,081");
    expect(formatCost(230.7044)).toBe("$231");
  });
});

describe("formatInt", () => {
  it("adds thousands separators", () => {
    expect(formatInt(49677)).toBe("49,677");
  });
});

describe("cachePct", () => {
  it("computes cache share of prompt tokens", () => {
    expect(cachePct(100, 900)).toBe(90);
    expect(cachePct(250, 750)).toBe(75);
    expect(cachePct(100, 0)).toBe(0);
    expect(cachePct(0, 0)).toBe(0);
  });
});

describe("bar", () => {
  it("clamps fractions and fills proportionally", () => {
    expect(bar(0.5, 10)).toBe("█████░░░░░");
    expect(bar(0, 4)).toBe("░░░░");
    expect(bar(1, 4)).toBe("████");
    expect(bar(2, 4)).toBe("████");
  });
});

describe("sparkline", () => {
  it("normalizes to its own max", () => {
    expect(sparkline([0, 1, 2, 3, 4])).toBe("▁▂▄▆█");
    expect(sparkline([])).toBe("");
    expect(sparkline([5])).toBe("█");
    expect(sparkline([0, 0, 0])).toBe("▁▁▁");
  });
});
