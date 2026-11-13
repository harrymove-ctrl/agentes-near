import { Popover as RPopover } from "radix-ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../cx";
import { focusHeld } from "../device";
import { EDGE_ROOM, pullToFit } from "../floating";
import type { HoverCard } from "../hooks/useHoverCard";

/** Contents that opened without taking the focus: closing gives none back. */
const keptFocus = new WeakSet<EventTarget>();

/**
 * Small popover (Radix Popover: opens from its trigger with Enter/Space or a
 * click, Esc closes, focus returns). Same surface as our menus. Controlled
 * with `open`/`onOpenChange`, or by `hover` for a card that also opens when the
 * pointer rests on its trigger (`useHoverCard`).
 */
export function Popover({
  trigger,
  children,
  label,
  side = "top",
  align = "start",
  className,
  open,
  onOpenChange,
  hover,
  moveFocus = hover?.open !== "hover",
}: {
  /** A focusable element (a button with an accessible name). */
  trigger: ReactNode;
  children: ReactNode;
  /** Accessible name of the popover. */
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  /** By default, `hover` says: open however it opened. */
  open?: boolean;
  /** With `hover`, called after it. */
  onOpenChange?: (open: boolean) => void;
  hover?: HoverCard;
  /**
   * As it opens: focus goes to its first control, and back to the trigger when it closes. False for a card that
   * opens under a resting pointer (the default when `hover` opened it): whatever had focus (the box someone types
   * in) keeps it.
   */
  moveFocus?: boolean;
}) {
  // How far it moves over its trigger to fit the window (`pullToFit`): only ever for a card the room on its side cuts.
  const [pull, setPull] = useState(0);
  const pulled = useRef({ now: 0, base: 0 });
  const watch = useRef<ResizeObserver | null>(null);
  // The hover card's ref rides on this stable one: a ref that changed each render would rerun `fit` and reset the pull.
  const hoverRef = useRef(hover?.content.ref);
  hoverRef.current = hover?.content.ref;
  const fit = useCallback((el: HTMLDivElement | null) => {
    hoverRef.current?.(el);
    watch.current?.disconnect();
    watch.current = null;
    if (!el) {
      pulled.current.now = 0;
      setPull(0);
      return;
    }
    if (typeof ResizeObserver === "undefined") return;
    const check = () => {
      const room = Number.parseFloat(getComputedStyle(el).getPropertyValue("--radix-popover-content-available-height"));
      if (!pulled.current.now) pulled.current.base = room;
      // Measured without its scrollbar: the narrower rows wrap a line more than the card shows once it fits.
      const was = el.style.overflowY;
      el.style.overflowY = "hidden";
      const scroll = el.scrollHeight;
      const client = el.clientHeight;
      el.style.overflowY = was;
      const want = pullToFit({
        scroll,
        client,
        height: el.offsetHeight,
        room,
        base: pulled.current.base,
        window: window.innerHeight,
      });
      if (want > pulled.current.now) {
        pulled.current.now = want;
        setPull(want);
      }
    };
    watch.current = new ResizeObserver(check);
    // Its rows too: words loading into a card already at its cap grow what overflows, not the card.
    for (const box of [el, ...el.querySelectorAll(":scope > *, :scope > * > *")]) watch.current.observe(box);
  }, []);
  useEffect(() => {
    if (!pull) return;
    const again = () => {
      pulled.current.now = 0;
      setPull(0);
    };
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, [pull]);
  return (
    <RPopover.Root
      open={open ?? (hover && hover.open !== false)}
      onOpenChange={(o) => {
        hover?.onOpenChange(o);
        onOpenChange?.(o);
      }}
    >
      <RPopover.Trigger asChild {...hover?.trigger}>
        {trigger}
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          className={cx("ac-menu ac-popover", className)}
          side={side}
          align={align}
          sideOffset={6 - pull}
          collisionPadding={EDGE_ROOM}
          aria-label={label}
          role="dialog"
          {...hover?.content}
          ref={fit}
          onOpenAutoFocus={(e) => {
            if (moveFocus || !e.currentTarget) return;
            e.preventDefault();
            keptFocus.add(e.currentTarget);
          }}
          // Each opening's own content: by the time one closes, `moveFocus` may already say how the next one opens.
          onCloseAutoFocus={(e) => {
            if ((e.currentTarget && keptFocus.has(e.currentTarget)) || focusHeld()) e.preventDefault();
          }}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
