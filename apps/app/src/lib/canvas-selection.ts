// The canvas selection follows the service panel. Whatever opened the panel
// (a card, the Activity panel, the command palette, the panel's own links or
// Back), the card of the resource it shows is the one selected, and closing
// it clears the selection. Cards then dim only around what the panel shows.

export interface InspectedResource {
  cluster?: string;
  uid?: string;
}

interface Drawn {
  entity: { uid: string };
  view: { cluster: { id: string } };
}

// Restored or cloned clusters can share a uid, so a card matches on both.
export function drawsResource(item: Drawn, resource: InspectedResource) {
  return (
    resource.uid !== undefined &&
    item.entity.uid === resource.uid &&
    item.view.cluster.id === resource.cluster
  );
}

interface Card {
  data: { item: Drawn };
  id: string;
  selected?: boolean;
}

// Selects only the card of the inspected resource, or none when the panel is
// closed or the resource has no card. Unchanged cards keep their object and
// the array survives when nothing changes, so React Flow skips the update.
export function selectInspected<T extends Card>(
  cards: T[],
  resource: InspectedResource
): T[] {
  const id = cards.find((card) => drawsResource(card.data.item, resource))?.id;
  const next = cards.map((card) => {
    const selected = card.id === id;
    return (card.selected ?? false) === selected ? card : { ...card, selected };
  });
  return next.every((card, index) => card === cards[index]) ? cards : next;
}
