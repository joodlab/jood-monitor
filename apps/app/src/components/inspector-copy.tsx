import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import { Check, Copy, Link2 } from "lucide-react";
import { useEffect, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

const feedback: Record<CopyState, string> = {
  idle: "",
  copied: "Copied",
  failed: "Copy failed",
};

// Copies an identifier and confirms visibly and to assistive technology.
// `value` may be a function so the current URL is read at click time.
export function CopyButton({
  value,
  label,
  text,
  link = false,
  className,
}: {
  value: string | (() => string);
  // Accessible name, e.g. "Copy UID".
  label: string;
  // Visible text; icon-only when omitted.
  text?: string;
  link?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        typeof value === "function" ? value() : value
      );
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  const Icon = link ? Link2 : Copy;
  const shown = state === "idle" ? text : feedback[state];
  return (
    <Button
      aria-label={label}
      className={cn(
        "text-muted-foreground hover:text-foreground",
        shown ? "h-8 px-2 text-xs" : "size-8",
        state === "failed" && "text-warning-text",
        className
      )}
      onClick={copy}
      size={shown ? "sm" : "icon-sm"}
      title={label}
      type="button"
      variant="ghost"
    >
      {state === "copied" ? (
        <Check aria-hidden className="size-3.5 text-success-text" />
      ) : (
        <Icon aria-hidden className="size-3.5" />
      )}
      {shown && <span>{shown}</span>}
      <span aria-live="polite" className="sr-only">
        {feedback[state]}
      </span>
    </Button>
  );
}
