import { describe, expect, it } from "bun:test";

import { apiTable } from "../src/web/api.ts";

// apiTable's own validation runs before any cache/filesystem access, so a
// rejected call never touches the real on-disk cache — only test the throw
// path here. A valid period would proceed into withCache() (new EventCache())
// against this machine's actual default cache.db, which is not something a
// routine test run should touch as a side effect.
describe("apiTable period validation", () => {
  it("rejects an invalid period passed via the legacy `period` query param", () => {
    // server.ts builds this from `url.searchParams.get("period")` with NO
    // validation of its own — apiTable is the only gate. wp.last is absent
    // in this shape (the common case: only `?period=` was given), which is
    // exactly the branch the old `&& wp.last !== undefined` guard skipped
    // entirely, silently falling through to a 365-day "year" window instead
    // of rejecting the typo.
    expect(() => apiTable("model", {}, "bogus")).toThrow(/invalid period/i);
  });

  it("rejects an invalid duration-like string via --last", () => {
    expect(() => apiTable("model", { last: "bogus" }, "week")).toThrow(/invalid period/i);
  });
});
