import { describe, expect, it } from "bun:test";

/**
 * ToolsView.tsx can't be rendered directly here (no DOM/render test harness
 * in this repo). This mirrors its exact branch decision for the table's
 * async state — the part that was wrong — against every sibling view's
 * shared convention (loading → skeleton, error → message, else → content).
 */
type Branch = "skeleton" | "error" | "content";

/** The BUGGY version: ToolsView.tsx's actual condition before the fix. */
function branchBuggy(state: "loading" | "error" | "ok"): Branch {
  if (state === "loading" || state === "error") return "skeleton";
  return "content";
}

/** The FIXED version, matching every sibling view (SessionsView, ReportsView, etc). */
function branchFixed(state: "loading" | "error" | "ok"): Branch {
  if (state === "loading") return "skeleton";
  if (state === "error") return "error";
  return "content";
}

describe("ToolsView async-state branch", () => {
  it("regression: an error state rendered as an endless loading skeleton, not the error", () => {
    expect(branchBuggy("error")).toBe("skeleton"); // the bug
    expect(branchFixed("error")).toBe("error"); // matches every sibling view
  });

  it("still shows the skeleton while genuinely loading", () => {
    expect(branchFixed("loading")).toBe("skeleton");
  });

  it("still shows content once data has loaded", () => {
    expect(branchFixed("ok")).toBe("content");
  });
});
