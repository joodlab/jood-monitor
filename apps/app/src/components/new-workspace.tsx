import { Button } from "@jood-monitor/ui/button";
import { Input } from "@jood-monitor/ui/input";
import { Label } from "@jood-monitor/ui/label";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useId, useState } from "react";
import { createWorkspaceFn } from "../functions/clusters";
import { idProblem, idRule, slugify } from "../lib/install-enrollment";
import { requestError } from "../lib/install-errors";
import { FieldNote, Notice } from "./connect-parts";

const reserved = ["global"];

function nameProblem(value: string) {
  return value.trim() ? undefined : "Enter a display name.";
}

// Inline workspace creation. The ID follows the display name until edited.
export function NewWorkspace({
  onCreated,
  onCancel,
}: {
  onCreated: (workspace: { id: string; name: string }) => void;
  onCancel?: () => void;
}) {
  const client = useQueryClient();
  const uid = useId();
  const [idEdited, setIdEdited] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const mutation = useMutation({
    mutationFn: (data: { id: string; name: string }) =>
      createWorkspaceFn({ data, headers: { "X-Jood-CSRF": "1" } }),
    onSuccess: async (_, data) => {
      await client.invalidateQueries({ queryKey: ["workspaces"] });
      onCreated(data);
    },
  });
  const form = useForm({
    defaultValues: { id: "", name: "" },
    onSubmit: ({ value }) =>
      mutation.mutate({ id: value.id, name: value.name.trim() }),
  });
  const error = mutation.isError ? requestError(mutation.error) : undefined;
  return (
    <form
      aria-labelledby={`${uid}-title`}
      className="space-y-3 rounded-lg border bg-muted/30 p-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        form.handleSubmit();
      }}
    >
      <div>
        <p className="font-medium text-sm" id={`${uid}-title`}>
          New workspace
        </p>
        <p className="text-muted-foreground text-xs">
          Workspaces group clusters and scope what operators see together.
        </p>
      </div>
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
              <Label htmlFor={`${uid}-name`}>Display name</Label>
              <Input
                aria-describedby={`${uid}-name-note`}
                aria-invalid={!!shown}
                autoComplete="off"
                id={`${uid}-name`}
                maxLength={128}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Platform team"
                value={field.state.value}
              />
              <FieldNote error={shown} id={`${uid}-name-note`} />
            </div>
          );
        }}
      </form.Field>
      <form.Field
        name="id"
        validators={{ onChange: ({ value }) => idProblem(value, reserved) }}
      >
        {(field) => {
          const shown =
            attempted || (idEdited && field.state.meta.isTouched)
              ? field.state.meta.errors[0]
              : undefined;
          return (
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-id`}>Workspace ID</Label>
              <Input
                aria-describedby={`${uid}-id-note`}
                aria-invalid={!!shown}
                autoCapitalize="off"
                autoComplete="off"
                className="font-mono"
                id={`${uid}-id`}
                maxLength={80}
                onChange={(event) => {
                  setIdEdited(true);
                  field.handleChange(event.target.value);
                }}
                placeholder="platform-team"
                spellCheck={false}
                value={field.state.value}
              />
              <FieldNote error={shown} id={`${uid}-id-note`}>
                {idEdited ? idRule : `Derived from the name. ${idRule}`}
              </FieldNote>
            </div>
          );
        }}
      </form.Field>
      {error && (
        <Notice
          icon={<CircleAlert className="size-4" />}
          role="alert"
          tone="destructive"
        >
          {error.message}
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={mutation.isPending} size="sm" type="submit">
          {mutation.isPending ? "Creating workspace…" : "Create workspace"}
        </Button>
        {onCancel && (
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
