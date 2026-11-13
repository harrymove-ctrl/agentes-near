import { Slot } from "radix-ui";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { Kbd } from "./Kbd";
import { Spinner } from "./Skeleton";

export type ButtonVariant = "default" | "primary" | "agent" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` at most once per area; `agent` only to ask an agent for
   * something ("Pedir à Ada": cut corner + agent icon); `danger` to refuse or
   * delete; `ghost` in toolbars.
   */
  variant?: ButtonVariant;
  /** The control ruler: `md` 40 (default), `sm` 32 (toolbars, rows, composer), `lg` 48 (only a full screen's main action). */
  size?: "md" | "sm" | "lg";
  /**
   * Leading icon. With `iconOnly`, the only content (then `aria-label` is required); `iconOnly` with no `icon` shows
   * its child as the glyph (a stop square, an `Icon` of its own).
   */
  icon?: IconName;
  iconOnly?: boolean;
  block?: boolean;
  /** Keyboard hints after the label: `["⌘", "↵"]`. */
  kbd?: string[];
  /** An async action is running: inline spinner, same width, not clickable (`aria-busy`). */
  loading?: boolean;
  /** Render the child element (e.g. a router link) with the button styles. */
  asChild?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "default",
    size = "md",
    icon,
    iconOnly,
    block,
    asChild,
    loading,
    kbd,
    className,
    children,
    type = "button",
    disabled,
    ...rest
  },
  ref,
) {
  const leading = variant === "agent" && !icon ? "agent" : icon;
  // An icon and nothing else is an icon button, said or not: square, as `ac-btn--icon` draws it.
  const onlyIcon =
    iconOnly || (Boolean(leading) && !asChild && (children == null || children === false || children === "") && !kbd);
  const classes = cx(
    "ac-btn",
    variant !== "default" && `ac-btn--${variant}`,
    size !== "md" && `ac-btn--${size}`,
    onlyIcon && "ac-btn--icon",
    block && "ac-btn--block",
    loading && "ac-btn--loading",
    className,
  );
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} aria-disabled={disabled || undefined} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {/* The label stays (invisible) while loading, so the width never changes. */}
      {leading && <Icon name={leading} />}
      {(!iconOnly || !leading) && children}
      {!iconOnly && kbd && kbd.length > 0 && (
        <span className="ac-btn__kbd" aria-hidden="true">
          {kbd.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      )}
      {loading && <Spinner className="ac-btn__spinner" size={size === "sm" ? 14 : 16} />}
    </button>
  );
});

/**
 * A button's words that take turns ("Copiar link", then "Copiado"), each with its icon (in place of the button's own
 * `icon`): both stay in place, the other one unseen, so the button keeps the wider one's width and doesn't move under
 * the pointer when they change. The one shown sits in the middle with its icon beside it, the same padding at both ends.
 */
export function SwapLabel({
  label,
  alt,
  showAlt,
  icon,
  altIcon = icon,
}: {
  label: ReactNode;
  alt: ReactNode;
  showAlt: boolean;
  icon?: IconName;
  altIcon?: IconName;
}) {
  return (
    <span className="ac-swap">
      <span aria-hidden={showAlt || undefined}>
        {icon && <Icon name={icon} />}
        {label}
      </span>
      <span aria-hidden={!showAlt || undefined}>
        {altIcon && <Icon name={altIcon} />}
        {alt}
      </span>
    </span>
  );
}
