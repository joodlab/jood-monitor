import type { ClusterView } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Input } from "@jood-monitor/ui/input";
import { Label } from "@jood-monitor/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import { Switch } from "@jood-monitor/ui/switch";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateProfileFn } from "../functions/clusters";
import { nodeProfileOutcome } from "../lib/metrics";
import { profileSchema } from "../schemas/clusters";
export function ProfileForm({
  view,
  frozen = false,
  initialNodeUid,
}: {
  view: ClusterView;
  frozen?: boolean;
  initialNodeUid?: string;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (data: {
      name: string;
      node: string;
      paused: boolean;
      namespaces: string;
    }) =>
      updateProfileFn({
        headers: { "X-Jood-CSRF": "1" },
        data: {
          clusterId: view.cluster.id,
          profile: profileSchema.parse({
            name: data.name,
            revision: view.profile.revision,
            appliedRevision: 0,
            paused: data.paused,
            nodeUids:
              data.name === "diagnostic" && data.node ? [data.node] : [],
            namespaces: [
              ...new Set(
                data.namespaces
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean)
              ),
            ],
            ...(data.name === "diagnostic"
              ? { expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() }
              : {}),
          }),
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snapshot"] }),
  });
  const form = useForm({
    defaultValues: {
      name: view.profile.name,
      node: initialNodeUid || view.profile.nodeUids[0] || "",
      paused: view.profile.paused,
      namespaces: view.profile.namespaces.join(", "),
    },
    onSubmit: ({ value }) => mutation.mutateAsync(value),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={`profile-${view.cluster.id}`}>
              Collection profile
            </Label>
            <Select
              disabled={frozen}
              onValueChange={(v) => field.handleChange(v ?? "basic")}
              value={field.state.value}
            >
              <SelectTrigger id={`profile-${view.cluster.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["basic", "standard", "diagnostic"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </form.Field>
      <form.Field name="node">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={`node-${view.cluster.id}`}>
              Diagnostic node (9 minutes)
            </Label>
            <Select
              disabled={frozen}
              onValueChange={(v) => field.handleChange(v ?? "")}
              value={field.state.value}
            >
              <SelectTrigger id={`node-${view.cluster.id}`}>
                <SelectValue placeholder="Choose a node">
                  {view.inventory.entities.find(
                    (node) => node.uid === field.state.value
                  )?.name || "Choose a node"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {view.inventory.entities
                  .filter((e) => e.kind === "Node")
                  .map((e) => (
                    <SelectItem key={e.uid} value={e.uid}>
                      {e.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </form.Field>
      <form.Field name="namespaces">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={`namespaces-${view.cluster.id}`}>
              Pod metrics namespaces
            </Label>
            <Input
              disabled={frozen}
              id={`namespaces-${view.cluster.id}`}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder="All namespaces; or comma-separated names"
              value={field.state.value}
            />
          </div>
        )}
      </form.Field>
      <form.Field name="paused">
        {(field) => (
          <div className="flex items-center gap-3">
            <Switch
              checked={field.state.value}
              disabled={frozen}
              id={`pause-${view.cluster.id}`}
              onCheckedChange={field.handleChange}
            />
            <Label htmlFor={`pause-${view.cluster.id}`}>
              Pause new samples
            </Label>
          </div>
        )}
      </form.Field>
      <Button disabled={mutation.isPending || frozen} type="submit">
        Request profile
      </Button>
      <p className="text-muted-foreground text-xs">
        Desired revision {view.profile.revision}; observer applied revision{" "}
        {view.profile.appliedRevision}. Nodes acknowledge separately below.
      </p>
      <div className="space-y-2 text-xs">
        {view.inventory.entities
          .filter((node) => node.kind === "Node")
          .map((node) => {
            const ack = view.heartbeat.nodes?.find(
              (item) => item.nodeUid === node.uid
            );
            return (
              <p className="break-words" key={node.uid}>
                {node.name}: {nodeProfileOutcome(view, node.uid)}
                {ack &&
                  ` · ${ack.profile}${ack.paused ? " (paused)" : ""} revision ${ack.appliedRevision} · dropped ${ack.dropped} · last seen ${ack.seenAt}`}
              </p>
            );
          })}
      </div>
      {mutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          {mutation.error.message}
        </p>
      )}
    </form>
  );
}
