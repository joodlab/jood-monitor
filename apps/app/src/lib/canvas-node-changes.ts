// The node changes the canvas takes from React Flow: card measurements only.
// Cards never move, and the selection follows the service panel alone (see
// canvas-selection.ts). A select change from a click, a key, the pane or a
// selection box is dropped, so a card never shows selected, with the others
// dimmed, while another resource is open or after the panel closed.
export function measuredChanges<T extends { type: string }>(changes: T[]) {
  return changes.filter((change) => change.type === "dimensions");
}
