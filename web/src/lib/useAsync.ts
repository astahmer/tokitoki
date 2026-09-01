import { useEffect, useState } from "react";

/**
 * Async loader with stale-while-revalidate semantics:
 * - first load: `loading` (render skeletons)
 * - refetch (deps changed): previous data stays visible with `refreshing` on,
 *   so toggles/filters never collapse or shift the layout
 * - failed refetch with data in hand: keep the stale view, surface nothing
 *   (the next successful fetch wins)
 */
export type AsyncState<T> =
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ok"; data: T; refreshing?: boolean };

export function useAsyncStaleWhileRevalidate<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ state: "loading" });
  useEffect(() => {
    // A per-run local flag, not a ref shared across every effect run: a
    // shared ref gets reset to true by a NEW run even while an OLDER,
    // slower run is still in flight, so that older run's `.then` would
    // still see itself as "alive" and could clobber the newer run's
    // already-rendered result once it finally resolves.
    let cancelled = false;
    setState((prev) =>
      prev.state === "ok" ? { ...prev, refreshing: true } : { state: "loading" },
    );
    fn().then(
      (data) => {
        if (!cancelled) setState({ state: "ok", data });
      },
      (err) => {
        if (cancelled) return;
        setState((prev) => {
          if (prev.state === "ok") return { ...prev, refreshing: false };
          return { state: "error", error: err instanceof Error ? err.message : String(err) };
        });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
