# Hub wave 2 verification

Every capture uses the local production build on native workerd. The browser was set to Asia/Riyadh while the server rendered in UTC. Four clearly labelled synthetic clusters come from the loopback-only seed scripts in `apps/app/scripts/`:

- "Synthetic production" (`seed-demo.mjs`, Standard): host samples for each node, a counter reset on node-b, a 4-minute host gap on node-c, past 5-second Diagnostic bursts, and a running Diagnostic on node-a (`DEMO_DIAGNOSTIC=1`).
- "Synthetic edge" (`seed-demo.mjs`, Basic).
- "Synthetic history (staged)" (`seed-history.mjs`): staged scaling, a rollout, a request change, a node resize receipt and a capacity change.
- "Synthetic delivery (drops)" (`seed-delivery.mjs`): drop and rejection totals that rise every 30 seconds.

All names, addresses and values are invented. There is no production telemetry, topology, credentials or customer data.

| Change | Capture |
| --- | --- |
| Host charts | [Node Host section](desktop-host-diagnostic.png): Host CPU busy as a rate from the per-state counters, against all-CPU capacity, with the running Diagnostic shaded as "samples every 5 s". The Kubernetes charts above it say "every 30 s" for the same period. [light](light-node-metrics.png) · [phone](mobile-node-metrics.png) |
| Counter reset | [node-b at 6 h](desktop-host-reset.png): the busy line breaks at the reboot, and the summary says "1 counter reset left blank". |
| Changes tab | [Deployment](desktop-changes-tab.png): ReplicaSet steps are marked "ReplicaSet of this Deployment", with observed and reported evidence kept apart. [Node](desktop-changes-reported.png): a reported resize receipt ("Reported time") next to the observed capacity change. [phone](mobile-changes.png) |
| Share links | [Link menu](desktop-share-menu.png): a link at the observation on screen, a live link, or a new tab. A [live link to a removed pod](desktop-linked-missing.png) offers "Open as saved at …". |
| Unreadable link time | [Explained once](desktop-unreadable-time.png), with "Choose a time…" and no snapshot request. [phone](mobile-unreadable-time.png) |
| Saved observation | [As captured Settings](desktop-captured-settings.png): read-only, with the heartbeat judged when the inventory arrived and counters "as captured". [phone](mobile-captured-settings.png) |
| Delivery counters | [Settings](desktop-delivery-rise.png): "rose by N since this page opened", with the receipt time of the heartbeat that first showed it. [Observability note](desktop-observability-note.png); the problem count is unchanged. |
| Finder | [Ctrl/⌘K "shop"](desktop-finder.png): one merged namespace drill across clusters comes first, with per-cluster "Inspect" results. |
| Requests | [Pods table](desktop-pod-requests.png): configured request and limit columns. [Node Pods tab](desktop-node-pods.png): requested against allocatable, ranked by share. |
| Counts and wording | [Namespace cards](desktop-namespace-counts.png): "5 finished (2 failed)" next to "No running pods". [Activity](desktop-activity-wording.png): "First observed in inventory … created 40d ago". |

The [recording](panel-flow.webm) runs through these steps:

1. Open `checkout` on the Pods tab and switch to Changes; the address gains `panel=changes`.
2. Back to Pods, then open a member pod.
3. Back returns to the Deployment through browser history.
4. Open node-a's Metrics, scroll to Host, and zoom to the running Diagnostic.

## Checks

- `pnpm lint`, `pnpm knip`, the type check, 839 unit tests, `pnpm test:worker` (native D1 and Durable Objects), `pnpm build`, `pnpm test:start` and `pnpm generate` (no diff) pass.
- A browser script checked 36 views at 1440 px (dark and light) and 390 px, with no browser errors and no horizontal overflow. It checked:
  - one series request per chart section;
  - the Diagnostic cadence on the Host and Kubernetes charts;
  - that the panel tab survives in the address, and that Back keeps the history length;
  - the share menu items;
  - the missing-resource offer;
  - that an unreadable or out-of-retention time names no unreachable hub and offers no Retry;
  - zero matches for "not retained historically";
  - captured Settings showing no enrollment controls;
  - the delivery rise and the Observability note;
  - Activity wording without "rollout" or actor phrases (only the screen-reader note on ReplicaSet counts mentions rollouts);
  - the namespace finished counts;
  - Ingress host search;
  - the request columns;
  - the finder's namespace drill, freeze and return to live.
- No capture shows an omitted Diagnostic period, which only happens on a crowded hour. Unit tests, a native Worker test and a DOM check cover it:
  - The native test uses 13 raw archives of 3,200 points plus 18,000 Diagnostic points in the same hour. It returns the hour with the omission and exact bounds, and reads no Diagnostic archive. A narrow read of the period then returns its samples.
  - The charts keep every loaded sample and shade the period. A covered node's lines break by the 90-second gap rule, and no counter rate spans the period.
