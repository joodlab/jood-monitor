import { Button } from "@jood-monitor/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import { Input } from "@jood-monitor/ui/input";
import { Label } from "@jood-monitor/ui/label";
import { useForm } from "@tanstack/react-form";
import { Clock3 } from "lucide-react";
import { useState } from "react";

export function ObservationTime({
  at,
  onSelect,
}: {
  at?: string;
  onSelect: (at: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        aria-label="Choose observation time"
        onClick={() => setOpen(true)}
        size="icon-sm"
        variant="outline"
      >
        <Clock3 />
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Inspect a saved observation</DialogTitle>
            <DialogDescription>
              Select the end of the history window in Riyadh time (UTC+3).
              Missing coverage remains visible.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <ObservationForm
              at={at}
              onSelect={(selected) => {
                onSelect(selected);
                setOpen(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ObservationForm({
  at,
  onSelect,
}: {
  at?: string;
  onSelect: (at: string) => void;
}) {
  const form = useForm({
    defaultValues: {
      time: new Date(at ?? Date.now())
        .toLocaleString("sv-SE", { timeZone: "Asia/Riyadh" })
        .replace(" ", "T")
        .slice(0, 16),
    },
    onSubmit: ({ value }) =>
      onSelect(new Date(`${value.time}:00+03:00`).toISOString()),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <form.Field
        name="time"
        validators={{
          onChange: ({ value }) =>
            validTime(value) ? undefined : "Choose a valid time in the past.",
          onSubmit: ({ value }) =>
            validTime(value) ? undefined : "Choose a valid time in the past.",
        }}
      >
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="observation-time">Observation time · Riyadh</Label>
            <Input
              aria-invalid={field.state.meta.errors.length > 0}
              id="observation-time"
              onChange={(event) => field.handleChange(event.target.value)}
              required
              type="datetime-local"
              value={field.state.value}
            />
            {field.state.meta.errors.map((error) => (
              <p
                className="text-destructive text-xs"
                key={String(error)}
                role="alert"
              >
                {error}
              </p>
            ))}
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.canSubmit}>
        {(canSubmit) => (
          <Button disabled={!canSubmit} type="submit">
            Inspect saved observation
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
function validTime(value: string) {
  const time = Date.parse(`${value}:00+03:00`);
  return Number.isFinite(time) && time <= Date.now() && time > 0;
}
