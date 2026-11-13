import { Checkbox as RCheckbox, RadioGroup as RRadioGroup, Switch as RSwitch } from "radix-ui";
import type { MouseEvent, ReactNode } from "react";
import { cx } from "../cx";

export interface CheckboxProps {
  /** `"indeterminate"`: some children checked (tri-state groups). Toggling it checks it. */
  checked: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
  /**
   * The click itself, before it toggles: for what a modifier key changes (Shift picks a range). `preventDefault` keeps
   * the box as it was.
   */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * Our checkbox (Radix Checkbox: a `role="checkbox"` button, Space toggles;
 * `aria-checked="mixed"` when indeterminate). Pair it with a `<label htmlFor>`.
 */
export function Checkbox({ checked, onCheckedChange, className, ...rest }: CheckboxProps) {
  return (
    <RCheckbox.Root
      className={cx("ac-check", className)}
      checked={checked}
      onCheckedChange={(v) => onCheckedChange?.(v === true)}
      {...rest}
    >
      {/* v2: the check is drawn (stroke-dashoffset); indeterminate is a dash. */}
      <RCheckbox.Indicator className="ac-check__mark">
        <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" className="ac-check__svg">
          {checked === "indeterminate" ? (
            <path className="ac-check__dash" d="M3 6h6" />
          ) : (
            <path className="ac-check__tick" d="m2.5 6.2 2.3 2.3 4.7-5" />
          )}
        </svg>
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export interface CheckboxPillProps extends CheckboxProps {
  id: string;
  children: ReactNode;
}

/** A labelled checkbox shaped as a pill (e.g. "#eng", "GitHub: ler e abrir PRs"). */
export function CheckboxPill({ id, checked, onCheckedChange, disabled, children, className }: CheckboxPillProps) {
  return (
    <label htmlFor={id} className={cx("ac-pill", className)} data-checked={checked}>
      <Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      <span>{children}</span>
    </label>
  );
}

export interface RadioGroupProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}

/** Radio group (Radix: arrow keys move and select, one tab stop). */
export function RadioGroup<V extends string>({ value, onValueChange, className, ...rest }: RadioGroupProps<V>) {
  return (
    <RRadioGroup.Root className={className} value={value} onValueChange={(v) => onValueChange(v as V)} {...rest} />
  );
}

export function Radio({
  value,
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <RRadioGroup.Item
      value={value}
      id={id}
      disabled={disabled}
      className={cx("ac-radio", className)}
      aria-label={ariaLabel}
    >
      <RRadioGroup.Indicator className="ac-radio__dot" />
    </RRadioGroup.Item>
  );
}

/** A card with a radio, a title and a description (onboarding key choice). */
export function RadioCard({
  value,
  id,
  checked,
  title,
  description,
  disabled,
  aside,
  detail,
}: {
  value: string;
  id: string;
  checked: boolean;
  title: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Trailing content on the title's line, e.g. an "Em breve" chip. */
  aside?: ReactNode;
  /** A line of its own under the description, in its words' style, e.g. what the option in use holds. */
  detail?: ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className="ac-option"
      data-state={checked ? "checked" : "unchecked"}
      data-disabled={disabled ? "" : undefined}
    >
      <Radio value={value} id={id} disabled={disabled} />
      <span className="ac-option__text">
        <span className="ac-option__head">
          <span className="ac-option__title">{title}</span>
          {aside && <span className="ac-option__aside">{aside}</span>}
        </span>
        {description && <span className="ac-option__desc">{description}</span>}
        {detail && <span className="ac-option__desc">{detail}</span>}
      </span>
    </label>
  );
}

/** Our on/off switch (Radix Switch: `role="switch"`, Space toggles). Pair it with a `<label htmlFor>`. */
export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
  className,
  ...rest
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <RSwitch.Root
      className={cx("ac-switch", className)}
      checked={checked}
      onCheckedChange={onCheckedChange}
      id={id}
      disabled={disabled}
      {...rest}
    >
      <RSwitch.Thumb className="ac-switch__thumb" />
    </RSwitch.Root>
  );
}
