import { Button } from "@jood-monitor/ui/button";
import { Input } from "@jood-monitor/ui/input";
import { Label } from "@jood-monitor/ui/label";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createWorkspaceFn } from "../functions/clusters";
import { workspaceSchema } from "../schemas/clusters";

export function NewWorkspace({ onCreated }: { onCreated: () => void }) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data: { id: string; name: string }) =>
      createWorkspaceFn({ data, headers: { "X-Jood-CSRF": "1" } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workspaces"] });
      onCreated();
    },
  });
  const form = useForm({
    defaultValues: { id: "", name: "" },
    validators: { onSubmit: workspaceSchema },
    onSubmit: ({ value }) => mutation.mutateAsync(value).catch(() => undefined),
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
        Create a workspace to group your clusters and scope their observations.
      </p>
      {(["id", "name"] as const).map((name) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor={`workspace-${name}`}>
                {name === "id" ? "Workspace ID" : "Display name"}
              </Label>
              <Input
                id={`workspace-${name}`}
                maxLength={name === "id" ? 64 : 128}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={name === "id" ? "my-team" : "My team"}
                required
                value={field.state.value}
              />
              {field.state.meta.errors.length > 0 && (
                <p className="text-destructive text-sm" role="alert">
                  {field.state.meta.errors
                    .map((error) => error?.message)
                    .join(". ")}
                </p>
              )}
            </div>
          )}
        </form.Field>
      ))}
      <Button disabled={mutation.isPending} type="submit">
        Create workspace
      </Button>
      {mutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          Workspace creation failed. Check the ID and try again.
        </p>
      )}
    </form>
  );
}
