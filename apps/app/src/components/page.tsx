import { cn } from "@jood-monitor/ui/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// Shared page scaffolding: one h1 per page, h2 sections, and empty states that
// say what is missing and what the operator can do next.

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
        {description && (
          <div className="mt-1 text-muted-foreground text-sm">
            {description}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center",
        className
      )}
    >
      {Icon && <Icon aria-hidden className="size-5 text-muted-foreground" />}
      <p className="font-medium text-sm">{title}</p>
      {description && (
        <p className="max-w-md text-muted-foreground text-sm">{description}</p>
      )}
      {children && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {children}
        </div>
      )}
    </div>
  );
}
