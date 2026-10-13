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
