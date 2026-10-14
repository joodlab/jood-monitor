# TanStack Start 1.169 migration verification

Captured on 2026-10-14 from local **production Cloudflare build output**, running
on native workerd. Every workspace, cluster, node and measurement shown here is
synthetic. The fixtures use loopback ports 46800 and 46801, disposable D1/Durable
Object/R2 storage and randomly generated fixture credentials. No production
account, fleet or customer data was used.

Both apps pin Start 1.169.1 and Router 1.170.44. Existing Vite 8.2.1, React plugin
6.0.5 and Cloudflare Vite plugin 2.0.0-beta.sha-52b0dc0e9 remain pinned. Node.js 24
is used locally and in CI. Release tooling determines the workspace Node ranges:
`^22.19.0 || ^24.11.0 || >=26.0.0`, above Start's 22.12 and Prisma CLI's 22.18
minimums. The hub continues wrapping Start's built-in server entry, with machine API responses
handled separately; docs continues using the built-in entry directly. Validators
already use `.validator()`. There are no Start sessions, Nitro v2 plugins,
removed response helpers or obsolete Start umbrella imports to replace.

## Reproduce runtime checks

```sh
pnpm install --frozen-lockfile
pnpm build --concurrency=1
pnpm test:start
```

The smoke test loads the emitted Worker modules rather than rebuilding a test
entry. It verifies Basic Auth challenges (missing and empty Authorization),
CSRF rejection, serialized validation errors, synthetic server-function/D1
writes and reads, canonical redirects, SSR security headers, malformed path
rejection, docs forwarding redirects, MDX loading and missing pages. Docs RPC
also rejects cross-origin requests. Existing `pnpm test:worker` covers native
atomic writes, archival/backpressure recovery, scoped machine credentials,
one-use enrollment and WebSocket origin checks.

## Browser evidence

Chrome exercised workspace selection, theme switching, mobile navigation,
synthetic live updates, namespace topology, pod expansion and client navigation
from docs home to Installation. The inspected browser session reported zero
console errors or warnings. Hub and docs had document widths of 390 px at a
390 px viewport. Both applications currently expose English interfaces; there
is no supported Arabic/RTL locale to exercise.

Source freshness is visible. Stale or unavailable measurements remain unknown
in the mobile capture; the topology describes configured structural relations
and explicitly states that traffic is unavailable.

| Evidence | Viewport | File |
| --- | --- | --- |
| Hub overview, synthetic telemetry | 1440 × 900 | [Desktop](hub-desktop.png) |
| Hub overview, stale/missing measurements | 390 × 844, full page | [Mobile](hub-mobile.png) |
| Namespace structural topology | 1440 × 900 | [Topology](topology-desktop.png) |
| Pod expansion interaction | 1280 × 800 recording | [Short video](topology.webm) |
| Docs Installation after client navigation | 1440 × 900 | [Desktop](docs-desktop.png) |
| Docs Installation | 390 × 844 | [Mobile](docs-mobile.png) |

These checks establish local build/runtime behavior. Deployment, live agent
acceptance, production Basic Auth and infrastructure cutovers are separate.
No Docker image was built, and PR CI still contains no Docker build steps.

References: [Start RC migration guide](https://raw.githubusercontent.com/TanStack/router/main/docs/start/framework/react/migrate-from-release-candidate.md)
and [Vite migration guide](https://vite.dev/guide/migration).
