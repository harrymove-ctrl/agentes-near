import { Popover as RPopover } from "radix-ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { movesByKeys, trackInput } from "../device";
import { EDGE_ROOM } from "../floating";
import { useHoverCard } from "../hooks/useHoverCard";
import { Icon } from "../icons/Icon";

/** The app's own tooltip delay (`.ac-msg__tip`): a pointer resting this long on the ⓘ opens the hint. */
const OPEN_MS = 250;

export interface InfoHintProps {
  /** The ⓘ's accessible name, translated: `t("common.about", { label })` → "About Time zone". */
  name: string;
  /** The hint: plain sentences only (no links, buttons or lists). */
  children: ReactNode;
  /** The id of the always-present description, for a control's `aria-describedby` (default: generated). */
  id?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}

/**
 * An ⓘ beside a label with the setting's explanation in a bubble. A mouse or pen resting on it opens it, keyboard
 * focus opens it at once, and a click, a tap, Enter or Space pins it open (a second one closes it); Escape or a
 * press elsewhere closes it. Its text is always in the page, hidden, so the ⓘ (and the control, through `id`) is
 * described by it while the bubble is closed. Put the label and the ⓘ in one `.ac-hintline`.
 */
export function InfoHint({ name, children, id, side = "top", align = "center" }: InfoHintProps) {
  const generated = useId();
  const hintId = id ?? `hint${generated.replace(/[^\w-]/g, "")}`;
  // Open for a resting pointer (`hover`), a press that pinned it (`press`), or keyboard focus.
  const hint = useHoverCard(OPEN_MS);
  const [focused, setFocused] = useState(false);
  const open = focused || hint.open !== false;
  const anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => trackInput(), []);
  // A press on the ⓘ is decided by its own click, not taken for a press outside the bubble.
  const onAnchor = (e: Event) => {
    if (e.target instanceof Node && anchor.current?.contains(e.target)) e.preventDefault();
  };
  return (
    <RPopover.Root
      open={open}
      onOpenChange={(o) => {
        if (o) return;
        hint.close();
        setFocused(false);
      }}
    >
      <RPopover.Anchor asChild>
        <button
          ref={anchor}
          type="button"
          className="ac-hint"
          aria-label={name}
          aria-describedby={hintId}
          data-state={open ? "open" : "closed"}
          {...hint.trigger}
          // Focus the keys bring opens it; a press's focus opens nothing, since the press's own click decides, so
          // one click never opens and closes it at once.
          onFocus={() => {
            if (movesByKeys()) setFocused(true);
          }}
          onBlur={() => setFocused(false)}
          onClick={() => {
            setFocused(false);
            hint.onOpenChange(hint.open !== "press");
          }}
        >
          <Icon name="info" size={14} />
        </button>
      </RPopover.Anchor>
      <span id={hintId} hidden>
        {children}
      </span>
      <RPopover.Portal>
        <RPopover.Content
          role="tooltip"
          className="ac-hint__bubble ac-glass"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={EDGE_ROOM}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={onAnchor}
          onFocusOutside={onAnchor}
          {...hint.content}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
