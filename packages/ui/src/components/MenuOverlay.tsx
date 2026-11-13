import { Dialog as RDialog } from "radix-ui";
import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { Button } from "./Button";
import { CountChip } from "./Chip";
import { Kbd } from "./Kbd";

/**
 * A menu that takes the whole screen: the
 * app behind blurs (`html[data-menu-overlay]`), the card that opened it grows
 * into the header, and the options are our menu items, larger. Radix Dialog
 * underneath: focus trap, Esc, focus back to the trigger. ↑↓ move between
 * items; a digit opens the item with that `shortcut`.
 */
export function MenuOverlay({
  open,
  onOpenChange,
  anchor,
  mark,
  title,
  meta,
  closeLabel,
  backdrop,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The card that opened it: the header grows out of it. */
  anchor?: RefObject<HTMLElement | null>;
  /** Logo or photo, 64 px. */
  mark: ReactNode;
  title: ReactNode;
  /** One quiet line under the title. */
  meta?: ReactNode;
  closeLabel: string;
  /** Behind the content (a pixel horizon), absolutely placed. */
  backdrop?: ReactNode;
  children: ReactNode;
}) {
  const header = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);

  // The app behind blurs while open.
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.dataset.menuOverlay = "";
    return () => {
      delete root.dataset.menuOverlay;
    };
  }, [open]);

  // The header grows out of the card (FLIP), then focus goes to the first item.
  useLayoutEffect(() => {
    if (!open) return;
    const from = anchor?.current?.getBoundingClientRect();
    const to = header.current?.getBoundingClientRect();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (from && to && to.width > 0 && !reduced && header.current?.animate) {
      header.current.animate(
        [
          {
            transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
            transformOrigin: "0 0",
            opacity: 0.3,
          },
          { transform: "none", transformOrigin: "0 0", opacity: 1 },
        ],
        { duration: 600, easing: "cubic-bezier(.3,1.2,.4,1)" },
      );
    }
    content.current?.querySelector<HTMLElement>("[data-menu-overlay-item]")?.focus({ preventScroll: true });
  }, [open, anchor]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(content.current?.querySelectorAll<HTMLElement>("[data-menu-overlay-item]") ?? [])];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = i < 0 ? 0 : Math.min(items.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
      items[next]?.focus();
      return;
    }
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const target = items.find((el) => el.dataset.shortcut === e.key);
      if (target) {
        e.preventDefault();
        target.focus();
        target.click();
      }
    }
  };

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="ac-mo__scrim" />
        <RDialog.Content
          ref={content}
          className="ac-mo"
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            // A click on the empty stage closes it, like the scrim.
            if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("ac-mo__wrap"))
              onOpenChange(false);
          }}
        >
          {backdrop && (
            <div className="ac-mo__backdrop" aria-hidden="true">
              {backdrop}
            </div>
          )}
          <RDialog.Close asChild>
            <Button variant="ghost" iconOnly className="ac-mo__close" aria-label={closeLabel}>
              <Icon name="close" />
            </Button>
          </RDialog.Close>
          <div className="ac-mo__wrap">
            <header ref={header} className="ac-mo__head">
              <span className="ac-mo__mark">{mark}</span>
              <span className="ac-mo__titles">
                <RDialog.Title className="ac-mo__title">{title}</RDialog.Title>
                {meta && <span className="ac-mo__meta">{meta}</span>}
              </span>
            </header>
            {children}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** A group of options: our menu surface; `heading` shows above the items, `label` only names it. */
export function MenuOverlayGroup({
  label,
  heading,
  children,
}: {
  label?: string;
  heading?: string;
  children: ReactNode;
}) {
  return (
    <div className="ac-menu ac-mo__group" role="menu" aria-label={label ?? heading}>
      {heading && <span className="ac-menu__heading">{heading}</span>}
      {children}
    </div>
  );
}

export function MenuOverlaySeparator() {
  return <hr className="ac-menu__separator" />;
}

/**
 * One option: our menu item, larger. `count` sits by the name (a count chip),
 * `hint` on the right (the current value), `shortcut` shows on hover/focus.
 */
export function MenuOverlayItem({
  icon,
  leading,
  children,
  description,
  count,
  hint,
  shortcut,
  danger,
  current,
  onSelect,
}: {
  icon?: IconName;
  /** In place of the icon (a workspace's mark). */
  leading?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  count?: number;
  hint?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  /** The one you're in (workspaces). */
  current?: boolean;
  onSelect: () => void;
}) {
  let lead: ReactNode = null;
  if (leading) lead = <span className="ac-mo__leading">{leading}</span>;
  else if (icon) lead = <Icon name={icon} />;
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={current || undefined}
      className={cx("ac-menu__item ac-mo__item", danger && "ac-menu__item--danger")}
      data-menu-overlay-item=""
      data-shortcut={shortcut}
      onClick={onSelect}
    >
      {lead}
      <span className="ac-menu__label">
        <span className="ac-mo__name">
          {children}
          {count !== undefined && <CountChip>{count}</CountChip>}
        </span>
        {description && <span className="ac-menu__desc">{description}</span>}
      </span>
      <span className="ac-menu__hint">
        {hint}
        <Kbd className="ac-mo__kbd" aria-hidden="true">
          {shortcut ?? ""}
        </Kbd>
      </span>
    </button>
  );
}
