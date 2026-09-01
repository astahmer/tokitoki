import { describe, expect, it } from "bun:test";

/**
 * useAsyncStaleWhileRevalidate (web/src/lib/useAsync.ts) can't be exercised
 * directly here — it's a React hook (useState/useEffect/useRef) and this
 * repo has no DOM/render test harness. This mirrors its exact state-machine
 * logic (the part under test) so the race is provable without one; the real
 * fix is the same one-line change applied to the actual hook.
 */

interface AsyncState<T> {
  state: "loading" | "error" | "ok";
  data?: T;
  error?: string;
}

/** The BUGGY version: `alive` is one ref shared across every effect run. */
function runBuggy<T>(
  fn: () => Promise<T>,
  aliveRef: { current: boolean },
  setState: (s: AsyncState<T>) => void,
): () => void {
  aliveRef.current = true;
  fn().then((data) => {
    if (aliveRef.current) setState({ state: "ok", data });
  });
  return () => {
    aliveRef.current = false;
  };
}

/** The FIXED version: each run closes over its own local `cancelled` flag. */
function runFixed<T>(fn: () => Promise<T>, setState: (s: AsyncState<T>) => void): () => void {
  let cancelled = false;
  fn().then((data) => {
    if (!cancelled) setState({ state: "ok", data });
  });
  return () => {
    cancelled = true;
  };
}

describe("useAsyncStaleWhileRevalidate race (mirrors the real hook's state machine)", () => {
  it("regression: a shared 'alive' ref lets a stale, slower request clobber a fresher one", async () => {
    let latest: AsyncState<string> = { state: "loading" };
    const setState = (s: AsyncState<string>) => {
      latest = s;
    };
    const aliveRef = { current: true };

    // Request A (slow: the "year" window) starts.
    let resolveA!: (v: string) => void;
    const cleanupA = runBuggy(() => new Promise<string>((r) => (resolveA = r)), aliveRef, setState);

    // User immediately narrows to a fast window: deps change, effect re-runs.
    cleanupA(); // React's cleanup for the old effect: aliveRef.current = false
    let resolveB!: (v: string) => void;
    runBuggy(() => new Promise<string>((r) => (resolveB = r)), aliveRef, setState); // resets aliveRef.current = true

    // B (fast) resolves first and renders correctly.
    resolveB("day-window-data");
    await Promise.resolve();
    expect(latest).toEqual({ state: "ok", data: "day-window-data" });

    // A (slow, superseded) finally resolves. aliveRef.current is true again
    // (B's run reset it), so A's stale data still gets applied.
    resolveA("year-window-data");
    await Promise.resolve();
    expect(latest.data).toBe("year-window-data"); // the bug: overwritten with stale data
  });

  it("fixed: a per-run local flag keeps a stale request from clobbering a fresher one", async () => {
    let latest: AsyncState<string> = { state: "loading" };
    const setState = (s: AsyncState<string>) => {
      latest = s;
    };

    let resolveA!: (v: string) => void;
    const cleanupA = runFixed(() => new Promise<string>((r) => (resolveA = r)), setState);

    cleanupA(); // cancels ONLY this run's closure — cannot affect the next run
    let resolveB!: (v: string) => void;
    runFixed(() => new Promise<string>((r) => (resolveB = r)), setState);

    resolveB("day-window-data");
    await Promise.resolve();
    expect(latest).toEqual({ state: "ok", data: "day-window-data" });

    resolveA("year-window-data"); // stale — its own closure was cancelled
    await Promise.resolve();
    expect(latest.data).toBe("day-window-data"); // correctly unchanged
  });
});
