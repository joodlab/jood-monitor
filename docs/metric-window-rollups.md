# Metric windows and retention

Raw samples retain original OTLP attributes, resource, scope, units, int64 values
and source/start nanoseconds. Only `jood.source.window` is excluded from semantic
series identity; the source window stays in history and exports.

Latest observations are ordered by original nanoseconds, then receipt time and
stable identity. An older source arrival cannot replace a newer observation.
Five-minute and hourly summaries describe gauges and observed counter deltas.
Counter resets and gaps longer than 90 seconds do not add a fabricated delta.
Integer counter subtraction uses decimal arithmetic beyond JavaScript's safe
integer range. Hourly summaries include the boundary between five-minute parts.

Raw retention is seven days; Diagnostic raw retention is one day. Five-minute
summaries retain thirty days. Hourly summaries, inventories and events retain
180 days. Raw expiration is gated on committed summaries. The durable outbox
is never discarded merely because archival failed.

Accepted late samples must fall inside complete retained hourly buckets so a
summary is not rebuilt from an expired partial tail. Large queries return a
quota error; narrow history to an entity and metric instead of relying on a
truncated chart.

## Series read cost

Dashboard series reads parse whole five-minute cluster archives, so their
cost follows everything a cluster archived in the window, not only the
requested series. The parse budget (`SERIES_PARSE_POINTS`) is checked against
the archive index before any R2 read, and a larger read is refused with 413.

`pnpm --filter @jood-monitor/app test:worker` measures the cost on local
native workerd (Miniflare): six synthetic packed raw archives of 20,000
points each, about 906 bytes per stored point (108.8 MB decompressed,
11.7 MB compressed), filtered to one node and two metric names. Four runs on
a development workstation took 12.2 to 14.8 ms per 1,000 archived points,
median 13.4 ms. Three of those runs timed each stage:

| Stage, 120,000 points | Time |
| --- | --- |
| gunzip (`DecompressionStream`) | 728–795 ms |
| SHA-256 integrity check | 406–551 ms |
| `JSON.parse` | 279–339 ms |
| entity, name and window filter | 90–96 ms |

Reading the same objects through `readArchiveObject`, including the local R2
read, took 12.5 to 13.6 ms per 1,000 points. With a 2× safety factor on the
median, 22,000 points keep one request within about 600 ms locally, inside
the deployment's 1,000 ms CPU cap. Fifty single-container pods on five nodes
archive roughly 470 points a minute at the agent's cadences (pod, container
and node usage every 30 seconds, host CPU and memory every 60 seconds), so
such a cluster reaches the budget in under an hour of history: its charts
are refused with 413 for longer ranges, and can be for one hour, instead of
being drawn from part of the window.

Local workerd timing is not Worker `cpuTime`. Measuring production CPU needs
a non-production preview upload, which is an owner decision; revisit the
constant with that measurement.
