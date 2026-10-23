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
read, took 12.5 to 13.6 ms per 1,000 points.

Because archives are cluster-wide, the budget is sized for the default
one-hour window. An hour holds up to 13 five-minute raw archives plus the
cluster-wide Diagnostic archives in the window. The raw archives are:

- Fifty single-container pods on five nodes archive roughly 470 points a
  minute at the agent's cadences (pod, container and node usage every 30
  seconds, host CPU and memory every 60 seconds), about 2,350 points per
  archive and about 30,500 points for the hour.
- A busier cluster archives about 3,200 points per archive, about 38,500
  points an hour and about 41,600 points for a 13-archive window. A budget
  sized only for the smaller cluster would refuse its default Pod, Node and
  Host charts.

The budget is 56,000 points. That admits the busier cluster's hour with about
a third to spare, and costs about 750 ms locally at the median and about 830
ms at the slowest run, under the deployment's 1,000 ms CPU cap: about 1.3×
headroom at the local median, not 2×. Six hours (about 172,000 points for the
smaller cluster, about 234,000 for the busier one) and a day are refused with
413 instead of being drawn from part of the window. A cluster archiving more
than about 4,300 points per archive, about 1.8 times the smaller cluster, can
be refused even at one hour, until summary resolutions serve longer windows.

The Diagnostic archives are not sized into the budget, because raising it
would pass the CPU cap. A Diagnostic samples host data every 5 seconds on its
nodes, and its archives are cluster-wide, so every read in the cluster whose
window overlaps it counts them, whichever entities it asks for. On a busy
cluster a Diagnostic can exceed the budget: three nodes for ten minutes add
about 20,900 points, more than the 14,400 the busier cluster's hour leaves.
The read then degrades explicitly rather than refusing the hour:

- Raw and Diagnostic points are counted separately from the archive index,
  before any R2 read. When both fit the budget, both are read.
- When only the raw archives fit, only they are read. The response lists
  each left-out Diagnostic window in `omitted`, with the omitted archives'
  exact source-time bounds and archived points, and holds none of that
  window's Diagnostic samples, including any still in the outbox.
- When the raw archives alone exceed the budget, the read is refused with
  413, with no R2 read.
- Diagnostic archives whose samples are all past the one-day Diagnostic
  retention are neither read nor counted.

The dashboard leaves an omitted period blank, with no line or counter rate
across it, says so, and can load the period on its own: the omitted window
with a minute either side, normally five raw archives and the Diagnostic
ones. That read keeps the same budget; if it still does not fit, the
dashboard says so plainly. Charging a Diagnostic only to reads of its scoped
nodes and their Pods would need the archival writer to pack Diagnostic
partitions per node, which is an owner decision.

Local workerd timing is not Worker `cpuTime`. Measuring production CPU needs
a non-production preview upload, which is an owner decision; revisit the
constant with that measurement.
