# Operator UX verification

Every screenshot and the recording use the local production build on native
workerd with a disposable, clearly labelled synthetic fleet
(`apps/app/scripts/seed-demo.mjs`: "Synthetic production" and "Synthetic edge",
invented names, addresses and values). They contain no production telemetry,
topology, credentials or customer data. The enrollment token in the connect
flow is never revealed.

The synthetic fleet deliberately includes a not-ready node, a node at 92.8%
memory, a node under disk pressure, a CrashLoopBackOff pod, an OOM-restarted
pod, a pending DaemonSet pod, a retained failed batch pod, a registered cluster
that never reported, observed replica changes and a reported resize receipt.

## Operator journeys covered

| Journey | Evidence |
| --- | --- |
| Is anything wrong, where and since when? | [Overview](overview-desktop.png), [Attention](attention-desktop.png), [Overview on a phone](overview-mobile.png), [Light theme](overview-light-desktop.png) |
| What changed? | [Events & scaling](events-desktop.png) |
| Find any resource quickly | [Finder (Ctrl/Cmd+K)](finder-desktop.png) |
| Investigate a workload or pod | [Pods table](pods-desktop.png), [Pods on a phone](pods-mobile.png), [Pod inspector with request/limit lines](inspector-pod-desktop.png), [Servers](servers-desktop.png) |
| Follow configured structure | [Topology](topology-desktop.png), [Problems only](topology-problems-desktop.png), [Phone list view](topology-mobile.png), [Recording](topology.webm) |
| Connect a cluster | [Guided details step](connect-details-desktop.png) |
| Control collection | [Clusters & collection](settings-desktop.png) |
| Review a saved observation | [Time travel](time-travel-desktop.png) |

The recording drills from the namespace map into `shop`, expands and collapses
the `checkout` pods, opens the Deployment inspector and switches to Problems
only. Topology always states that it shows configured structure and that
traffic is not measured.

## Checks

- `pnpm lint`, `pnpm typecheck`, `pnpm knip`, `pnpm test` (160 unit tests),
  `pnpm build`, `pnpm test:start` and `pnpm test:worker` pass locally.
- `python scripts/test-install-helpers.py` passes.
- Each captured page reported no browser errors and no horizontal overflow at
  1440 px and 390 px.
- Independent review lenses (correctness, product truthfulness and credential
  handling, accessibility and mobile, onboarding command accuracy, request cost)
  were run; each finding was challenged by a separate verifier before fixing.

## Limits

- These captures establish local build and runtime behaviour only. Production
  deployment and live verification are recorded separately and privately.
- No server, storage, ingestion or agent protocol code changed. The machine
  API, Durable Object storage and archival paths are untouched.
- The install commands follow the repository chart defaults and
  `scripts/enroll-agent.py`; operators with custom chart values must adapt the
  Secret, TLS and namespace names.
