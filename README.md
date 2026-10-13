# Jood Monitor

Infrastructure monitoring with a serverless TypeScript hub and lightweight Go
agents. Explore Kubernetes resources, inspect CPU and memory, follow structural
topology, and review observed scaling events. Agents run on your infrastructure;
the dashboard, API and storage run on Cloudflare.

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Checks](https://github.com/lord007tn/jood-monitor/actions/workflows/ci.yaml/badge.svg)](https://github.com/lord007tn/jood-monitor/actions/workflows/ci.yaml)

[![Deploy hub to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lord007tn/jood-monitor)

The button clones the entire workspace and deploys the full-stack hub with the
`cf` CLI. Documentation is a separate app, deployed with `pnpm deploy:docs`.
Set `MONITOR_DOCS_URL` to its `/docs` URL when building the hub.
Set `MONITOR_HUB_URL` to the hub's HTTPS origin when deploying docs so the
Dashboard link opens your app.
`wrangler.json` is discovery metadata for Cloudflare's button; actual builds
and deployments use the native `cloudflare.config.ts` files and `cf`.

## Stack

- **Hub:** TanStack Start, Router, Query and Form, React, Vite, shared shadcn
  primitives, TanStack Table and Charts, and React Flow.
- **Registry:** Prisma 8.0.0-rc.22 CLI, @prisma/orm-sqlite 8.0.0-rc.17, and
  Cloudflare D1 through the custom D1 driver.
- **Telemetry:** transactional SQLite Durable Objects, compressed R2 archives,
  Cloudflare Queues, durable alarms and scheduled retention.
- **Agents:** Go, scoped Kubernetes observer and node collectors, bounded local
  buffering, TLS and OTLP/HTTP protobuf.
- **Docs:** Fumadocs in an independent TanStack Start Cloudflare Worker.

**Prisma 8 is a release candidate and its SQLite target is experimental.** The
D1 driver is maintained here and is not an official Prisma D1 adapter. Versions
are pinned and native runtime tests cover database writes and recovery. Read
[database details](docs/database.md) before upgrading.

## Run locally

Use Node.js 24, pnpm 10.30.3 and the Go version in `go.mod`.

```sh
pnpm install --frozen-lockfile
cp apps/app/.dev.vars.example apps/app/.dev.vars
pnpm db:emit
pnpm --filter @jood-monitor/app db:migrate:local
pnpm --filter @jood-monitor/app dev
```

Set your operator username, a random password of at least 16 characters and your
app origin in `.dev.vars`. Operator mutations require Origin and CSRF checks.
Keep all credentials out of Git. Run docs separately with
`pnpm --filter @jood-monitor/docs dev`.

See [installation](apps/docs/content/installation.mdx) for provisioning,
deployment and enrollment.

## Project conventions

```text
apps/app/src/
  routes/          thin route definitions
  components/      UI using shared shadcn primitives
  hooks/api/       queries and live connections
  functions/       validated TanStack server functions and middleware
  actions/         orchestration and durability rules
  data-access/     scoped Prisma queries and atomic write plans
  db/              contracts, D1 driver and native DO SQLite storage
  schemas/         input validation
apps/docs/         separate Fumadocs app
apps/agent/        Go observer and node collector
packages/          shared UI and generated OpenAPI contracts
```

A successful agent delivery follows durable acceptance. Retries are idempotent.
Archive failures preserve data in a bounded Durable Object buffer and apply
backpressure. Raw values and source timestamps retain their original precision.
Summaries describe observed coverage and keep collection gaps explicit.

Topology shows discovered relationships. It does not establish request traffic
or distributed tracing. Missing provider evidence stays unknown. The supported
telemetry catalog covers Kubernetes and host resources; logs, traces and remote
shell commands are outside this release.

## Verification and releases

```sh
pnpm lint
pnpm generate
pnpm typecheck
pnpm build
pnpm test
pnpm test:worker
pnpm knip
go vet ./...
go test ./...
```

CI also runs Go race tests, lint and vulnerability checks. Reviewed `v*` tags
use **changelogithub** for GitHub release notes. Docker builds for the Go agent
are manual only. The hub and docs require no Docker or Coolify.

Original code is [MIT licensed](LICENSE). Dependencies retain their licenses;
see [third-party notices](THIRD_PARTY_NOTICES.md).
