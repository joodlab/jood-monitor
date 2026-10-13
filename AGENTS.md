# Jood Monitor contributor instructions

Read `docs/implementation-brief.md`, `docs/specification.md`,
`docs/architecture.md`, and `docs/self-hosting-and-acceptance.md` before work.

- The hub is a full-stack TypeScript TanStack Start application deployed to
  Cloudflare with the `cf` CLI. Agents remain Go. Documentation is a separate
  Fumadocs TanStack Start Worker. The hub and docs require no Docker or Coolify.
- Use pnpm workspaces, Turborepo, thin routes, validated server functions,
  actions, data access, Prisma contracts and shared schemas. Use default
  shadcn primitives, TanStack Query/Form/Table, pinned TanStack Charts, and
  React Flow. Keep units, source times, freshness and gaps explicit.
- Prisma 8 SQLite is experimental. Pin matching contract/runtime versions,
  generate artifacts rather than hand editing them, and run native D1 and
  Durable Object tests. D1 interactive transactions are unsupported; critical
  multi-statement writes use native atomic D1 batches.
- Acknowledged telemetry must survive retries and archival failures. Maintain
  a single archival writer per cluster, bounded durable outboxes, exact source
  values and nanoseconds, and recovery from backpressure. Archive raw samples
  and both summaries before clearing the outbox. Never imply missing samples
  are zero or observed topology is verified traffic.
- Keep machine scopes, one-use enrollment, node identity, TLS, operator Basic
  Auth, CSRF and WebSocket origin checks. No remote shell or remediation API.
- Do not rotate, replace, revoke or delete credentials without authorization.
  Never put credentials, private topology, customer data or production evidence
  in source, public PRs, logs, screenshots or release assets.
- Coordinate production cutovers and agent rollouts with the relevant
  infrastructure owner. Preserve unrelated work and existing infrastructure
  ownership. Do not buy capacity for tests.
- Run Biome/Ultracite, Knip, generated-contract checks, type checks, focused
  tests and browser verification. Go changes require gofmt, vet, tests, Linux
  race tests, golangci-lint and govulncheck; measure resource usage when it changes.
- Ready PRs must not remain drafts. Include screenshots and a short topology
  recording for visible changes, using clearly labeled synthetic data. Explain
  any missing visual evidence and provide equivalent verification.
- Pull-request CI must never build Docker images. Agent images are built only
  by an explicit manual workflow. Release tags use changelogithub; distinguish
  source, CI, artifacts, deployment and live infrastructure acceptance.
