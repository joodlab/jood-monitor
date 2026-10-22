import { Button } from "@jood-monitor/ui/button";
import { Input } from "@jood-monitor/ui/input";
import { Label } from "@jood-monitor/ui/label";
import {
  ArrowRight,
  BookOpen,
  CircleAlert,
  Eye,
  EyeOff,
  Info,
  TriangleAlert,
} from "lucide-react";
import { useId, useState } from "react";
import { useDisplay } from "../hooks/display";
import { hubOriginProblem, installSteps } from "../lib/install-commands";
import { countdown, type Enrollment } from "../lib/install-enrollment";
import { formatClock, timeZoneLabel } from "../lib/time";
import { CommandBlock, CopyButton, Notice, useNow } from "./connect-parts";

function TokenPanel({
  enrollment,
  onRenew,
}: {
  enrollment: Enrollment;
  onRenew: () => void;
}) {
  const uid = useId();
  const now = useNow();
  const { timeZone } = useDisplay();
  const [revealed, setRevealed] = useState(false);
  const expiry = Date.parse(enrollment.expiresAt);
  const exact = `${formatClock(expiry, timeZone)} ${timeZoneLabel(timeZone, expiry)}`;
  if (expiry <= now) {
    return (
      <Notice
        icon={<CircleAlert className="size-4" />}
        role="alert"
        title="This enrollment token expired"
        tone="destructive"
      >
        <p>
          It expired at {exact} and can no longer be exchanged. Renew the
          enrollment to get a new one-time token; history is kept.
        </p>
        <Button className="h-8" onClick={onRenew} size="sm" variant="outline">
          Renew enrollment
        </Button>
      </Notice>
    );
  }
  return (
    <Notice
      icon={<TriangleAlert className="size-4" />}
      title="One-time enrollment token — shown only in this dialog"
      tone="warning"
    >
      <p className="text-xs">
        Copy it now; it is not shown again once this dialog closes. Keep it out
        of screenshots, tickets, chat and shell history. It can be exchanged
        once and expires in{" "}
        <span className="font-medium tabular-nums">
          {countdown(expiry, now)}
        </span>{" "}
        (at {exact}).
      </p>
      <Label className="sr-only" htmlFor={`${uid}-token`}>
        One-time enrollment token
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoComplete="off"
          className="h-8 min-w-0 flex-1 basis-48 font-mono text-xs"
          id={`${uid}-token`}
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          spellCheck={false}
          type={revealed ? "text" : "password"}
          value={enrollment.enrollmentToken}
        />
        <Button
          aria-pressed={revealed}
          className="h-8"
          onClick={() => setRevealed((value) => !value)}
          size="sm"
          type="button"
          variant="outline"
        >
          {revealed ? <EyeOff /> : <Eye />}
          {revealed ? "Hide" : "Reveal"}
        </Button>
        <CopyButton
          className="h-8"
          label="Copy enrollment token"
          value={enrollment.enrollmentToken}
        />
      </div>
    </Notice>
  );
}

export function ConnectInstall({
  enrollment,
  onContinue,
  onRenew,
}: {
  enrollment: Enrollment;
  onContinue: () => void;
  onRenew: () => void;
}) {
  const [fullSteps, setFullSteps] = useState(false);
  const origin = window.location.origin;
  const originProblem = hubOriginProblem(origin);
  const kind = enrollment.kind === "recover" && !fullSteps ? "recover" : "new";
  const steps = installSteps({
    origin,
    clusterId: enrollment.cluster.id,
    kind,
  });
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {enrollment.kind === "new"
          ? "Registered "
          : "Renewed the enrollment for "}
        <span className="font-medium">{enrollment.cluster.name}</span> (
        <span className="font-mono text-xs">{enrollment.cluster.id}</span>) in
        workspace{" "}
        <span className="font-mono text-xs">
          {enrollment.cluster.workspaceId}
        </span>
        .
      </p>
      <TokenPanel enrollment={enrollment} onRenew={onRenew} />
      {originProblem && (
        <Notice icon={<Info className="size-4" />} tone="info">
          <p className="text-xs">{originProblem}</p>
        </Notice>
      )}
      <ol className="space-y-4">
        {steps.map((step, index) => (
          <li className="space-y-2" key={step.id}>
            <p className="font-medium text-sm">
              <span className="mr-1.5 text-muted-foreground tabular-nums">
                {index + 1}.
              </span>
              {step.title}
            </p>
            <p className="text-muted-foreground text-xs">{step.detail}</p>
            <CommandBlock command={step.command} label={step.title} />
          </li>
        ))}
      </ol>
      {enrollment.kind === "recover" && (
        <Button
          aria-pressed={fullSteps}
          className="h-8 px-0"
          onClick={() => setFullSteps((value) => !value)}
          size="sm"
          type="button"
          variant="link"
        >
          {fullSteps
            ? "Show only the credential replacement"
            : "Observer not installed yet? Show the full installation"}
        </Button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <a
          className="inline-flex items-center gap-1.5 text-primary text-xs underline underline-offset-2"
          href="/docs/agents#enrollment"
          rel="noopener"
          target="_blank"
        >
          <BookOpen aria-hidden className="size-3.5" />
          Enrollment guide
        </a>
        <Button onClick={onContinue} type="button">
          I've run these commands
          <ArrowRight />
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        The hub is already checking for the first heartbeat and moves on as soon
        as it arrives.
      </p>
    </div>
  );
}
