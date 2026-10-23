# Hub gap fixes verification

Every capture uses the local production build on native workerd, with the clearly labelled synthetic fleet from `apps/app/scripts/seed-demo.mjs`:

- "Synthetic production", on the Standard profile, sends pod and node samples.
- "Synthetic edge", on Basic, sends node samples only.

All names, addresses and values are invented. There is no production telemetry, topology, credentials or customer data.

| Gap | After |
| --- | --- |
| Finished pods and Problems only | [Problems only](desktop-problems-only.png) shows live problems only. The node reporting `NetworkUnavailable` is a warning, and its count matches the badge and Activity. |
| Pods with no workload | [`smoke-check-q4m8z`](desktop-standalone-pod.png) is drawn on its namespace canvas as neutral history ("Finished · Failed"). |
| Why usage is missing | In [Resources › Pods](desktop-usage-reasons.png), Basic pods read "Not collected (Basic)", never zero. Finished failed pods keep their status in neutral styling, not as warnings. |
| Capacity | [Server tiles](desktop-servers-capacity.png) show measured use against allocatable, and configured requests against allocatable labelled "configured, not usage". |
| One node rule | [Servers › Problems only](desktop-servers-problems.png) lists the node at 95.8% of allocatable memory that the badge counts. |
| Service panel | The [docked panel](desktop-service-panel.png) keeps the inspected card in view, and its coverage note names the profile. |
| Time travel | A time [outside retention](desktop-time-retention.png) and an [unreadable time](desktop-time-unreadable.png) are explained without a Retry that cannot work. A frozen [Activity](desktop-activity-frozen.png) view reads "the hour before …". |
| Staged changes | The [Settings tab](desktop-staged-badge.png) shows "1 staged". The Apply card covers the visible cluster, and the new Hub buffer block shows the archive backlog. |
| Phones | The [list](mobile-list.png) shows problems first, and [server tiles](mobile-servers.png) stack without overflow. |

The [recording](canvas-flow.webm) runs through these steps:

1. Toggle Problems only on and off.
2. Open the `shop` namespace and inspect `checkout`. Unrelated cards dim while the text stays readable.
3. Click the empty canvas. The selection stays on the inspected card.
4. Close the panel with Escape. The dimming clears.
5. Open Resources › Servers.

## Checks

- `pnpm lint`, `pnpm knip`, type check, 528 unit tests, `pnpm test:worker` (native D1 and Durable Objects), `pnpm build` and `pnpm test:start` pass.
- A browser script checked the synthetic preview at 1440 px and 390 px with no browser errors and no horizontal overflow. It checked:
  - Problems only seeds no finished pods.
  - The pod with no workload is drawn.
  - The docked panel's left edge stays right of the inspected card.
  - Selection and dimming clear on close.
  - Enter opens a focused card.
  - The time-travel errors show no Retry.
  - Reloading with a staged change raises the browser's leave-page prompt.
- The seven work packages were each reviewed on their own. The combined diff was then reviewed through five lenses (integration, truthfulness, SSR and state, server and security, accessibility and copy), with a skeptic verifying each finding. All 16 confirmed findings are fixed here.
