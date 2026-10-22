import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import { ArrowRight } from "lucide-react";
import { type ReactNode, useId } from "react";

// Railway-style dashboard widget: a rounded card with a title row (h2 plus
// optional actions) over a body. Every widget is a labelled region.

export function Widget({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card",
        className
      )}
    >
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2
            className="flex min-w-0 items-center gap-2 font-semibold text-[15px] leading-snug"
            id={heading}
          >
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-muted-foreground text-xs">
              {description}
            </p>
          )}
        </div>
        {action && (
          <div className="flex flex-wrap items-center gap-1.5">{action}</div>
        )}
      </div>
      <div className={cn("min-w-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

// "View all" style link to the page that owns the widget's full content.
export function WidgetLink({
  children,
  onClick,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  // Accessible name when the visible text needs the widget for context.
  label?: string;
}) {
  return (
    <Button
      aria-label={label}
      className="h-8 text-xs"
      onClick={onClick}
      size="sm"
      variant="ghost"
    >
      {children}
      <ArrowRight aria-hidden className="size-3.5" />
    </Button>
  );
}
