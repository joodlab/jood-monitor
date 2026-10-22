// What the operator was looking at on the canvas, kept for the browser tab.
// Freezing on a saved observation, returning to live and the loading state
// between them all remount the canvas, and Back returns to a namespace; each
// should reopen on the same cards, zoom and pan instead of a fresh fit.

interface Point {
  x: number;
  y: number;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasView {
  // Cards whose pods were shown, by card id.
  expanded: string[];
  // The filter the positions and viewport were drawn under. Another filter
  // draws a different graph, so it gets a fresh layout and fit.
  filter: string;
  positions: Record<string, Point>;
  viewport?: CanvasViewport;
}

export function canvasViewKey(
  workspace: string,
  cluster: string | undefined,
  namespace: string
) {
  return `${workspace}:${cluster ?? "all"}:${namespace}`;
}

// Positions and viewport belong to the filter they were drawn under, so a
// change for another filter drops them; expanded cards are kept by id.
export function nextCanvasView(
  saved: CanvasView | undefined,
  change: Partial<CanvasView>
): CanvasView {
  const sameDrawing =
    saved && (change.filter === undefined || change.filter === saved.filter);
  const base: CanvasView = sameDrawing
    ? saved
    : {
        expanded: saved?.expanded ?? [],
        filter: change.filter ?? "",
        positions: {},
      };
  return { ...base, ...change };
}

// What a remounted canvas starts from. A restored viewport replaces the
// initial fit; without one the canvas fits as on a first visit.
export function restoredCanvasView(
  saved: CanvasView | undefined,
  filter: string
) {
  const drawn = saved?.filter === filter;
  return {
    expanded: saved?.expanded ?? [],
    positions: drawn ? saved.positions : {},
    viewport: drawn ? saved.viewport : undefined,
  };
}

// How a Graph mount opens. It restores the remembered viewport instead of
// fitting while it may (a new mount, before a filter change draws another
// graph under it) and one was saved under the current filter; otherwise
// there is nothing to restore and the canvas fits.
export function openingViewport(
  restoring: boolean,
  saved: CanvasView | undefined,
  filter: string
) {
  return restoring ? restoredCanvasView(saved, filter).viewport : undefined;
}

// Keeps the most recently used views up to the limit. A Map iterates in
// insertion order, so re-inserting a key marks it newest and the first key
// is the one to drop.
export function createCanvasViewMemory(limit = 50) {
  const views = new Map<string, CanvasView>();
  return {
    recall: (key: string) => views.get(key),
    remember(key: string, change: Partial<CanvasView>) {
      const next = nextCanvasView(views.get(key), change);
      views.delete(key);
      views.set(key, next);
      if (views.size > limit) {
        const oldest = views.keys().next().value;
        if (oldest !== undefined) {
          views.delete(oldest);
        }
      }
    },
  };
}

// One memory for the page: it outlives every canvas mount.
export const canvasViews = createCanvasViewMemory();

interface Rect {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface Insets {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

// The viewport that centres a card (in flow units) in the canvas area the
// overlays leave clear. A card wider or taller than that area at the current
// zoom, beside a docked service panel on a small screen, is zoomed out until
// it fits rather than left under the panel.
export function centredViewport(
  card: Rect,
  zoom: number,
  canvas: { width: number; height: number },
  clear: Insets
): CanvasViewport {
  const width = canvas.width - clear.left - clear.right;
  const height = canvas.height - clear.top - clear.bottom;
  const room = Math.min(width / card.width, height / card.height);
  const next = room > 0 ? Math.min(zoom, room) : zoom;
  return {
    zoom: next,
    x: clear.left + width / 2 - (card.x + card.width / 2) * next,
    y: clear.top + height / 2 - (card.y + card.height / 2) * next,
  };
}
