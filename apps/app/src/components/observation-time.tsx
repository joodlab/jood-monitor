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
import { CalendarClock } from "lucide-react";
import { useState } from "react";
import { useDisplay } from "../hooks/display";
import { fromZonedInput, timeZoneLabel, toZonedInput } from "../lib/time";

const presets = [
  { label: "15 min ago", minutes: 15 },
  { label: "1 hour ago", minutes: 60 },
  { label: "6 hours ago", minutes: 360 },
  { label: "1 day ago", minutes: 1440 },
];

export function ObservationTime({
  at,
  onSelect,
  open: controlledOpen,
  onOpenChange,
  triggerClassName,
}: {
  at?: string;
  onSelect: (at: string) => void;
  // Optional control so another surface (a menu) can open the dialog.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const { timeZone } = useDisplay();
  return (
    <>
      <Button
        aria-label="Go to a saved observation time"
        className={triggerClassName}
        onClick={() => setOpen(true)}
        size="icon-sm"
        title="Go to a saved observation time"
        variant="outline"
      >
        <CalendarClock />
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>View a saved observation</DialogTitle>
            <DialogDescription>
              Inventory and metrics are shown as they were saved at the chosen
              time. Missing coverage stays visible; collection status is not
              retained historically.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <ObservationForm
              at={at}
              onSelect={(selected) => {
                onSelect(selected);
                setOpen(false);
              }}
              timeZone={timeZone}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ObservationForm({
  at,
  timeZone,
  onSelect,
}: {
  at?: string;
  timeZone: string;
  onSelect: (at: string) => void;
}) {
  const zone = timeZoneLabel(timeZone);
  const form = useForm({
    defaultValues: {
      time: toZonedInput(at ? Date.parse(at) : Date.now(), timeZone),
    },
    onSubmit: ({ value }) => {
      const time = fromZonedInput(value.time, timeZone);
      if (time != null) {
        onSelect(new Date(time).toISOString());
      }
    },
  });
  const validTime = (value: string) => {
    const time = fromZonedInput(value, timeZone);
    return time != null && time <= Date.now() && time > 0;
  };
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="font-medium text-sm">Quick jump</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {presets.map((preset) => (
            <Button
              key={preset.minutes}
              onClick={() =>
                onSelect(
                  new Date(Date.now() - preset.minutes * 60_000).toISOString()
                )
              }
              size="sm"
              variant="outline"
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>
      <form
        className="space-y-3"
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
          }}
        >
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="observation-time">Exact time · {zone}</Label>
              <Input
                aria-describedby="observation-time-error"
                aria-invalid={field.state.meta.errors.length > 0}
                id="observation-time"
                onChange={(event) => field.handleChange(event.target.value)}
                required
                type="datetime-local"
                value={field.state.value}
              />
              <p
                className="min-h-4 text-destructive-text text-xs"
                id="observation-time-error"
                role="alert"
              >
                {field.state.meta.errors.join(" ")}
              </p>
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button disabled={!canSubmit} type="submit">
              View saved observation
            </Button>
          )}
        </form.Subscribe>
      </form>
    </div>
  );
}
