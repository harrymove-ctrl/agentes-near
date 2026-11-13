import { DropdownMenu } from "radix-ui";
import { type ReactNode, useEffect, useState } from "react";
import { cx } from "../cx";
import { EDGE_ROOM } from "../floating";
import { Icon, type IconName } from "../icons/Icon";

/** Dropdown menu (Radix DropdownMenu: arrow keys, typeahead, Esc, focus return). */
export function Menu({
  trigger,
  children,
  align = "start",
  side = "bottom",
  label,
  className,
  onClosed,
}: {
  /** A focusable element (usually a `Button`). */
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  label?: string;
  className?: string;
  /** Once it has closed, just before focus goes back to the trigger. */
  onClosed?: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={cx("ac-menu ac-menu--dropdown", className)}
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={EDGE_ROOM}
          aria-label={label}
          onCloseAutoFocus={(e) => {
            onClosed?.();
            // An item that opened something which took focus (the emoji picker) keeps it there.
            if (document.activeElement && document.activeElement !== document.body) e.preventDefault();
          }}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  onSelect,
  icon,
  leading,
  danger,
  disabled,
  children,
  description,
  hint,
}: {
  onSelect?: () => void;
  icon?: IconName;
  /** In place of the icon: whose item it is (an agent's face, a person's avatar). */
  leading?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
  description?: ReactNode;
  /** Quiet text on the right: the current value of what it opens ("Só o que é arriscado"). */
  hint?: ReactNode;
}) {
  return (
    <DropdownMenu.Item
      className={cx("ac-menu__item", danger && "ac-menu__item--danger")}
      onSelect={onSelect}
      disabled={disabled}
    >
      {leading ? (
        <span className="ac-menu__leading" aria-hidden="true">
          {leading}
        </span>
      ) : (
        icon && <Icon name={icon} />
      )}
      <span className="ac-menu__label">
        {children}
        {description && <span className="ac-menu__desc">{description}</span>}
      </span>
      {hint && <span className="ac-menu__hint">{hint}</span>}
    </DropdownMenu.Item>
  );
}

/**
 * A face at a menu's head that changes it (the account menu's own photo): an item, since a menu takes no Tab, so the
 * arrow keys and Enter reach it. Hover and focus lay the photo glyph over it; a touch screen, with no hover, keeps a
 * small photo badge on its corner instead. `label` names it and is its tooltip.
 */
export function MenuFace({ label, onSelect, children }: { label: string; onSelect: () => void; children: ReactNode }) {
  return (
    <DropdownMenu.Item className="ac-face-edit" aria-label={label} title={label} textValue={label} onSelect={onSelect}>
      {children}
      <span className="ac-face-edit__glyph" aria-hidden="true">
        <Icon name="image" size={16} />
      </span>
      <span className="ac-face-edit__badge" aria-hidden="true">
        <Icon name="image" size={14} />
      </span>
    </DropdownMenu.Item>
  );
}

export function MenuRadioGroup({
  label,
  value,
  onValueChange,
  options,
}: {
  label: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  /** `leading`: a mark after the check (a presence badge). */
  options: { value: string; label: ReactNode; leading?: ReactNode }[];
}) {
  return (
    <DropdownMenu.Group>
      <DropdownMenu.Label className="ac-menu__heading">{label}</DropdownMenu.Label>
      <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
        {options.map((o) => (
          <DropdownMenu.RadioItem key={o.value} value={o.value} className="ac-menu__item">
            {o.leading && (
              <span className="ac-menu__leading" aria-hidden="true">
                {o.leading}
              </span>
            )}
            <span className="ac-menu__label">{o.label}</span>
            <svg className="ac-menu__check" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5.5 10.5 3 3 6-7" />
            </svg>
          </DropdownMenu.RadioItem>
        ))}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Group>
  );
}

/** An item that opens a menu of its own beside it (→, Enter or the pointer). ← goes back to the item. */
export function MenuSub({ icon, label, children }: { icon?: IconName; label: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="ac-menu__item">
        {icon && <Icon name={icon} />}
        <span className="ac-menu__label">{label}</span>
        <Icon name="chevronRight" size={16} className="ac-menu__chevron" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          className="ac-menu ac-menu--dropdown"
          sideOffset={12}
          alignOffset={-6}
          collisionPadding={EDGE_ROOM}
        >
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

/**
 * An on/off item ("Mostrar canceladas"): a check at its end when on; the menu stays open, unless `closes` (a choice
 * that settles the menu, beside checkable ones).
 */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  icon,
  leading,
  children,
  description,
  hint,
  disabled,
  closes = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Lines its name up with the icon items around it. */
  icon?: IconName;
  /** In place of the icon: whose item it is (an agent's face, a person's avatar), as in `MenuItem`. */
  leading?: ReactNode;
  children: ReactNode;
  /** A second line under its name (why it can't be picked). */
  description?: ReactNode;
  /** Quiet text on the right (how many it shows). */
  hint?: ReactNode;
  disabled?: boolean;
  /** Picking it closes the menu. */
  closes?: boolean;
}) {
  return (
    <DropdownMenu.CheckboxItem
      className="ac-menu__item"
      checked={checked}
      disabled={disabled}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      onSelect={closes ? undefined : (e) => e.preventDefault()}
    >
      {leading ? (
        <span className="ac-menu__leading" aria-hidden="true">
          {leading}
        </span>
      ) : (
        icon && <Icon name={icon} />
      )}
      <span className="ac-menu__label">
        {children}
        {description && <span className="ac-menu__desc">{description}</span>}
      </span>
      {hint && <span className="ac-menu__hint">{hint}</span>}
      <svg className="ac-menu__check" viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5.5 10.5 3 3 6-7" />
      </svg>
    </DropdownMenu.CheckboxItem>
  );
}

/** A quiet line of explanation inside a menu ("Tarefas novas entram aqui."); not focusable. */
export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="ac-menu__note">{children}</p>;
}

/** A small uppercase heading over a group of items ("Lembrar de novo"). */
export function MenuHeading({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="ac-menu__heading">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="ac-menu__separator" />;
}

/** The `::highlight()` name that keeps a right-clicked selection painted (components.css). */
const KEPT_SELECTION = "ac-kept-selection";

/**
 * The page's text selection when a menu at a point opens. WebKit (the Mac app) drops the selection's
 * paint once the menu takes focus: it stays painted through the CSS Custom Highlight API while the menu
 * is open, and comes back as the real selection when it closes (Esc, an item), so ⌘C still copies it.
 */
function selectedRanges() {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange());
}

/** Paints `ranges` until the returned cleanup, which also puts them back as the selection if it was emptied. */
function keepSelection(ranges: Range[]) {
  const g = globalThis as {
    CSS?: { highlights?: Map<string, unknown> };
    Highlight?: new (...ranges: Range[]) => unknown;
  };
  const highlights = g.CSS?.highlights;
  if (highlights && g.Highlight) highlights.set(KEPT_SELECTION, new g.Highlight(...ranges));
  return () => {
    highlights?.delete(KEPT_SELECTION);
    // A click elsewhere that closed the menu sets its own selection right after: only an emptied one comes back.
    const now = window.getSelection();
    if (!now?.isCollapsed) return;
    now.removeAllRanges();
    for (const range of ranges) now.addRange(range);
  };
}

/**
 * A menu at a point: the right click of the desktop app. The same items as `Menu`, open at once under the
 * pointer (no grow-in), flipped at the window's edges, closed by Esc, a click outside, scrolling the page or
 * leaving the window. Give it a new `key` for each opening so it is placed again. Given a box (`width`, `height`),
 * it opens beside the box instead, under it or over it, never on it. `follows`: the owner keeps `at` on what the menu
 * belongs to as it moves, so scrolling or resizing doesn't close it.
 */
export function MenuAt({
  at,
  onClose,
  follows,
  label,
  align = "start",
  children,
}: {
  at: { x: number; y: number; width?: number; height?: number };
  onClose: () => void;
  follows?: boolean;
  label?: string;
  align?: "start" | "end";
  children: ReactNode;
}) {
  // Read before the menu takes focus (the first render), put back when it goes.
  const [kept] = useState(selectedRanges);
  useEffect(() => (kept ? keepSelection(kept) : undefined), [kept]);
  useEffect(() => {
    const close = () => onClose();
    const onScroll = (e: Event) => {
      // Scrolling a long menu itself keeps it open.
      if (e.target instanceof Element && e.target.closest(".ac-menu--at")) return;
      onClose();
    };
    window.addEventListener("blur", close);
    if (!follows) {
      window.addEventListener("resize", close);
      window.addEventListener("scroll", onScroll, true);
    }
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose, follows]);
  return (
    <DropdownMenu.Root open onOpenChange={(open) => !open && onClose()} modal={false}>
      <DropdownMenu.Trigger asChild>
        <span
          aria-hidden="true"
          style={{
            position: "fixed",
            left: at.x,
            top: at.y,
            width: at.width ?? 0,
            height: at.height ?? 0,
            pointerEvents: "none",
          }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ac-menu ac-menu--dropdown ac-menu--at"
          align={align}
          side="bottom"
          sideOffset={2}
          collisionPadding={EDGE_ROOM}
          // Following, placed again each frame: Radix can't see a point (0 by 0) move.
          updatePositionStrategy={follows ? "always" : "optimized"}
          aria-label={label}
          // Radix names the menu after its trigger, here a hidden point with no text: the label names it instead.
          {...(label ? { "aria-labelledby": undefined } : {})}
          // The page keeps its focus (the composer, the selection), as with the system's menus.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A row of quick reactions at the top of a menu (a message's right click). */
export function MenuReactions({
  emojis,
  onPick,
  label,
  more,
}: {
  emojis: readonly string[];
  onPick: (emoji: string) => void;
  label: string;
  /** A last cell that opens every emoji, drawn as the add-reaction pill under a message (`.ac-react--add`). */
  more?: { label: string; onSelect: () => void };
}) {
  return (
    <DropdownMenu.Group className="ac-menu__reactions" aria-label={label}>
      {emojis.map((emoji) => (
        <DropdownMenu.Item key={emoji} className="ac-menu__reaction" onSelect={() => onPick(emoji)}>
          {emoji}
        </DropdownMenu.Item>
      ))}
      {more && (
        <DropdownMenu.Item
          className="ac-menu__reaction ac-menu__reaction--more"
          aria-label={more.label}
          onSelect={more.onSelect}
        >
          <Icon name="smile" size={14} />
          <Icon name="plus" size={14} />
        </DropdownMenu.Item>
      )}
    </DropdownMenu.Group>
  );
}
