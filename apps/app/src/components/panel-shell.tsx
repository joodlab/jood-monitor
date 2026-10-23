import { Sheet, SheetContent } from "@jood-monitor/ui/sheet";
import { cn } from "@jood-monitor/ui/utils";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { closingFocus, escapeConsumed, switchFocus } from "./panel-focus";

// Railway's service panel: docked to the right of the page from the md
// breakpoint, under the project bar, with the canvas or table on the left
// crisp and usable. Opening another resource there (a card or row, by click
// or Enter) switches the panel and announces it while focus stays on that
// card. A switch from inside the panel (a pod, Back, browser history) moves
// focus to the panel's title and announces it, so focus is never lost.
// Escape or the close button closes it and returns focus to the card or row
// that last opened or switched it, unless the operator has moved focus
// elsewhere. An Escape another control already handled, such as a search
// clearing its text, leaves it open. On phones the panel is a full-screen
// modal sheet.

export const dockedQuery = "(min-width: 768px)";
// Space between the project bar and the panel's rounded top edge.
const DOCK_GAP = 8;

// The docked panel's width in pixels for a viewport width: 60vw, at least
// 560 px and at most 1000 px (min-width wins over max-width), as its classes
// below set it. The canvas keeps its cards clear of this much.
export function dockedInspectorWidth(viewportWidth: number) {
  return Math.max(560, Math.min(0.6 * viewportWidth, 1000));
}

function subscribe(onChange: () => void) {
  const query = window.matchMedia(dockedQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useDocked() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(dockedQuery).matches,
    () => false
  );
}

// The bottom edge of the sticky project bar (the page's first header), which
// grows when it wraps or shows the saved-observation banner.
function useBarBottom(enabled: boolean) {
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const bar =
      document.querySelector<HTMLElement>("[data-project-bar]") ??
      document.querySelector<HTMLElement>("body header");
    if (!bar) {
      return;
    }
    const update = () =>
      setBottom(Math.max(0, Math.round(bar.getBoundingClientRect().bottom)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return bottom;
}

interface ElementRef {
  current: HTMLElement | null;
}

// The element outside the panel that opened it, updated each time another
// resource switches it, with an announcement for every switch. A switch
// with focus in the panel or on the body leaves focus pending for the title,
// taken as soon as the title is there. It runs as a layout effect, before
// Base UI moves focus into the panel on first open.
function useInvoker(
  open: boolean,
  popup: ElementRef,
  title: ElementRef | undefined,
  resource?: { key: string; label: string }
) {
  const invoker = useRef<HTMLElement | null>(null);
  const shown = useRef<string | undefined>(undefined);
  const pending = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const key = resource?.key;
  const label = resource?.label;
  const takeFocus = () => {
    const heading = title?.current;
    if (pending.current && heading?.isConnected) {
      pending.current = false;
      heading.focus({ preventScroll: true });
    }
  };
  useLayoutEffect(() => {
    if (!(open && key)) {
      shown.current = undefined;
      pending.current = false;
      setAnnouncement("");
      return;
    }
    const previous = shown.current;
    shown.current = key;
    if (previous === key) {
      pending.current = false;
      return;
    }
    const active = document.activeElement;
    const target = switchFocus(
      previous !== undefined,
      active,
      document.body,
      popup.current
    );
    if (target === "invoker" && active instanceof HTMLElement) {
      invoker.current = active;
    } else if (previous === undefined) {
      invoker.current = null;
    }
    pending.current = target === "title";
    if (previous !== undefined) {
      setAnnouncement(`Showing ${label}`);
    }
  }, [open, key, label, popup]);
  // After every commit, so a title that mounts late still takes focus.
  useLayoutEffect(takeFocus);
  return { invoker, announcement };
}

// The sheet's backdrop is its previous sibling. While docked it neither dims
// nor blurs the page and lets clicks through, as in Railway.
const clearBackdrop =
  "[[data-slot=sheet-overlay]:has(~&)]:pointer-events-none [[data-slot=sheet-overlay]:has(~&)]:bg-transparent [[data-slot=sheet-overlay]:has(~&)]:backdrop-blur-none";

export function PanelShell({
  open,
  onClose,
  resource,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  // The inspected resource: its key detects a switch to another resource
  // and its label (kind and name) is announced.
  resource?: { key: string; label: string };
  // The panel's title (focusable with tabIndex -1), which takes focus when
  // a switch from inside the panel would otherwise lose it.
  title?: ElementRef;
  children: ReactNode;
}) {
  const docked = useDocked();
  const top = useBarBottom(open && docked);
  // Opening focuses the panel itself, so assistive technology announces its
  // title and description before the first control.
  const popup = useRef<HTMLDivElement>(null);
  const { invoker, announcement } = useInvoker(open, popup, title, resource);
  return (
    <Sheet
      // Docked, the page beside the panel stays interactive: no focus trap,
      // no scroll lock, and an outside click selects rather than closes.
      disablePointerDismissal={docked}
      modal={!docked}
      onOpenChange={(next, details) => {
        if (next) {
          return;
        }
        if (escapeConsumed(details.reason, details.event)) {
          details.cancel();
          return;
        }
        onClose();
      }}
      open={open}
    >
      <SheetContent
        className={cn(
          "gap-0 overflow-y-auto p-0 shadow-2xl outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-none md:overflow-hidden",
          docked &&
            "rounded-tl-xl border-t data-[side=right]:h-auto data-[side=right]:w-[60vw] data-[side=right]:min-w-[560px] data-[side=right]:sm:max-w-[1000px]",
          docked && clearBackdrop
        )}
        // A function, not a ref: Base UI treats any other explicit value as
        // overriding its check that focus has not moved elsewhere.
        finalFocus={() =>
          closingFocus(
            document.activeElement,
            document.body,
            popup.current,
            invoker.current
          )
        }
        initialFocus={popup}
        ref={popup}
        showCloseButton={false}
        style={docked ? { top: top + DOCK_GAP } : undefined}
      >
        <p aria-atomic aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {children}
      </SheetContent>
    </Sheet>
  );
}
