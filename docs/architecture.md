# Architecture

The hub is one full-stack TanStack Start Cloudflare Worker. UI operations pass
through validated server functions, middleware, actions and scoped data access.
Machine endpoints preserve the Go agent's HTTP and OTLP protobuf protocol.
Fumadocs pages and search run in the same Worker at `/docs` and `/api/search`.
Documentation is public; dashboard pages, operator APIs and server functions
retain Basic Auth and mutation origin/CSRF checks.

```mermaid
flowchart LR
  Browser[Operator browser] --> App[TanStack Start Worker]
  Go[Go observers and collectors] --> App
  App --> D1[Prisma 8 and D1 registry]
  App --> State[Cluster Durable Object]
  State --> Queue[Queue notification]
  Queue --> State
  State --> R2[Immutable compressed R2 archives]
  State --> D1
  State --> Feed[Workspace WebSocket Durable Object]
  Feed --> Browser
```

D1 stores workspace and cluster identities, credential verifiers and archive
indexes. A cluster Durable Object owns current inventory, profiles,
acknowledgments, latest series, deduplication and the archival outbox. Its native
SQLite transaction is the acceptance boundary. OTLP responses are actual
protobuf acknowledgments, including partial rejection counts.

Accepted telemetry is stored in compressed five-minute cluster windows, with
batch receipts in the same SQLite row. Latest series are reconstructed from a
durable checkpoint and pending windows; no per-sample latest/index/counter writes
are needed. Existing per-entity rows remain readable and drain through the same
archival writer. Compressed control documents skip unchanged values.

Closed five-minute partitions are archived per cluster. Objects are immutable
and content checked. D1 exposes the index after upload succeeds. Outbox samples
are removed after raw and summary objects and indexes commit. Generation checks
preserve concurrent late arrivals. Alarms retry independently of queue delivery.

Inventory archives share unchanged topology by content hash. Five-minute receipt
partitions preserve every observation's exact source time, captured profile,
heartbeat and receipt times. Referenced content commits first and outlives its
receipts. Imported observations with explicit identities retain their original
representation. Older full snapshots and metadata-free receipts remain readable.

Source nanoseconds and int64 values stay strings or BigInt. Semantic series
identity excludes only the per-sample source window. Original attributes,
resource and scope remain available in raw history and exports.

Dashboard charts read raw history through one validated, scoped server
function per section (`getSeriesHistoryFn`): up to 20 entities and 9 metric
names over at most a day. The cluster Durable Object filters its outbox by
both sets in SQL, binding each set as one JSON value, and marks the reply as
filtered; an object from an earlier version answers with its unfiltered,
capped array, which the Worker refuses when cut and otherwise filters again.
The Worker then lists the overlapping raw and Diagnostic archives from D1,
refuses the read before any R2 get when the index shows too many archives or
archived points, and reads each object once in bounded groups. Rows are kept
only inside the source-time window (Diagnostic rows only within a day of
their source time), deduplicated, collapsed per series and source time by the
rule rollups use, and returned as compact exact-string points. A read that
does not fit is refused with 413, never truncated. REST history and frozen
snapshots keep the single-entity read.

Workspace notification objects use WebSocket hibernation. Reconnecting clients
resynchronize saved scoped state; periodic queries cover missed notifications.
Notifications are coalesced to one per thirty seconds. Durable alarms target
closed windows; ingestion does not enqueue a separate archive job for every batch.
The hub needs no provisioned application server, Redis or PostgreSQL.

Go handles Kubernetes identity checks, TokenReview, the dedicated token audience,
node collectors, local Diagnostic expiry and bounded buffering. The monitoring
control API cannot execute shell commands or modify infrastructure.
