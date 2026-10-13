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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getWorkspacesFn,
  recoverEnrollmentFn,
  registerClusterFn,
} from "../functions/clusters";
import { NewWorkspace } from "./new-workspace";

export function EnrollForm({
  clusters,
  workspace,
}: {
  clusters: ClusterView["cluster"][];
  workspace: string;
}) {
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => getWorkspacesFn(),
  });
  const [tab, setTab] = useState(workspaces.data?.length ? "new" : "workspace");
  return (
    <Tabs onValueChange={setTab} value={tab}>
      <TabsList className="w-full">
        <TabsTrigger value="new">New cluster</TabsTrigger>
        <TabsTrigger value="recover">Recover enrollment</TabsTrigger>
        <TabsTrigger value="workspace">Workspace</TabsTrigger>
      </TabsList>
      <TabsContent value="new">
        <NewEnrollment
          workspace={workspace}
          workspaces={workspaces.data ?? []}
        />
      </TabsContent>
      <TabsContent value="workspace">
        <NewWorkspace onCreated={() => setTab("new")} />
      </TabsContent>
      <TabsContent value="recover">
        <RecoverEnrollment clusters={clusters} />
      </TabsContent>
    </Tabs>
  );
}

function NewEnrollment({
  workspace,
  workspaces,
}: {
  workspace: string;
  workspaces: { id: string; name: string }[];
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (data: {
      id: string;
      name: string;
      workspaceId: string;
      environment: string;
    }) => registerClusterFn({ data, headers: { "X-Jood-CSRF": "1" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snapshot"] }),
  });
  const form = useForm({
    defaultValues: {
      id: "",
      name: "",
      workspaceId:
        workspace === "global" ? (workspaces[0]?.id ?? "") : workspace,
      environment: "production",
    },
    onSubmit: ({ value }) => mutation.mutate(value),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
    >
      {(["id", "name", "environment"] as const).map((name) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor={name}>
                {
                  {
                    id: "Cluster ID",
                    name: "Cluster name",
                    environment: "Environment",
                  }[name]
                }
              </Label>
              <Input
                id={name}
                maxLength={name === "name" ? 128 : 64}
                onChange={(e) => field.handleChange(e.target.value)}
                required
                value={field.state.value}
              />
            </div>
          )}
        </form.Field>
      ))}
      <form.Field name="workspaceId">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="enroll-workspace">Workspace</Label>
            <Select
              items={Object.fromEntries(
                workspaces.map((item) => [item.id, item.name])
              )}
              onValueChange={(v) => field.handleChange(v ?? "")}
              value={field.state.value}
            >
              <SelectTrigger id="enroll-workspace">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </form.Field>
      <Button disabled={mutation.isPending || !workspaces.length} type="submit">
        Create enrollment
      </Button>
      {mutation.isError && <p role="alert">{mutation.error.message}</p>}
      {mutation.data && (
        <EnrollmentResult data={mutation.data} key={mutation.data.expiresAt} />
      )}
    </form>
  );
}

function RecoverEnrollment({
  clusters,
}: {
  clusters: ClusterView["cluster"][];
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (id: string) =>
      recoverEnrollmentFn({ data: id, headers: { "X-Jood-CSRF": "1" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snapshot"] }),
  });
  const form = useForm({
    defaultValues: { id: "" },
    onSubmit: ({ value }) => mutation.mutate(value.id),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <p className="text-muted-foreground text-sm">
        Renew a revoked or unfinished enrollment using the same cluster ID.
        History and workspace stay intact. Active credentials must be revoked
        first. Previous enrollment tokens become invalid.
      </p>
      <a
        className="text-primary text-sm underline"
        href="/docs/agents#credential-recovery"
      >
        Credential recovery instructions
      </a>
      <form.Field name="id">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="recover-cluster">Existing cluster</Label>
            <Select
              items={Object.fromEntries(
                clusters.map((cluster) => [
                  cluster.id,
                  `${cluster.name} · ${cluster.id}`,
                ])
              )}
              onValueChange={(value) => {
                field.handleChange(value ?? "");
                mutation.reset();
              }}
              value={field.state.value}
            >
              <SelectTrigger className="w-full" id="recover-cluster">
                <SelectValue placeholder="Choose a cluster" />
              </SelectTrigger>
              <SelectContent>
                {clusters.map((cluster) => (
                  <SelectItem key={cluster.id} value={cluster.id}>
                    {cluster.name} · {cluster.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!clusters.length && (
              <p className="text-muted-foreground text-xs">
                No existing clusters in this workspace. Create a new enrollment
                or select another workspace.
              </p>
            )}
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.id}>
        {(id) => (
          <Button disabled={!id || mutation.isPending} type="submit">
            Renew enrollment
          </Button>
        )}
      </form.Subscribe>
      {mutation.isError && <p role="alert">{mutation.error.message}</p>}
      {mutation.data && (
        <EnrollmentResult data={mutation.data} key={mutation.data.expiresAt} />
      )}
    </form>
  );
}

function EnrollmentResult({
  data,
}: {
  data: { enrollmentToken: string; expiresAt: string };
}) {
  const [copyStatus, setCopyStatus] = useState("");
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm">
        One-time enrollment, expires{" "}
        {new Date(data.expiresAt).toLocaleTimeString()}. Store privately; never
        put credentials in screenshots.
      </p>
      <Input
        aria-label="One-time enrollment token"
        readOnly
        type="password"
        value={data.enrollmentToken}
      />
      <Button
        onClick={() =>
          navigator.clipboard.writeText(data.enrollmentToken).then(
            () => setCopyStatus("Token copied."),
            () =>
              setCopyStatus(
                "Clipboard unavailable. Check browser permissions and retry."
              )
          )
        }
        type="button"
        variant="outline"
      >
        Copy token
      </Button>
      <p aria-live="polite" className="text-muted-foreground text-xs">
        {copyStatus}
      </p>
    </div>
  );
}
