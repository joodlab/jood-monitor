import { Button } from "@jood-monitor/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@jood-monitor/ui/dropdown-menu";
import { cn } from "@jood-monitor/ui/utils";
import { useRouter } from "@tanstack/react-router";
import {
  CalendarClock,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Radio,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useDisplay } from "../hooks/display";
import {
  pinnedInstant,
  type ShareMode,
  shareHints,
  shareSearch,
} from "../lib/share-link";
import {
  formatDateTime,
  type HubClock,
  observationMs,
  timeZoneLabel,
} from "../lib/time";
import type { PanelTab, SearchState } from "../schemas/monitor";

type CopyState = "idle" | "copied" | "failed";

const feedback: Record<CopyState, string> = {
  idle: "",
  copied: "Copied",
  failed: "Copy failed",
};

// Copies text and remembers the outcome for 1.6 s, so the control can
// confirm visibly and to assistive technology. `value` may be a function so
// the current URL is read at click time.
function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = useCallback(async (value: string | (() => string)) => {
    try {
      await navigator.clipboard.writeText(
        typeof value === "function" ? value() : value
      );
      setState("copied");
    } catch {
      setState("failed");
    }
  }, []);
  return { state, copy };
}

// Copies an identifier and confirms visibly and to assistive technology.
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
  const { state, copy } = useCopy();
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
      onClick={() => copy(value)}
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

const linkFeedback: Record<CopyState, string> = {
  idle: "",
  copied: "Link copied",
  failed: "Copy failed",
};

function LinkItem({
  icon,
  label,
  hint,
  onCopy,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  onCopy: () => void;
}) {
  return (
    <DropdownMenuItem className="items-start" onClick={onCopy}>
      <span className="mt-0.5">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{label}</span>
        {hint && (
          <span className="text-muted-foreground text-xs leading-snug">
            {hint}
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}

// The panel's link menu. Live, it offers a link frozen at the observation on
// screen or a live link; frozen, a link to this saved observation or a live
// link that remembers its time. The moment is pinned when the menu opens, so
// its label and URL agree even if an inventory arrives meanwhile.
export function CopyLinkMenu({
  search,
  panel,
  sourceTime,
  hubClock,
  className,
}: {
  search: SearchState;
  // The tab on screen, which a moment link opens.
  panel: PanelTab;
  // The inspected cluster's inventory source time.
  sourceTime?: string;
  hubClock?: HubClock;
  className?: string;
}) {
  const router = useRouter();
  const { timeZone } = useDisplay();
  const { state, copy } = useCopy();
  const [pinned, setPinned] = useState<string>();
  const frozen = !!search.at;
  const moment =
    pinned ?? pinnedInstant({ at: search.at, sourceTime, hubClock, now: 0 });
  const momentMs = observationMs(moment);
  const zone = timeZoneLabel(timeZone, momentMs);
  const href = (next: SearchState) =>
    router.buildLocation({ to: "/", search: next }).href;
  const copyLink = (mode: ShareMode) =>
    copy(
      () =>
        new URL(
          href(shareSearch(search, { mode, at: moment, panel })),
          window.location.origin
        ).href
    );
  // biome-ignore lint/a11y/useAnchorContent: the menu item children render inside the link.
  const newTab = <a href={href(search)} rel="noopener" target="_blank" />;
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            setPinned(
              pinnedInstant({
                at: search.at,
                sourceTime,
                hubClock,
                now: Date.now(),
              })
            );
          }
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="Link to this resource"
              className={cn(
                className,
                state === "failed" && "text-warning-text"
              )}
              size="icon"
              title="Link to this resource"
              variant="ghost"
            />
          }
        >
          {state === "copied" ? (
            <Check aria-hidden className="size-3.5 text-success-text" />
          ) : (
            <Link2 aria-hidden className="size-3.5" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <LinkItem
            hint={shareHints.moment}
            icon={<CalendarClock />}
            label={
              frozen
                ? `Copy link to this saved observation · ${zone}`
                : `Copy link at ${formatDateTime(momentMs, timeZone)} ${zone}`
            }
            onCopy={() => copyLink("moment")}
          />
          <LinkItem
            hint={frozen ? shareHints.frozenLive : shareHints.live}
            icon={<Radio />}
            label="Copy live link"
            onCopy={() => copyLink("live")}
          />
          <DropdownMenuSeparator />
          {/* The current view as it is, live or frozen. */}
          <DropdownMenuItem render={newTab}>
            <ExternalLink />
            Open in new tab
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Outside the menu, so the outcome is announced after it closes. */}
      <span aria-live="polite" className="sr-only">
        {linkFeedback[state]}
      </span>
    </>
  );
}
