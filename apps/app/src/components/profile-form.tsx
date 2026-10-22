import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
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
import { useForm } from "@tanstack/react-form";
import { Timer, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useDisplay } from "../hooks/display";
import { minutesLeft } from "../lib/install-enrollment";
import { formatClock, timeZoneLabel } from "../lib/time";
import {
  activeDiagnostic,
  continuesDiagnostic,
  diagnosticMinutes,
  draftChanges,
  draftFromProfile,
  draftProblems,
  effectiveProfileName,
  knownNamespaces,
  type ProfileDraft,
  type ProfileName,
  profileChoices,
  profileNames,
  returnProfile,
} from "./collection-model";
import { NamespaceField } from "./collection-namespaces";

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

function ProfileChoices({
  value,
  profile,
  onChange,
}: {
  value: ProfileName;
  profile: Profile;
  onChange: (value: ProfileName) => void;
}) {
  const uid = useId();
  const { now } = useDisplay();
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-sm" id={`${uid}-legend`}>
        Collection profile
      </legend>
      <div
        aria-labelledby={`${uid}-legend`}
        className="grid gap-2 sm:grid-cols-3"
        role="radiogroup"
      >
        {profileNames.map((name) => {
          const badge = currentBadge(name, profile, now);
          return (
            <label
              className={cn(
                "group relative flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-colors hover:bg-muted/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                value === name && "border-primary bg-primary/5"
              )}
              key={name}
            >
              <input
                aria-describedby={`${uid}-${name}-detail`}
                checked={value === name}
                className="sr-only"
                name={`${uid}-profile`}
                onChange={() => onChange(name)}
                type="radio"
                value={name}
              />
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium text-sm">
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border",
                      value === name && "border-primary"
                    )}
                  >
                    {value === name && (
                      <span className="size-2 rounded-full bg-primary" />
                    )}
                  </span>
                  {profileChoices[name].label}
                </span>
                {badge && (
                  <Badge className="font-normal" variant="secondary">
                    {badge}
                  </Badge>
                )}
              </span>
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
    <div className="flex items-start gap-3 border-info/30 border-t pt-3">
      <Switch
        aria-describedby={`${uid}-note`}
        checked={checked}
        className="mt-0.5"
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

function ExpiryNote({
  id,
  node,
  extend,
  profile,
}: {
  id: string;
  node: string;
  extend: boolean;
  profile: Profile;
}) {
  const { now, timeZone } = useDisplay();
  const returnTo = profileChoices[returnProfile(profile)].label;
  const kept =
    !extend && continuesDiagnostic({ name: "diagnostic", node }, profile, now)
      ? activeDiagnostic(profile, now)
      : undefined;
  return (
    <p
      className="flex items-start gap-1.5 text-muted-foreground text-xs"
      id={id}
    >
      <Timer aria-hidden className="mt-px size-3.5 shrink-0 text-info-text" />
      <span>
        {kept
          ? `Keeps its current end time, ${formatClock(kept.expiresAt, timeZone)} ${timeZoneLabel(timeZone, kept.expiresAt)} (${minutesLeft(kept.expiresAt, now)} left), then returns to ${returnTo}.`
          : `Expires ${diagnosticMinutes} minutes after you apply, then returns to ${returnTo}.`}{" "}
        The node enforces the expiry itself, even if the hub is unreachable.
        Diagnostic samples stay queryable for 24 hours.
      </span>
    </p>
  );
}

function DiagnosticOptions({
  value,
  extend,
  nodes,
  profile,
  onChange,
  onExtendChange,
}: {
  value: string;
  extend: boolean;
  nodes: Entity[];
  profile: Profile;
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
  return (
    <div className="space-y-2 rounded-lg border border-info/40 bg-info/5 p-3">
      <Label htmlFor={`${uid}-node`}>Diagnostic node</Label>
      {nodes.length > 0 ? (
        <Select
          items={Object.fromEntries(nodes.map((node) => [node.uid, node.name]))}
          onValueChange={(next) => onChange(next ?? "")}
          value={value}
        >
          <SelectTrigger
            aria-describedby={`${uid}-note`}
            className="w-full sm:w-80"
            id={`${uid}-node`}
          >
            <SelectValue placeholder="Choose a node" />
          </SelectTrigger>
          <SelectContent>
            {nodes.map((node) => (
              <SelectItem key={node.uid} value={node.uid}>
                <span className="font-mono text-xs">{node.name}</span>
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
        profile={profile}
      />
      {continuing && (
        <RestartField checked={extend} onChange={onExtendChange} />
      )}
    </div>
  );
}

function PauseField({
  checked,
  current,
  onChange,
}: {
  checked: boolean;
  current: boolean;
  onChange: (value: boolean) => void;
}) {
  const uid = useId();
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <Switch
        aria-describedby={`${uid}-note`}
        checked={checked}
        className="mt-0.5"
        id={`${uid}-pause`}
        onCheckedChange={onChange}
      />
      <div className="space-y-1">
        <Label htmlFor={`${uid}-pause`}>Pause new samples</Label>
        <p className="text-muted-foreground text-xs" id={`${uid}-note`}>
          {current
            ? "Collection is paused now. Turn this off to resume new samples."
            : "Stops new metric samples from the observer and node collectors. Inventory and heartbeats continue, and stored history is preserved."}
        </p>
      </div>
    </div>
  );
}

function ApplyBar({
  changes,
  problems,
  pending,
  onDiscard,
}: {
  changes: string[];
  problems: string[];
  pending: boolean;
  onDiscard: () => void;
}) {
  const changed = changes.length > 0;
  return (
    <div className="space-y-3 border-t pt-4">
      {changed && (
        <div className="space-y-1">
          <p className="font-medium text-xs">Changes to apply</p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground text-xs">
            {changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </div>
      )}
      {changed && problems.length > 0 && (
        <ul aria-live="polite" className="space-y-1 text-warning-text text-xs">
          {problems.map((problem) => (
            <li className="flex items-start gap-1.5" key={problem}>
              <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              {problem}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!changed || problems.length > 0 || pending}
          type="submit"
        >
          {pending ? "Applying…" : "Apply changes"}
        </Button>
        {changed ? (
          <Button
            disabled={pending}
            onClick={onDiscard}
            type="button"
            variant="ghost"
          >
            Discard changes
          </Button>
        ) : (
          <span className="text-muted-foreground text-xs">
            No changes to apply.
          </span>
        )}
      </div>
    </div>
  );
}

function PauseConfirm({
  clusterName,
  open,
  onCancel,
  onConfirm,
}: {
  clusterName: string;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pause collection for {clusterName}?</DialogTitle>
          <DialogDescription>
            New metric samples stop on the observer and every node collector
            until you resume. Charts show a gap for this period; missing samples
            are never shown as zero. Inventory, heartbeats and stored history
            are kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onCancel} variant="outline">
            Keep collecting
          </Button>
          <Button onClick={onConfirm} variant="warning">
            Pause and apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Draft collection settings for one cluster. Nothing changes until Apply;
// the parent sends the request and reports acknowledgments.
export function ProfileForm({
  view,
  initialNodeUid,
  pending,
  onApply,
}: {
  view: ClusterView;
  initialNodeUid?: string;
  pending: boolean;
  onApply: (draft: ProfileDraft) => void;
}) {
  const [confirming, setConfirming] = useState<ProfileDraft>();
  const { now } = useDisplay();
  const nodes = view.inventory.entities.filter((e) => e.kind === "Node");
  const nodeName = (uid: string) =>
    nodes.find((node) => node.uid === uid)?.name ?? uid;
  const known = knownNamespaces(view);
  const inventory = new Set(
    view.inventory.entities.flatMap((entity) => {
      if (entity.kind === "Namespace") {
        return [entity.name];
      }
      return entity.namespace ? [entity.namespace] : [];
    })
  );
  const form = useForm({
    defaultValues: draftFromProfile(
      view.profile,
      nodes.some((node) => node.uid === initialNodeUid)
        ? initialNodeUid
        : undefined,
      now
    ),
    onSubmit: ({ value }) => {
      if (value.paused && !view.profile.paused) {
        setConfirming(value);
        return;
      }
      onApply(value);
    },
  });
  return (
    <form
      aria-label={`Collection settings for ${view.cluster.name}`}
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <ProfileChoices
            onChange={field.handleChange}
            profile={view.profile}
            value={field.state.value}
          />
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.name}>
        {(name) =>
          name === "diagnostic" && (
            <form.Field name="node">
              {(node) => (
                <form.Field name="extend">
                  {(extend) => (
                    <DiagnosticOptions
                      extend={extend.state.value}
                      nodes={nodes}
                      onChange={node.handleChange}
                      onExtendChange={extend.handleChange}
                      profile={view.profile}
                      value={node.state.value}
                    />
                  )}
                </form.Field>
              )}
            </form.Field>
          )
        }
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.values}>
        {(values) => (
          <NamespaceField
            disabled={pending}
            draft={values}
            inventory={inventory}
            known={known}
            onChange={(next) => {
              form.setFieldValue("scope", next.scope);
              form.setFieldValue("namespaces", next.namespaces);
            }}
          />
        )}
      </form.Subscribe>
      <form.Field name="paused">
        {(field) => (
          <PauseField
            checked={field.state.value}
            current={view.profile.paused}
            onChange={field.handleChange}
          />
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values}>
        {(values) => (
          <ApplyBar
            changes={draftChanges(values, view.profile, nodeName, now)}
            onDiscard={() => form.reset()}
            pending={pending}
            problems={draftProblems(values, nodes, view.profile, now)}
          />
        )}
      </form.Subscribe>
      <PauseConfirm
        clusterName={view.cluster.name}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => {
          if (confirming) {
            onApply(confirming);
          }
          setConfirming(undefined);
        }}
        open={!!confirming}
      />
    </form>
  );
}
