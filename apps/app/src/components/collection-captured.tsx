import type { ClusterView } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  CalendarClock,
  CirclePause,
  Gauge,
  Info,
  KeyRound,
  ListChecks,
  RadioTower,
  Server,
} from "lucide-react";
import type { ReactNode } from "react";
import { useDisplay } from "../hooks/display";
import {
  captureTime,
  heartbeatKnown,
  metricsApiUnavailable,
  profileKnown,
  withCapturedHeartbeat,
} from "../lib/collection-state";
import { freshness } from "../lib/metrics";
import {
  age,
  formatClock,
  formatDateTime,
  knownTime,
  timeZoneLabel,
} from "../lib/time";
import { Capabilities, DeliveryHealth, Freshness } from "./collection-cluster";
import {
  activeDiagnostic,
  effectiveProfileName,
  nodeAcknowledgments,
  nodeNamer,
  profileLabel,
} from "./collection-model";
import { NodeAcknowledgments } from "./collection-nodes";
import { Notice } from "./connect-parts";
import { SettingsRail } from "./settings-rail";
import { TimeText } from "./time";

// One cluster's settings in a saved observation, read-only and as the hub
// captured them with that cluster's inventory: the collection profile and
// the observer's last heartbeat before it. Nothing here is current, so live
// values (a revoked credential, the hub buffer, enrollment) stay on the live
// view, and nothing is judged against this browser's clock.

function exactTime(time: number, timeZone: string) {
  return `${formatDateTime(time, timeZone, { year: "auto" })} ${timeZoneLabel(timeZone, time)}`;
}

// What the capture holds. `capture` is the inventory's receipt by the hub, or
// its source time where the receipt was not retained.
interface Capture {
  capture?: number;
  heartbeat: boolean;
  profile: boolean;
  received?: number;
  saved: boolean;
  view: ClusterView;
}

function captureOf(view: ClusterView): Capture {
  const saved = knownTime(view.inventory.sourceTime) != null;
  return {
    // The heartbeat time captured with the inventory, never a later one.
    view: withCapturedHeartbeat(view),
    saved,
    profile: saved && profileKnown(view, true),
    heartbeat: saved && heartbeatKnown(view, true),
    capture: captureTime(view),
    received: knownTime(view.cluster.receivedAt),
  };
}

function CapturedHeading({
  capture,
  workspaceName,
}: {
  capture: Capture;
  workspaceName: string;
}) {
  const { cluster, profile } = capture.view;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-card text-muted-foreground"
        >
          <Server className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-xl tracking-tight">
            {cluster.name}
          </h2>
          <p className="text-muted-foreground text-xs">
            <span className="font-mono">{cluster.id}</span> ·{" "}
            {cluster.environment || "No environment"} · {workspaceName}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="info">
          <CalendarClock aria-hidden />
          Saved observation
        </Badge>
        {capture.profile && capture.capture != null && (
          <Badge variant="outline">
            {profileLabel(effectiveProfileName(profile, capture.capture))}{" "}
            profile
          </Badge>
        )}
        {capture.profile && profile.paused && (
          <Badge variant="warning">
            <CirclePause aria-hidden />
            Paused
          </Badge>
        )}
      </div>
    </div>
  );
}

// What the hub stored with the inventory, naming only what it captured and
// saying which part it did not.
function storedSentence(capture: Capture, timeZone: string) {
  const receipt =
    capture.received == null
      ? "with this inventory"
      : `with the inventory it received at ${exactTime(capture.received, timeZone)}`;
  let stored = "these settings and the observer's last report";
  if (!capture.heartbeat) {
    stored = "these settings";
  } else if (!capture.profile) {
    stored = "the observer's last report";
  }
  const parts = [`Read-only. The hub stored ${stored} ${receipt}.`];
  if (!capture.heartbeat) {
    parts.push("The observer's report was not captured with it.");
  }
  if (!capture.profile) {
    parts.push("The collection settings were not captured with it.");
  }
  if (capture.heartbeat) {
    parts.push(
      "The heartbeat is the last one before that inventory, not a continuous record."
    );
  }
  parts.push("Return to live to stage or apply changes.");
  return parts.join(" ");
}

function captureSentences(
  capture: Capture,
  timeZone: string,
  selected: string
) {
  const { view } = capture;
  if (!(capture.saved && capture.capture != null)) {
    return [
      `No saved observation for ${view.cluster.name} at or before ${selected}.`,
    ];
  }
  const sentences: string[] = [];
  if (capture.profile || capture.heartbeat) {
    sentences.push(storedSentence(capture, timeZone));
  } else {
    sentences.push("Only the inventory was saved with this observation.");
  }
  if (capture.received == null) {
    const source = knownTime(view.inventory.sourceTime) ?? capture.capture;
    sentences.push(
      `Saved inventory from ${exactTime(source, timeZone)}; hub receipt time not retained.`
    );
  }
  return sentences;
}

// How far the capture is from the selected time, so a capture minutes or
// days older than the selected time is never read as that moment. The hub
// picks a saved inventory by its source time, at or before the selected
// time, so the hub's receipt of it (a spooled or delayed delivery) can come
// after the selected time.
function captureDistance(capture: Capture, referenceTime: number) {
  if (capture.capture == null) {
    return;
  }
  const event = capture.received == null ? "sampled" : "received";
  const delta = capture.capture - referenceTime;
  if (Math.abs(delta) < 1000) {
    return `This inventory was ${event} at the selected time.`;
  }
  if (delta > 0) {
    const source =
      capture.received == null ? "" : "; its source time is at or before it";
    return `This inventory was ${event} ${age(referenceTime, capture.capture)} after the selected time${source}.`;
  }
  return `This inventory was ${event} ${age(capture.capture, referenceTime)} before the selected time.`;
}

// "Return to live" replaces this captured section, and the focused button
// with it. Its request to move focus outlives that remount: a page opened at
// a saved time has no live snapshot yet, so the whole Settings page reloads
// before the live section appears.
let liveFocusRequested = false;

export function requestLiveFocus() {
  liveFocusRequested = true;
}

const selectedSection = '[role="tab"][aria-selected="true"]';

type FocusPage = Pick<Document, "activeElement" | "body" | "querySelector">;

// The page's main region, focusable only until it loses focus, as the
// dashboard focuses it.
function focusMain(page: FocusPage) {
  const main = page.querySelector<HTMLElement>("main");
  if (!main) {
    return;
  }
  if (!main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
    main.addEventListener("blur", () => main.removeAttribute("tabindex"), {
      once: true,
    });
  }
  main.focus();
}

// On the first live Settings render after "Return to live", focus lands on
// the selected section's tab, else the page's main region. It moves only
// while focus is lost (on the body), so it never takes focus from a control
// the operator has moved to since, and the request is spent either way.
export function settleLiveFocus(
  frozen: boolean,
  sections: Pick<HTMLElement, "querySelector"> | null | undefined,
  page: FocusPage = document
) {
  if (frozen || !liveFocusRequested) {
    return;
  }
  liveFocusRequested = false;
  if (page.activeElement && page.activeElement !== page.body) {
    return;
  }
  const tab = sections?.querySelector<HTMLElement>(selectedSection);
  if (tab) {
    tab.focus();
  } else {
    focusMain(page);
  }
}

function CaptureNotice({
  capture,
  onResumeLive,
}: {
  capture: Capture;
  onResumeLive: () => void;
}) {
  const { referenceTime, timeZone } = useDisplay();
  const selected = exactTime(referenceTime, timeZone);
  const distance = captureDistance(capture, referenceTime);
  return (
    <Notice
      icon={<Info className="size-4" />}
      role="status"
      title="As captured with this observation"
      tone="info"
    >
      {captureSentences(capture, timeZone, selected).map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
      {distance && (
        <p className="text-xs">
          {distance} Selected time: {selected}.
        </p>
      )}
      <Button
        className="h-8 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          requestLiveFocus();
          onResumeLive();
        }}
        size="sm"
        variant="outline"
      >
        Return to live
      </Button>
    </Notice>
  );
}

const heartbeatWords = {
  fresh: "fresh when this inventory arrived",
  stale: "stale when this inventory arrived",
  "clock skew": "ahead of this inventory's receipt",
  "not evaluated": "not evaluated",
};

// The captured heartbeat, judged against the inventory's receipt only.
function CapturedHeartbeat({ capture }: { capture: Capture }) {
  const { heartbeatAt } = capture.view.cluster;
  if (!(capture.heartbeat && capture.capture != null)) {
    return (
      <span className="text-muted-foreground">
        Not captured with this observation
      </span>
    );
  }
  // A capture without a heartbeat before it says so, whether or not the
  // hub's receipt time was kept to judge one against.
  const fresh = freshness(heartbeatAt, capture.capture);
  if (fresh === "unknown") {
    return (
      <span className="text-muted-foreground">
        No heartbeat had arrived before this inventory
      </span>
    );
  }
  const state = capture.received == null ? "not evaluated" : fresh;
  return (
    <span className={state === "stale" ? "text-warning-text" : undefined}>
      <TimeText
        absolute
        label="Last heartbeat the hub received before this inventory"
        value={heartbeatAt}
      />{" "}
      · {heartbeatWords[state]}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-xs">{children}</dd>
    </div>
  );
}

// Whether the captured Metrics API report explains missing samples at the
// selected time, and which heartbeat made it.
function MetricsApiReport({ view }: { view: ClusterView }) {
  const { referenceTime, timeZone } = useDisplay();
  const reported = knownTime(view.cluster.heartbeatAt);
  if (
    reported == null ||
    !view.heartbeat.capabilities.includes("metrics_api_unavailable")
  ) {
    return null;
  }
  const time = exactTime(reported, timeZone);
  return (
    <p className="text-muted-foreground text-xs">
      {metricsApiUnavailable(view, referenceTime, true)
        ? `The observer reported the Metrics API as unavailable in the heartbeat the hub received at ${time}; it explains missing node and pod CPU and memory at the selected time.`
        : `The observer reported the Metrics API as unavailable in the heartbeat the hub received at ${time}, which is not current enough to explain missing samples at the selected time.`}
    </p>
  );
}

function ObserverReport({ capture }: { capture: Capture }) {
  const { view } = capture;
  if (!capture.heartbeat) {
    return (
      <p className="text-muted-foreground text-sm">
        The observer report was not captured with this observation.
      </p>
    );
  }
  if (knownTime(view.cluster.heartbeatAt) == null) {
    return null;
  }
  return (
    <>
      <div className="space-y-1.5">
        <p className="font-medium text-sm">Delivery health</p>
        <DeliveryHealth absolute at={capture.capture} view={view} />
      </div>
      <div className="space-y-1.5">
        <p className="font-medium text-sm">Reported sources</p>
        {view.heartbeat.capabilities?.length ? (
          <Capabilities view={view} />
        ) : (
          <p className="text-muted-foreground text-xs">
            The captured heartbeat reported no sources.
          </p>
        )}
        <MetricsApiReport view={view} />
      </div>
    </>
  );
}

function CapturedObserver({ capture }: { capture: Capture }) {
  const { referenceTime } = useDisplay();
  const { view } = capture;
  return (
    <SettingsRail
      description="The observer's last report before the hub received this inventory, as stored with it."
      icon={RadioTower}
      title="Observer"
    >
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <Field label="Version">
          {/* Builds report a full commit hash; wrap it rather than shorten it. */}
          <span className="break-all font-mono">
            {capture.heartbeat
              ? view.heartbeat.version || "Not reported"
              : "Not captured"}
          </span>
        </Field>
        <Field label="Heartbeat">
          <CapturedHeartbeat capture={capture} />
        </Field>
        <Field label="Inventory">
          <span className="flex flex-wrap gap-x-1.5">
            <Freshness
              absolute
              at={referenceTime}
              kind="inventory"
              label="Inventory source time (observer clock)"
              value={view.inventory.sourceTime}
            />
            <span className="text-muted-foreground">
              ·{" "}
              {capture.received == null ? (
                "hub receipt time not retained"
              ) : (
                <>
                  received{" "}
                  <TimeText
                    absolute
                    label="Inventory received by the hub"
                    value={view.cluster.receivedAt}
                  />
                </>
              )}
            </span>
          </span>
        </Field>
      </dl>
      <ObserverReport capture={capture} />
      <p className="text-muted-foreground text-xs">
        The hub's archival buffer is shown on the live view only.
      </p>
    </SettingsRail>
  );
}

function diagnosticLine(view: ClusterView, at: number, timeZone: string) {
  const running = activeDiagnostic(view.profile, at);
  if (!running) {
    return "No Diagnostic running";
  }
  const nodes = running.nodeUids.map(nodeNamer(view)).join(", ");
  return `Diagnostic on ${nodes || "an unlisted node"} until ${formatClock(running.expiresAt, timeZone)} ${timeZoneLabel(timeZone, running.expiresAt)}, then ${profileLabel(running.returnTo)}`;
}

function CapturedCollection({ capture }: { capture: Capture }) {
  const { timeZone } = useDisplay();
  const { view } = capture;
  const { profile } = view;
  return (
    <SettingsRail
      description="The collection settings the hub held when it received this inventory."
      icon={Gauge}
      title="Collection"
    >
      {capture.profile && capture.capture != null ? (
        <>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Field label="Desired profile">
              {profileLabel(effectiveProfileName(profile, capture.capture))}
            </Field>
            <Field label="Pause">
              {profile.paused ? "Paused" : "Not paused"}
            </Field>
            <Field label="Pod metrics namespaces">
              {profile.namespaces.length
                ? profile.namespaces.join(", ")
                : "All namespaces"}
            </Field>
            <Field label="Diagnostic">
              {diagnosticLine(view, capture.capture, timeZone)}
            </Field>
          </dl>
          <p className="text-muted-foreground text-xs tabular-nums">
            Desired revision {profile.revision}; observer applied{" "}
            {profile.appliedRevision}.
          </p>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Collection settings were not captured with this observation.
        </p>
      )}
    </SettingsRail>
  );
}

function CapturedAcknowledgments({ capture }: { capture: Capture }) {
  const { view } = capture;
  let body: ReactNode = (
    <p className="text-muted-foreground text-sm">
      Node acknowledgments were not captured with this observation.
    </p>
  );
  if (capture.heartbeat && capture.profile && capture.capture != null) {
    body =
      knownTime(view.cluster.heartbeatAt) == null ? (
        <p className="text-muted-foreground text-sm">
          No heartbeat had arrived before this inventory, so no node
          acknowledgments were captured.
        </p>
      ) : (
        <NodeAcknowledgments
          absolute
          rows={nodeAcknowledgments(view, capture.capture)}
          view={view}
        />
      );
  }
  return (
    <SettingsRail
      description="Each node's acknowledgment in the captured heartbeat, judged when the hub received this inventory."
      icon={ListChecks}
      title="Node acknowledgments"
    >
      {body}
    </SettingsRail>
  );
}

export function CapturedClusterSettings({
  view,
  workspaceName,
  onResumeLive,
}: {
  view: ClusterView;
  workspaceName: string;
  onResumeLive: () => void;
}) {
  const capture = captureOf(view);
  return (
    <div className="space-y-4">
      <CapturedHeading capture={capture} workspaceName={workspaceName} />
      <CaptureNotice capture={capture} onResumeLive={onResumeLive} />
      {capture.saved && (
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          <CapturedObserver capture={capture} />
          <CapturedCollection capture={capture} />
          <CapturedAcknowledgments capture={capture} />
          <SettingsRail icon={KeyRound} last title="Enrollment">
            <p className="text-muted-foreground text-xs">
              Enrollment and credentials are managed on the live view.
            </p>
          </SettingsRail>
        </div>
      )}
    </div>
  );
}
