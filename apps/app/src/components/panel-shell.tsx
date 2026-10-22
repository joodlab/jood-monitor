import { Sheet, SheetContent } from "@jood-monitor/ui/sheet";
import { cn } from "@jood-monitor/ui/utils";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

// Railway's service panel: docked to the right of the page from the md
// breakpoint, under the project bar, with the canvas or table on the left
// crisp and usable. Clicking another resource there switches the panel;
// Escape or the close button closes it, and focus returns to where it was.
// On phones the panel is a full-screen modal sheet.

const DOCKED = "(min-width: 768px)";
// Space between the project bar and the panel's rounded top edge.
const DOCK_GAP = 8;

function subscribe(onChange: () => void) {
  const query = window.matchMedia(DOCKED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useDocked() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DOCKED).matches,
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

// The sheet's backdrop is its previous sibling. While docked it neither dims
// nor blurs the page and lets clicks through, as in Railway.
const clearBackdrop =
  "[[data-slot=sheet-overlay]:has(~&)]:pointer-events-none [[data-slot=sheet-overlay]:has(~&)]:bg-transparent [[data-slot=sheet-overlay]:has(~&)]:backdrop-blur-none";

export function PanelShell({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const docked = useDocked();
  const top = useBarBottom(open && docked);
  // Opening focuses the panel itself, so assistive technology announces its
  // title and description before the first control.
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Sheet
      // Docked, the page beside the panel stays interactive: no focus trap,
      // no scroll lock, and an outside click selects rather than closes.
      disablePointerDismissal={docked}
      modal={!docked}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
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
        initialFocus={popup}
        ref={popup}
        showCloseButton={false}
        style={docked ? { top: top + DOCK_GAP } : undefined}
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}
