import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@jood-monitor/ui/tooltip";
import { cn } from "@jood-monitor/ui/utils";
import {
  Cog,
  ListTree,
  type LucideIcon,
  Maximize,
  Minus,
  Plus,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import type { TopologyLayout } from "../lib/service-graph";

// Railway's floating canvas toolbar: layout, zoom and the two filters that
// change what the canvas draws. Toggles expose aria-pressed and the filters
// also appear as chips, so state never rests on colour alone.

type Orientation = "vertical" | "horizontal";

function ToolButton({
  icon: Icon,
  label,
  hint,
  pressed,
  locked = false,
  layout,
  onClick,
  side,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  pressed?: boolean;
  // Shown as pressed but fixed by another choice; stays focusable so its
  // description can say why.
  locked?: boolean;
  // Marks a layout button, so focus can follow a layout switch.
  layout?: TopologyLayout;
  onClick: () => void;
  side: "right" | "bottom";
}) {
  const hintId = useId();
  // The tooltip is not exposed to assistive technology or touch, so the hint
  // also describes the button.
  const described = hint !== undefined && hint !== label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-describedby={described ? hintId : undefined}
            aria-disabled={locked || undefined}
            aria-label={label}
            aria-pressed={pressed}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              "aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:ring-1 aria-pressed:ring-primary/50",
              locked && "cursor-not-allowed opacity-70"
            )}
            data-layout={layout}
            onClick={locked ? undefined : onClick}
            type="button"
          />
        }
      >
        <Icon aria-hidden="true" className="size-4" />
        {described && (
          <span className="sr-only" id={hintId}>
            {hint}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side={side}>{hint ?? label}</TooltipContent>
    </Tooltip>
  );
}

function Group({
  label,
  orientation,
  children,
}: {
  label: string;
  orientation: Orientation;
  children: ReactNode;
}) {
  return (
    <fieldset
      className={cn(
        "m-0 flex min-w-0 gap-0.5 border-0 p-0",
        orientation === "vertical" ? "flex-col" : "flex-row"
      )}
    >
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  );
}

function Divider({ orientation }: { orientation: Orientation }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "shrink-0 bg-border",
        orientation === "vertical" ? "mx-1 h-px" : "my-1 w-px"
      )}
    />
  );
}

export interface CanvasToolbarProps {
  mode: TopologyLayout;
  onFit?: () => void;
  onMode: (mode: TopologyLayout) => void;
  onProblems?: (problems: boolean) => void;
  onSystem?: (system: boolean) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  orientation: Orientation;
  problems: boolean;
  system: boolean;
  // A system namespace is selected, so system resources are always shown.
  systemLocked: boolean;
}

function ZoomGroup(props: CanvasToolbarProps & { side: "right" | "bottom" }) {
  const { onZoomIn, onZoomOut, onFit, orientation, side } = props;
  if (!(onZoomIn && onZoomOut && onFit)) {
    return null;
  }
  return (
    <>
      <Divider orientation={orientation} />
      <Group label="Zoom" orientation={orientation}>
        <ToolButton
          icon={Plus}
          label="Zoom in"
          onClick={onZoomIn}
          side={side}
        />
        <ToolButton
          icon={Minus}
          label="Zoom out"
          onClick={onZoomOut}
          side={side}
        />
        <ToolButton
          hint="Fit the whole canvas"
          icon={Maximize}
          label="Fit to screen"
          onClick={onFit}
          side={side}
        />
      </Group>
    </>
  );
}

function FilterGroup(props: CanvasToolbarProps & { side: "right" | "bottom" }) {
  const { onProblems, onSystem, orientation, side } = props;
  if (!(onProblems || onSystem)) {
    return null;
  }
  return (
    <>
      <Divider orientation={orientation} />
      <Group label="Filters" orientation={orientation}>
        {onProblems && (
          <ToolButton
            hint={
              props.problems
                ? "Problems only: on. Showing problems and the configured path to them"
                : "Problems only: show problems and the configured path to them"
            }
            icon={TriangleAlert}
            label="Problems only"
            onClick={() => onProblems(!props.problems)}
            pressed={props.problems}
            side={side}
          />
        )}
        {onSystem && (
          <ToolButton
            hint={
              props.systemLocked
                ? "System resources are shown because a system namespace is selected"
                : `System resources: ${props.system ? "shown" : "hidden"}`
            }
            icon={Cog}
            label="System resources"
            locked={props.systemLocked}
            onClick={() => onSystem(!props.system)}
            pressed={props.system || props.systemLocked}
            side={side}
          />
        )}
      </Group>
    </>
  );
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  const { mode, onMode, orientation } = props;
  const side = orientation === "vertical" ? "right" : "bottom";
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-fit gap-1 rounded-xl border bg-card/95 p-1 shadow-md backdrop-blur",
        orientation === "vertical" ? "flex-col" : "flex-row"
      )}
    >
      <Group label="Canvas layout" orientation={orientation}>
        <ToolButton
          hint="Graph: cards and configured relationships"
          icon={Workflow}
          label="Graph layout"
          layout="graph"
          onClick={() => onMode("graph")}
          pressed={mode === "graph"}
          side={side}
        />
        <ToolButton
          hint="List: an indented tree of the same resources"
          icon={ListTree}
          label="List layout"
          layout="list"
          onClick={() => onMode("list")}
          pressed={mode === "list"}
          side={side}
        />
      </Group>
      <ZoomGroup {...props} side={side} />
      <FilterGroup {...props} side={side} />
    </div>
  );
}
