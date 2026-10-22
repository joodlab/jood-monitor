import { cn } from "@jood-monitor/ui/utils";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

// Railway-style settings sections: a circular icon on a vertical rail, then
// the section title, a short description and its controls.

export function SettingsRail({
  icon: Icon,
  title,
  description,
  badge,
  last = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[2.5rem_minmax(0,1fr)] sm:gap-x-6"
    >
      <div aria-hidden className="flex flex-col items-center">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground sm:size-10">
          <Icon className="size-4" />
        </span>
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>
      <div className={cn("min-w-0 space-y-3", last ? "pb-1" : "pb-10")}>
        <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 sm:min-h-10">
          <h3 className="font-semibold text-base" id={headingId}>
            {title}
          </h3>
          {badge}
        </div>
        {description && (
          <div className="-mt-2 max-w-2xl text-muted-foreground text-sm">
            {description}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

// Marks a value that is staged but not applied. The word carries the state;
// the violet tint only reinforces it.
export function StagedPill({
  className,
  children = "Staged",
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full bg-staged/15 px-2 font-medium text-staged-text text-xs",
        className
      )}
    >
      {children}
    </span>
  );
}

// Surface classes for a control whose value is staged.
export const stagedSurface = "border-staged/50 bg-staged/10";
