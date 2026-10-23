// Focus and dismissal rules for the docked service panel (see PanelShell).

// TanStack Start hydrates the whole document, so React's listeners and Base
// UI's dismiss listener sit on the same node: a control's stopPropagation
// cannot keep its Escape (a search clearing its text, the Activity panel
// closing) away from the panel. Its preventDefault marks it as handled.
export function escapeConsumed(
  reason: string,
  event: { defaultPrevented: boolean }
) {
  return reason === "escape-key" && event.defaultPrevented;
}

interface Container<T> {
  contains(node: T): boolean;
}

// The focused element when it is outside the panel and not the body: the
// card or row that opened or switched the panel, or a control the operator
// moved to on purpose.
export function focusedOutside<T>(
  active: T | null,
  body: T | null,
  panel: Container<T> | null
) {
  if (!active || active === body || panel?.contains(active)) {
    return null;
  }
  return active;
}

// Where focus goes when the panel closes. When focus is in the panel, or was
// dropped to the body (as when a focused card unmounts), it returns to the
// element that opened or last switched the panel; `true` falls back to Base
// UI's default. Focus the operator moved elsewhere, such as the canvas
// search, stays there.
export function closingFocus<T, I extends { isConnected: boolean }>(
  active: T | null,
  body: T | null,
  panel: Container<T> | null,
  invoker: I | null
): I | boolean {
  if (focusedOutside(active, body, panel)) {
    return false;
  }
  return invoker?.isConnected ? invoker : true;
}
