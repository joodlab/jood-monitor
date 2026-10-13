# Hosting and acceptance

Deploy the TanStack app and Fumadocs app to Cloudflare Workers. Provision D1,
R2, Queues and SQLite Durable Object bindings for the hub. Keep operator secrets
private, use HTTPS, and enroll Go observers with one-use tokens. The chart
requires a reviewed immutable agent image digest and observer TLS assets.

Acceptance requires deployment identity, UI and docs navigation, live enrolled
agents, independently matched source values, correct units and freshness,
bounded resource overhead and tested failure/recovery. Local and CI passes do
not establish those production outcomes.

Before moving an existing hub, inventory identities and hash-based credentials,
profiles, original source timestamps, raw telemetry, summaries and lifecycle
evidence. Retain the previous system and verified backups. Use one authoritative
writer at cutover, drain/replay buffers, compare values and scopes, and verify
recovery. A DNS rollback alone does not reconcile data accepted after cutover.

No paid capacity purchase is required for the included tests. Account plan
limits and workload-dependent usage still need verification for each deployment.
