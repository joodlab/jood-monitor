import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

// Media queries read through useSyncExternalStore, so a resize or rotation
// updates every reader without an effect. The server snapshot is false.
export function useMediaQuery(query: string) {
  const subscribe = useMemo(
    () => (callback: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", callback);
      return () => list.removeEventListener("change", callback);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}

// Phones: the canvas opens as a list, where a graph is hard to use.
export const phoneQuery = "(max-width: 639px)";
// Below this width the Activity panel would cover too much of the canvas,
// so it starts closed behind a button.
export const panelQuery = "(max-width: 1023px)";

// One callback identity for the component's life that always calls the
// latest prop or closure, so a parent re-render never rebuilds every card.
export function useLatestCallback<A extends unknown[]>(
  callback: (...args: A) => void
) {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  return useCallback((...args: A) => latest.current(...args), []);
}
