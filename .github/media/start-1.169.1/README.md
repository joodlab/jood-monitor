# Stable Start browser evidence

Captured on 2026-10-14 from the actual local Cloudflare production bundles using
Start 1.169.1, Router 1.170.44, Vite 8.2.1 and Chrome. The dashboard uses the
existing loopback-only synthetic seed: one synthetic cluster, eight entities
and generated telemetry. Workspace and resource labels identify the fixtures.
The fixture stops reporting between seeding runs, so later views correctly show
stale measurements, unknown readiness and unavailable traffic.

| Artifact | Coverage |
| --- | --- |
| [Overview desktop](overview-desktop-synthetic.png) | Authenticated dashboard and validated snapshot/workspace/event server functions. |
| [Topology desktop](topology-desktop-synthetic.png) | Namespace navigation, configured relationships, pod expansion and fit control. |
| [Service inspector](inspector-desktop-synthetic.png) | Resource selection and source/freshness labels. |
| [Node inspector](node-inspector-desktop-synthetic.png) | Validated history calls and CPU/memory charts. |
| [Infrastructure mobile](infrastructure-mobile-synthetic.png) | 390 x 844 viewport, list alternative and contained table scrolling. |
| [Docs desktop](docs-installation-desktop.png) | Fumadocs SSR and assets at 1440 x 1000. |
| [Docs mobile](docs-installation-mobile.png) | Installation content at 390 x 844. |
| [Topology recording](topology-interaction-synthetic.webm) | 21.17 seconds: expand pods, fit topology and select a service. VP8, 1440 x 1000, 12 fps. |

The dashboard and docs had no browser console errors. Both mobile views had no
document-level horizontal overflow. Docs client navigation to Metrics and
history also completed through the real loader. Both apps currently expose
English/LTR interfaces; they have no Arabic/RTL mode to exercise.

Signed-out Basic Auth, empty/malformed Authorization, CSRF rejection without
writes, schema validation, typed RPC errors, private server context, redirects,
404s, same-origin docs RPC and malformed percent encoding are additionally
verified by `pnpm test:start` against isolated built Workers.

The captures were refreshed after reconciling the merged migration in PR #16,
using base `47d42411c40959404f420e80ab966d7c79c6b700` plus this follow-up's entry
configuration. The existing domain-routing and concurrent archival changes are
included in the verified hub bundle.

Only the reviewed PNGs and WebM are committed. Local credentials, D1/DO state,
browser configuration, logs and session data stay in ignored directories.
These captures establish local build/runtime compatibility, not deployment or
live infrastructure acceptance.
