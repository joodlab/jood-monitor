# Product specification

Operators group clusters into workspaces, enroll scoped observers, inspect
latest saved observations, and explicitly select historical times. The dashboard
offers fleet overview, service topology, servers, tabular resources, scaling
events and collection controls, including keyboard and mobile alternatives.

Basic collection limits host overhead. Standard adds selected counter sources
and Kubernetes CPU/memory. Diagnostic is scoped to selected nodes, expires
within ten minutes and returns to the prior profile locally. Pausing collection
preserves history. Observer and node acknowledgments are distinct.

Source time and receipt time have distinct meanings. Use stable Kubernetes UIDs
and declared metric units. Missing, stale or skewed data cannot appear as a
verified zero. Topology expresses discovered structure, not network traffic.

Lifecycle receipts are reported evidence; inventory diffs are observed evidence.
Neither establishes provider deletion or actor attribution without independent
proof. The API has no remediation or arbitrary command execution capability.
