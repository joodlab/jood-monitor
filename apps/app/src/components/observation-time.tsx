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
import {
  DAY_MS,
  INVENTORY_RETENTION_DAYS,
  RAW_RETENTION_DAYS,
} from "../lib/retention";
import {
  fromZonedInput,
  observationMs,
  timeZoneLabel,
  toZonedInput,
} from "../lib/time";

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
  // The dialog opens fresh each time, so its bounds start from that moment.
  // The picker works in whole minutes; the earliest is rounded up so the
  // earliest minute it offers also passes validation.
  const [opened] = useState(Date.now);
  const earliest =
    Math.ceil((opened - INVENTORY_RETENTION_DAYS * DAY_MS) / 60_000) * 60_000;
  const saved = observationMs(at);
  const form = useForm({
    defaultValues: {
      // A link time that is unreadable or outside retention starts the
      // picker at now instead.
      time: toZonedInput(
        saved != null && saved >= earliest && saved <= opened ? saved : opened,
        timeZone
      ),
    },
    onSubmit: ({ value }) => {
      const time = fromZonedInput(value.time, timeZone);
      if (time != null) {
        onSelect(new Date(time).toISOString());
      }
    },
  });
  const timeProblem = (value: string) => {
    const time = fromZonedInput(value, timeZone);
    if (time == null) {
      return "Enter a date and time.";
    }
    if (time > Date.now()) {
      return "Choose a time in the past.";
    }
    if (time < earliest) {
      return `Saved observations are kept for ${INVENTORY_RETENTION_DAYS} days; choose a later time.`;
    }
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
          validators={{ onChange: ({ value }) => timeProblem(value) }}
        >
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="observation-time">Exact time · {zone}</Label>
              <Input
                aria-describedby="observation-time-hint observation-time-error"
                aria-invalid={field.state.meta.errors.length > 0}
                id="observation-time"
                max={toZonedInput(opened, timeZone)}
                min={toZonedInput(earliest, timeZone)}
                onChange={(event) => field.handleChange(event.target.value)}
                required
                type="datetime-local"
                value={field.state.value}
              />
              <p
                className="text-muted-foreground text-xs"
                id="observation-time-hint"
              >
                Inventory and events: {INVENTORY_RETENTION_DAYS} days. Raw
                CPU/memory samples: {RAW_RETENTION_DAYS} days.
              </p>
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
