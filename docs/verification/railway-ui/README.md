# Railway-inspired UI verification

Every capture uses the local production build on native workerd with the
clearly labelled synthetic fleet from `apps/app/scripts/seed-demo.mjs`
("Synthetic production", "Synthetic edge"; invented names, addresses and
values). No production telemetry, topology, credentials or customer data.

The redesign follows Railway's product flow, adapted to monitoring:

| Railway | Jood Monitor |
| --- | --- |
| Project | Workspace (logo opens the [workspaces grid](desktop-workspaces.png)) |
| Environment | Cluster (switcher next to the workspace) |
| Architecture canvas | [Namespace map](desktop-canvas-namespaces.png), [namespace canvas](desktop-canvas-shop.png), [Problems only](desktop-canvas-problems.png) |
| Activity panel | Needs attention first, then recent changes, on the canvas |
| Service panel | [Docked panel](desktop-service-panel.png) with Pods, Metrics, Details and Links |
| Observability | [Widget grid](desktop-observability.png) |
| Staged changes | [Apply N changes card](desktop-staged-changes.png) and [diff dialog](desktop-staged-details.png) for collection settings |
| Settings | [Section rails](desktop-settings.png) per cluster |

Also captured: [Resources: servers](desktop-resources-servers.png),
[Resources: pods](desktop-resources-pods.png), [Activity](desktop-activity.png),
[finder](desktop-finder.png), [light theme](light-canvas-shop.png) and phone
layouts for the [canvas](mobile-canvas.png), [Observability](mobile-observability.png)
and [Settings](mobile-settings.png). The [recording](canvas-flow.webm) drills
from the namespace map into `shop`, expands the `checkout` pods, opens the
service panel and its Metrics tab, then stages a collection change and opens
its review dialog. Nothing was applied.

Jood's lime stays the brand accent; violet marks only staged, not yet applied
changes. Topology always says it shows configured structure and that traffic
is not measured. Logs are not collected, so there is no Logs tab.

## Checks

- `pnpm lint`, `pnpm knip`, type check, 278 unit tests, `pnpm build`,
  `pnpm test:start` and `pnpm test:worker` pass.
- No hydration errors on any view with browser time zones Asia/Riyadh,
  America/Los_Angeles and UTC.
- Every capture reported no browser errors and no horizontal overflow at
  1440 px and 390 px.
- Independent review lenses (functional parity with the previous UI,
  correctness, truthfulness and staged-change safety, accessibility and
  mobile, performance) were run with a skeptic verifying each finding before
  it was fixed.
- A read-only production check (every non-GET request blocked) found two
  issues the synthetic fleet did not show, both fixed here. Namespace cards
  warned about finished, failed debug and Job pods while the attention list
  correctly reported nothing live; those pods are now counted on the card as
  "finished with failures" without a warning. A full build hash as the
  observer version overflowed on phones; it now wraps.
