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
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Plus } from "lucide-react";
import { useId, useState } from "react";
import { registerClusterFn } from "../functions/clusters";
import { fetchWorkspaces } from "../hooks/api/clusters";
import {
  type Enrollment,
  environmentSuggestions,
  idProblem,
  idRule,
  slugify,
} from "../lib/install-enrollment";
import { requestError } from "../lib/install-errors";
import { FieldNote, Notice } from "./connect-parts";
import { NewWorkspace } from "./new-workspace";

type Cluster = ClusterView["cluster"];
interface Workspace {
  id: string;
  name: string;
}

function WorkspaceField({
  workspaces,
  loading,
  value,
  onChange,
}: {
  workspaces: Workspace[];
  loading: boolean;
  value: string;
  onChange: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  if (loading) {
    return <Skeleton className="h-16" />;
  }
  const empty = workspaces.length === 0;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Label htmlFor="connect-workspace">Workspace</Label>
        {!(empty || creating) && (
          <Button
            className="h-8"
            onClick={() => setCreating(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus />
            New workspace
          </Button>
        )}
      </div>
      {!empty && (
        <Select
          items={Object.fromEntries(
            workspaces.map((item) => [item.id, item.name])
          )}
          onValueChange={(next) => onChange(next ?? "")}
          value={value}
        >
          <SelectTrigger className="w-full" id="connect-workspace">
            <SelectValue placeholder="Choose a workspace" />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
                <span className="font-mono text-muted-foreground text-xs">
                  {item.id}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {empty && (
        <p className="text-muted-foreground text-xs" id="connect-workspace">
          No workspaces yet. Create one to group this cluster.
        </p>
      )}
      {(empty || creating) && (
        <NewWorkspace
          onCancel={empty ? undefined : () => setCreating(false)}
          onCreated={(workspace) => {
            onChange(workspace.id);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function nameProblem(value: string) {
  return value.trim() ? undefined : "Enter a cluster name.";
}

function duplicateOf(id: string, clusters: Cluster[]) {
  return clusters.find((cluster) => cluster.id === id);
}

function ErrorNotice({
  error,
  onRecover,
}: {
  error: unknown;
  onRecover: () => void;
}) {
  const mapped = requestError(error);
  return (
    <Notice
      icon={<CircleAlert className="size-4" />}
      role="alert"
      tone="destructive"
    >
      <p>{mapped.message}</p>
      {mapped.kind === "duplicate-cluster" && (
        <Button
          className="h-8"
          onClick={onRecover}
          size="sm"
          type="button"
          variant="outline"
        >
          Renew an existing enrollment
        </Button>
      )}
    </Notice>
  );
}

function ClusterIdField({
  value,
  edited,
  shownError,
  duplicate,
  onChange,
  onRecover,
}: {
  value: string;
  edited: boolean;
  shownError?: string;
  duplicate?: Cluster;
  onChange: (value: string) => void;
  onRecover: (id: string) => void;
}) {
  const uid = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${uid}-id`}>Cluster ID</Label>
      <Input
        aria-describedby={`${uid}-id-note`}
        aria-invalid={!!(shownError || duplicate)}
        autoCapitalize="off"
        autoComplete="off"
        className="font-mono"
        id={`${uid}-id`}
        maxLength={80}
        onChange={(event) => onChange(event.target.value)}
        placeholder="payments-eu"
        spellCheck={false}
        value={value}
      />
      <FieldNote error={shownError} id={`${uid}-id-note`}>
        {duplicate ? (
          <span className="flex flex-wrap items-center gap-x-2 text-warning-text">
            A cluster named {duplicate.name} already uses this ID.
            <Button
              className="h-8 px-0"
              onClick={() => onRecover(duplicate.id)}
              size="sm"
              type="button"
              variant="link"
            >
              Renew its enrollment instead
            </Button>
          </span>
        ) : (
          <>
            {edited ? "" : "Derived from the name; edit if needed. "}
            {idRule} The ID is permanent and unique across workspaces.
          </>
        )}
      </FieldNote>
    </div>
  );
}

function EnvironmentField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const uid = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${uid}-environment`}>Environment</Label>
      <Input
        autoComplete="off"
        id={`${uid}-environment`}
        list={`${uid}-environments`}
        maxLength={64}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
      <datalist id={`${uid}-environments`}>
        {environmentSuggestions.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      <fieldset className="flex flex-wrap items-center gap-1.5">
        <legend className="sr-only">Suggested environments</legend>
        {environmentSuggestions.map((item) => (
          <Button
            aria-pressed={value === item}
            className="h-8 aria-pressed:border-primary aria-pressed:bg-primary/10"
            key={item}
            onClick={() => onChange(item)}
            size="sm"
            type="button"
            variant="outline"
          >
            {item}
          </Button>
        ))}
      </fieldset>
    </div>
  );
}

export function ConnectDetails({
  clusters,
  workspace,
  onEnrolled,
  onRecover,
}: {
  clusters: Cluster[];
  workspace: string;
  onEnrolled: (enrollment: Enrollment) => void;
  onRecover: (clusterId?: string) => void;
}) {
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });
  const list = workspaces.data ?? [];
  const [chosen, setChosen] = useState(workspace === "global" ? "" : workspace);
  const workspaceId = list.some((item) => item.id === chosen)
    ? chosen
    : (list[0]?.id ?? "");
  const uid = useId();
  const client = useQueryClient();
  const [idEdited, setIdEdited] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const mutation = useMutation({
    mutationFn: (data: {
      id: string;
      name: string;
      workspaceId: string;
      environment: string;
    }) => registerClusterFn({ data, headers: { "X-Jood-CSRF": "1" } }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["snapshot"] });
      onEnrolled({ ...result, kind: "new" });
    },
  });
  const form = useForm({
    defaultValues: { name: "", id: "", environment: "production" },
    onSubmit: ({ value }) =>
      mutation.mutate({
        id: value.id,
        name: value.name.trim(),
        environment: value.environment.trim(),
        workspaceId,
      }),
  });
  return (
    <div className="space-y-5">
      <WorkspaceField
        loading={workspaces.isLoading}
        onChange={setChosen}
        value={workspaceId}
        workspaces={list}
      />
      {workspaces.isError && (
        <p className="text-destructive-text text-xs" role="alert">
          Workspaces could not be loaded.{" "}
          <button
            className="underline underline-offset-2"
            onClick={() => workspaces.refetch()}
            type="button"
          >
            Retry
          </button>
        </p>
      )}
      <form
        aria-label="Cluster details"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          form.handleSubmit();
        }}
      >
        <form.Field
          listeners={{
            onChange: ({ value }) => {
              if (!idEdited) {
                form.setFieldValue("id", slugify(value));
              }
            },
          }}
          name="name"
          validators={{ onChange: ({ value }) => nameProblem(value) }}
        >
          {(field) => {
            const shown =
              attempted || field.state.meta.isTouched
                ? field.state.meta.errors[0]
                : undefined;
            return (
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-name`}>Cluster name</Label>
                <Input
                  aria-describedby={`${uid}-name-note`}
                  aria-invalid={!!shown}
                  autoComplete="off"
                  id={`${uid}-name`}
                  maxLength={128}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Payments EU"
                  value={field.state.value}
                />
                <FieldNote error={shown} id={`${uid}-name-note`} />
              </div>
            );
          }}
        </form.Field>
        <form.Field
          name="id"
          validators={{
            onChange: ({ value }) =>
              idProblem(value) ??
              (duplicateOf(value, clusters) ? "This ID is taken." : undefined),
          }}
        >
          {(field) => (
            <ClusterIdField
              duplicate={duplicateOf(field.state.value, clusters)}
              edited={idEdited}
              onChange={(value) => {
                setIdEdited(true);
                field.handleChange(value);
              }}
              onRecover={onRecover}
              shownError={
                (attempted || idEdited) &&
                !duplicateOf(field.state.value, clusters)
                  ? field.state.meta.errors[0]
                  : undefined
              }
              value={field.state.value}
            />
          )}
        </form.Field>
        <form.Field name="environment">
          {(field) => (
            <EnvironmentField
              onChange={field.handleChange}
              value={field.state.value}
            />
          )}
        </form.Field>
        {mutation.isError && (
          <ErrorNotice
            error={mutation.error}
            onRecover={() => onRecover(form.state.values.id)}
          />
        )}
        {attempted && !workspaceId && !workspaces.isLoading && (
          <p className="text-destructive-text text-xs" role="alert">
            Create or choose a workspace first.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button
            className="h-8 px-0"
            onClick={() => onRecover()}
            size="sm"
            type="button"
            variant="link"
          >
            Renew an existing enrollment
          </Button>
          <Button disabled={mutation.isPending || !workspaceId} type="submit">
            {mutation.isPending ? "Creating enrollment…" : "Create enrollment"}
          </Button>
        </div>
      </form>
    </div>
  );
}
