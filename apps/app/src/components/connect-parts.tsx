import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import { BookOpen, Check, CircleAlert, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

// Small building blocks shared by the connect-cluster steps.

// A one-second clock for countdowns while the dialog is open. The dialog
// only renders after hydration, so reading Date.now() here is safe.
export function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

export function ConnectSteps({
  steps,
  current,
}: {
  steps: string[];
  current: number;
}) {
  return (
    <ol
      aria-label="Connection steps"
      className="flex flex-wrap gap-x-4 gap-y-2"
    >
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 text-xs",
              active ? "font-medium text-foreground" : "text-muted-foreground"
            )}
            key={step}
          >
            <span
              aria-hidden
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums",
                active && "border-primary bg-primary text-primary-foreground",
                done && "border-success-text/40 text-success-text"
              )}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            {step}
            <span className="sr-only">
              {done && "(done)"}
              {active && "(current step)"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status === "idle") {
      return;
    }
    const timer = setTimeout(() => setStatus("idle"), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <>
      <Button
        aria-label={label}
        className={className}
        onClick={() =>
          navigator.clipboard.writeText(value).then(
            () => setStatus("copied"),
            () => setStatus("failed")
          )
        }
        size="sm"
        type="button"
        variant="outline"
      >
        {status === "copied" ? (
          <Check className="text-success-text" />
        ) : (
          <Copy />
        )}
        {status === "copied" ? "Copied" : "Copy"}
      </Button>
      <span aria-live="polite" className="sr-only">
        {status === "copied" && `${label}: copied`}
      </span>
      {status === "failed" && (
        <span className="text-destructive-text text-xs" role="alert">
          Clipboard unavailable. Check browser permissions, or select the text
          and copy it manually.
        </span>
      )}
    </>
  );
}

export function CommandBlock({
  command,
  label,
}: {
  command: string;
  label: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="text-muted-foreground text-xs">Shell</span>
        <CopyButton className="h-8" label={`Copy ${label}`} value={command} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{command}</code>
      </pre>
    </div>
  );
}

// A documentation link that opens beside the dialog, so its token and
// progress stay in place.
export function DocLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      className="inline-flex items-center gap-1.5 rounded-sm text-primary text-xs underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
      rel="noopener"
      target="_blank"
    >
      <BookOpen aria-hidden className="size-3.5 shrink-0" />
      {children}
    </a>
  );
}

// Hint and live error text for a field, referenced by aria-describedby.
export function FieldNote({
  id,
  error,
  children,
}: {
  id: string;
  error?: string;
  children?: ReactNode;
}) {
  return (
    <div aria-live="polite" className="space-y-1 text-xs" id={id}>
      {error && (
        <p className="flex items-start gap-1.5 text-destructive-text">
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
      {children && <div className="text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Notice({
  tone,
  icon,
  title,
  children,
  role,
}: {
  tone: "warning" | "destructive" | "info" | "success";
  icon: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  role?: "alert" | "status";
}) {
  const tones = {
    warning: "border-warning/40 bg-warning/10",
    destructive: "border-destructive/40 bg-destructive/10",
    info: "border-info/40 bg-info/10",
    success: "border-success/40 bg-success/10",
  };
  const iconTones = {
    warning: "text-warning-text",
    destructive: "text-destructive-text",
    info: "text-info-text",
    success: "text-success-text",
  };
  return (
    <div
      className={cn("flex gap-3 rounded-lg border p-3 text-sm", tones[tone])}
      role={role}
    >
      <span aria-hidden className={cn("mt-0.5 shrink-0", iconTones[tone])}>
        {icon}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {title && <p className="font-medium">{title}</p>}
        {children}
      </div>
    </div>
  );
}
