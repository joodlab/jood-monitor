# Prisma 8 on D1

Prisma CLI 8.0.0-rc.22 and @prisma/orm-sqlite 8.0.0-rc.17 are pinned independently.
The contract source is `apps/app/src/db/contract.prisma`. Emit `contract.json`
and `contract.d.ts` after edits; never modify generated artifacts directly.

The published SQLite driver imports `node:sqlite`, which workerd does not
provide. The custom D1 driver uses the same published target, adapter, codecs
and ORM facade with a native D1 binding. This is application code, not official
Prisma D1 support. Prisma 8's SQLite target remains experimental.

```sh
pnpm db:emit
pnpm --filter @jood-monitor/app db:plan --name your_change --from previous_ref
pnpm db:sql
pnpm --filter @jood-monitor/app db:migrate:local
```

Use `--from @empty` only for an initial empty database. For later changes select
the previous graph node or ref. Commit contract artifacts, migration packages
and generated D1 SQL together. The converter rejects transaction control and
cascading foreign-key actions.

D1 has no interactive transactions. Multi-statement ORM mutations are not
implicitly atomic. Guarded single-statement writes handle enrollment and
credential changes. The driver's `batch` commits plans through native D1.batch;
its interactive `transaction` method rejects by default.

Large inventories and raw telemetry use Durable Objects and R2. D1 contains
compact archive references. This version does not advertise PostgreSQL or MySQL
as runtime databases. Recovery must cover D1 indexes, Durable Object state and
their referenced R2 objects together.

Run native workerd tests after changing Prisma, the contract, driver or storage.
