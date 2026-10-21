# Free-tier operation

The normal ingestion path writes compressed source windows instead of creating
several SQL rows for every metric. A batch in the current source window costs one
SQLite row write regardless of its point count. A late batch may touch additional
windows. Its receipt commits atomically with its samples. Archival clears samples
only after raw, five-minute and hourly objects and their D1 indexes commit.

The native storage regression checks both one and one thousand samples against
Cloudflare's `SqlStorageCursor.rowsWritten`. It also checks restart, exact int64
and nanosecond preservation, late arrivals, scoped history and rollback.

After legacy raw rows drain, ingestion skips per-point SQL probes against the
empty legacy table. Control keys migrate once in the same atomic transaction
that saves their combined document. Native read counters cover both paths,
including legacy duplicates, rollback, restart and the transition after draining.

Control changes in one transaction share a compressed state document, and
unchanged values are skipped. Inventory observations retain separate durable
outbox documents and drain in batches of twelve. Unchanged inventory content is
stored once; five-minute receipt archives retain every observation's exact source
time, receipt times, heartbeat and profile. Content is published before receipts,
and its retention extends before newer references are published. Content expiry
updates occur at most daily. An archived receipt clears its outbox only after both
objects and indexes commit. Existing full inventory archives remain readable;
explicitly identified imported observations keep their original separate identity.
Receipt partitions are bounded to 5,000 observations and the existing 32 MiB
archive quota; an archival failure retains the durable outbox and applies normal
backpressure. Heartbeats
persist profile changes only when the applied profile actually changes. Workspace
notifications are coalesced to thirty seconds. An alarm targets the next closed
five-minute window, with bounded retries for pending archival. Queues remain
available to drain older messages, but normal ingestion sends no queue messages.
Expiry checks explicitly use the existing expiry index; bounded metric-history
queries constrain both ends of the source window. Cleanup must not scan all
unexpired archives on every wakeup. The native D1 regression verifies the empty
expiry lookup against populated archive data.
Expiry and orphan cleanup share the hourly maintenance gate, limiting each pass
to 200 expired indexes and 100 obsolete object receipts. An existing backlog can
therefore take several passes to drain. Raw archival and retry acknowledgments
continue independently of this cleanup cadence.

Visible dashboards use stream notifications coalesced to thirty seconds, with a
two-minute polling safety net while connected and thirty-second polling during
reconnection. Hidden tabs defer stream refreshes until visible. Historical views
remain frozen. This bounds browser-driven requests without dropping observations.

## Admission and capacity

Each cluster admits at most 240 machine mutations per minute and 90,000 weighted
ingress units per UTC day: a metric batch uses two units, a heartbeat one,
inventory four and lifecycle receipts eight. Both limits use durable reservations;
restarts cannot reset them. Unused reservations can reduce the available budget
after a restart. Profile changes and archive recovery remain available when
ingress is limited. Requests exceeding admission receive HTTP 429 and are not
acknowledged; agents retain them within their existing bounded spool.

These units bound normal ingress volume; they are not an invoice meter. Late
windows, topology changes, retention cleanup, retries, multiple clusters and other
applications on the account also consume resources. Monitor actual account usage.
The free envelope must include DO reads, writes, requests and duration, D1, R2
storage and operations, and Worker requests/CPU. Do not infer a zero bill merely
from a small database or a passing storage test.

Cloudflare's published free allowances include 100,000 DO row writes, five million
DO row reads and 100,000 DO requests per day; D1 has its own daily read/write
allowances. R2 Standard includes 10 GB-month, one million Class A and ten million
Class B operations per month. These are shared account allowances. A paid account
can charge overages, while exceeding the Workers Free plan's hard limits fails
operations. This application does not change the account plan or purchase capacity.

Sources: [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/),
[Workers](https://developers.cloudflare.com/workers/platform/pricing/).

## Existing deployments

Deploy into the existing Worker and preserve its D1, R2 and Durable Object
bindings and secrets. Legacy telemetry, batch receipts and archives remain
readable. Initial draining and normal retention of existing per-sample rows may
temporarily exceed the new steady-state write rate. Do not delete accepted data
to make a usage graph smaller. Once compact rows have been accepted, recovery
must use this version or a compatible later version; an older binary cannot
read them.
Recovery of metadata-bearing inventory receipts also requires this version or a
compatible later version. Older readers can display topology from those receipts
but cannot reconstruct their captured profile and heartbeat metadata.
