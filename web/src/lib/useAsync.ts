import { useEffect, useRef, useState } from "react";

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
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setState((prev) =>
      prev.state === "ok" ? { ...prev, refreshing: true } : { state: "loading" },
    );
    fn().then(
      (data) => {
        if (alive.current) setState({ state: "ok", data });
      },
      (err) => {
        if (!alive.current) return;
        setState((prev) => {
          if (prev.state === "ok") return { ...prev, refreshing: false };
          return { state: "error", error: err instanceof Error ? err.message : String(err) };
        });
      },
    );
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
