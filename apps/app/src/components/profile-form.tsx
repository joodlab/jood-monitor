import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Label } from "@jood-monitor/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import { Switch } from "@jood-monitor/ui/switch";
import { cn } from "@jood-monitor/ui/utils";
import { Timer } from "lucide-react";
import { useId } from "react";
import { useDisplay } from "../hooks/display";
import { minutesLeft } from "../lib/install-enrollment";
import { formatClock, timeZoneLabel } from "../lib/time";
import {
  activeDiagnostic,
  continuesDiagnostic,
  diagnosticMinutes,
  diagnosticNodeOptions,
  effectiveProfileName,
  type ProfileName,
  profileChoices,
  profileNames,
  returnProfile,
} from "./collection-model";
import { StagedPill, stagedSurface } from "./settings-rail";

// Collection settings controls. Each edits the cluster's staged draft;
// nothing reaches the hub until the operator applies the staged changes.

type Profile = ClusterView["profile"];

function currentBadge(choice: ProfileName, profile: Profile, now: number) {
  if (choice !== effectiveProfileName(profile, now)) {
    return;
  }
  const diagnostic = activeDiagnostic(profile, now);
  return diagnostic
    ? `Running · ${minutesLeft(diagnostic.expiresAt, now)} left`
    : "Current";
}

function ChoiceDot({ checked, staged }: { checked: boolean; staged: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border",
        checked && (staged ? "border-staged" : "border-primary")
      )}
    >
      {checked && (
        <span
          className={cn(
            "size-2 rounded-full",
            staged ? "bg-staged" : "bg-primary"
          )}
        />
      )}
    </span>
  );
}

export function ProfileChoices({
  value,
  profile,
  staged,
  disabled,
  onChange,
}: {
  value: ProfileName;
  profile: Profile;
  staged: boolean;
  disabled: boolean;
  onChange: (value: ProfileName) => void;
}) {
  const uid = useId();
  const { now } = useDisplay();
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">Collection profile</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {profileNames.map((name) => {
          const badge = currentBadge(name, profile, now);
          const checked = value === name;
          const pending = checked && staged;
          return (
            <label
              className={cn(
                "relative flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-colors hover:bg-muted/40 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                checked && !pending && "border-primary bg-primary/5",
                pending && stagedSurface
              )}
              key={name}
            >
              <input
                aria-describedby={`${uid}-${name}-detail`}
                checked={checked}
                className="sr-only"
                name={`${uid}-profile`}
                onChange={() => onChange(name)}
                type="radio"
                value={name}
              />
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium text-sm">
                  <ChoiceDot checked={checked} staged={pending} />
                  {profileChoices[name].label}
                </span>
                {pending && <StagedPill />}
                {badge && !pending && (
                  <Badge className="font-normal" variant="secondary">
                    {badge}
                  </Badge>
                )}
              </span>
              {badge && pending && (
                <span className="text-muted-foreground text-xs">
                  In effect: {badge}
                </span>
              )}
              <span
                className="text-muted-foreground text-xs leading-relaxed"
                id={`${uid}-${name}-detail`}
              >
                {profileChoices[name].detail}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// When the selected node already runs the diagnostic, applying other changes
// keeps its end time; restarting the window is an explicit choice.
function RestartField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const uid = useId();
  return (
    <div className="flex items-start gap-3 border-t pt-3">
      <Switch
        aria-describedby={`${uid}-note`}
        checked={checked}
        className="mt-0.5 data-checked:bg-staged"
        id={`${uid}-restart`}
        onCheckedChange={onChange}
      />
      <div className="space-y-1">
        <Label htmlFor={`${uid}-restart`}>
          Restart the {diagnosticMinutes}-minute window
        </Label>
        <p className="text-muted-foreground text-xs" id={`${uid}-note`}>
          Runs the diagnostic for {diagnosticMinutes} minutes from when you
          apply. Leave this off to keep the current end time.
        </p>
      </div>
    </div>
  );
}

function expiryText(
  node: string,
  extend: boolean,
  nodes: Entity[],
  profile: Profile,
  now: number,
  timeZone: string
) {
  const returnTo = profileChoices[returnProfile(profile)].label;
  const running = continuesDiagnostic(
    { name: "diagnostic", node },
    profile,
    now
  )
    ? activeDiagnostic(profile, now)
    : undefined;
  if (!running) {
    return `Expires ${diagnosticMinutes} minutes after you apply, then returns to ${returnTo}.`;
  }
  // Every node the running diagnostic covers, not only the one selected
  // above: applying keeps them all.
  const names = running.nodeUids
    .map((uid) => nodes.find((item) => item.uid === uid)?.name ?? uid)
    .join(", ");
  if (extend) {
    return `Restarts on ${names} for ${diagnosticMinutes} minutes from when you apply, then returns to ${returnTo}.`;
  }
  return `Keeps running on ${names} until its current end time, ${formatClock(running.expiresAt, timeZone)} ${timeZoneLabel(timeZone, running.expiresAt)} (${minutesLeft(running.expiresAt, now)} left), then returns to ${returnTo}.`;
}

function ExpiryNote({
  id,
  node,
  extend,
  nodes,
  profile,
}: {
  id: string;
  node: string;
  extend: boolean;
  nodes: Entity[];
  profile: Profile;
}) {
  const { now, timeZone } = useDisplay();
  return (
    <p
      className="flex items-start gap-1.5 text-muted-foreground text-xs"
      id={id}
    >
      <Timer aria-hidden className="mt-px size-3.5 shrink-0 text-info-text" />
      <span>
        {expiryText(node, extend, nodes, profile, now, timeZone)} Each node
        enforces the expiry itself, even if the hub is unreachable. Diagnostic
        host samples are stored and available through the history API for 24
        hours. Host CPU and memory are charted in the node's Metrics tab;
        network, disk and filesystem samples are not yet charted.
      </span>
    </p>
  );
}

export function DiagnosticOptions({
  value,
  extend,
  nodes,
  profile,
  staged,
  disabled,
  onChange,
  onExtendChange,
}: {
  value: string;
  extend: boolean;
  nodes: Entity[];
  profile: Profile;
  staged: boolean;
  disabled: boolean;
  onChange: (uid: string) => void;
  onExtendChange: (value: boolean) => void;
}) {
  const uid = useId();
  const { now } = useDisplay();
  const continuing = continuesDiagnostic(
    { name: "diagnostic", node: value },
    profile,
    now
  );
  const options = diagnosticNodeOptions(nodes, profile, now);
  // Any node of the running diagnostic selects its one choice.
  const selected = continuing
    ? (activeDiagnostic(profile, now)?.nodeUids[0] ?? value)
    : value;
  return (
    <fieldset
      className={cn(
        "space-y-2 rounded-lg border p-3",
        staged ? stagedSurface : "border-info/40 bg-info/5"
      )}
      disabled={disabled}
    >
      <legend className="sr-only">Diagnostic options</legend>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${uid}-node`}>Diagnostic node</Label>
        {staged && <StagedPill />}
      </div>
      {nodes.length > 0 ? (
        <Select
          disabled={disabled}
          items={Object.fromEntries(
            options.map((option) => [option.value, option.label])
          )}
          onValueChange={(next) => onChange(next ?? "")}
          value={selected}
        >
          <SelectTrigger
            aria-describedby={`${uid}-note`}
            className="w-full sm:w-80"
            id={`${uid}-node`}
          >
            <SelectValue placeholder="Choose a node" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="font-mono text-xs">{option.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-muted-foreground text-xs" id={`${uid}-node`}>
          No nodes in the inventory yet.
        </p>
      )}
      <ExpiryNote
        extend={extend}
        id={`${uid}-note`}
        node={value}
        nodes={nodes}
        profile={profile}
      />
      {continuing && (
        <RestartField checked={extend} onChange={onExtendChange} />
      )}
    </fieldset>
  );
}

export function PauseField({
  checked,
  current,
  staged,
  disabled,
  onChange,
}: {
  checked: boolean;
  current: boolean;
  staged: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const uid = useId();
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3",
        staged && stagedSurface
      )}
    >
      <Switch
        aria-describedby={`${uid}-note`}
        checked={checked}
        className={cn("mt-0.5", staged && "data-checked:bg-staged")}
        disabled={disabled}
        id={`${uid}-pause`}
        onCheckedChange={onChange}
      />
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${uid}-pause`}>Pause new samples</Label>
          {staged && <StagedPill />}
        </div>
        <p className="text-muted-foreground text-xs" id={`${uid}-note`}>
          {current
            ? "Collection is paused now. Turn this off to resume new samples."
            : "Stops new metric samples from the observer and node collectors. Inventory and heartbeats continue, and stored history is preserved."}
          {staged &&
            (checked
              ? " Staged: applying pauses collection after a confirmation."
              : " Staged: applying resumes new samples.")}
        </p>
      </div>
    </div>
  );
}
