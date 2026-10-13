# Implementation brief

Jood Monitor uses a TypeScript full-stack TanStack Start hub on Cloudflare,
Prisma 8 with D1, and Go agents on the monitored infrastructure. The docs app
uses Fumadocs and deploys independently. No Docker or Coolify is needed for
the hub. Go agents may run from binaries or the manually released image.

Use route, hook, function, action, data-access, schema and database layers.
Keep default shadcn primitives, TanStack Query/Form/Table/Charts and stable
React Flow exploration. Pin experimental dependencies and disclose their limits.

Preserve exact telemetry, scope enforcement, safe enrollment, local Diagnostic
expiry, freshness, durable retries and recovery. Missing observations and
unverified provider attribution must remain explicit.

Release with conventional commits, changelogithub, reviewed version tags,
checksummed binaries and chart artifacts. Docker builds are manual only.
Original source is MIT; third-party notices and licenses remain intact.

Keep private infrastructure, credentials and operational evidence out of public
source, history, pull requests and release artifacts. Live acceptance and
publication require separate verification from successful local or CI checks.
