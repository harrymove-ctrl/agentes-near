import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../cx";
import { Button, type ButtonProps } from "./Button";
import { CountChip } from "./Chip";
import { useFieldControl } from "./Field";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** A small neutral count chip after the label (e.g. Missões 1); hidden when 0 or absent. */
  count?: number;
  /** A small mark before the label (a level's pixel swatch). */
  mark?: ReactNode;
  /** Hover text (e.g. what the option means). */
  title?: string;
  /** A quiet number after the label, no chip (filters: "Tudo 14"); shown as given, hidden when absent. */
  hint?: number | string;
}

/**
 * A segmented control: one choice of a few, a raised pill slides (spring)
 * under the chosen one. Radio semantics (`radiogroup` / `radio`), arrows move.
 * A value no option has (several things that differ) shows no choice, and Tab
 * reaches the first option. Inside a `Field` (with `group`) it takes the field's full width and label.
 */
export function Segmented<V extends string>({
  value,
  onValueChange,
  options,
  label,
  size = "md",
  disabled = false,
  block = false,
  className,
}: {
  value: V;
  onValueChange: (value: V) => void;
  options: SegmentedOption<V>[];
  label: string;
  size?: "md" | "sm";
  /** Shown, not changed (a member reading an admin's setting, a setting this server can't use). */
  disabled?: boolean;
  /** Fills its row, outside a form's column too (beside a section's heading, in a side panel). */
  block?: boolean;
  className?: string;
}) {
  const field = useFieldControl({});
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const chosen = options.findIndex((o) => o.value === value);
  const index = Math.max(0, chosen);
  // Measured after every render (labels and counts change the width; same values keep the state),
  // and again when the chosen item resizes (fonts loading, a count arriving).
  useLayoutEffect(() => {
    const el = refs.current[index];
    if (!el) return;
    const measure = () =>
      setPill((p) =>
        p && p.x === el.offsetLeft && p.w === el.offsetWidth ? p : { x: el.offsetLeft, w: el.offsetWidth },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  const move = (step: number) => {
    if (disabled) return;
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onValueChange(next.value);
    refs.current[(index + step + options.length) % options.length]?.focus();
  };
  return (
    <div
      role="radiogroup"
      {...(field.labelledBy ? { "aria-labelledby": field.labelledBy } : { "aria-label": label })}
      aria-describedby={field["aria-describedby"]}
      aria-disabled={disabled || undefined}
      className={cx("ac-seg", size === "sm" && "ac-seg--sm", block && "ac-seg--block", className)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {pill && chosen >= 0 && (
        <span
          className="ac-seg__pill"
          aria-hidden="true"
          style={{ "--x": `${pill.x}px`, "--w": `${pill.w}px` } as CSSProperties}
        />
      )}
      {options.map((o, i) => (
        // biome-ignore lint/a11y/useSemanticElements: a roving-focus radio group of buttons (arrow keys), styled as a segmented control
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === index ? 0 : -1}
          className="ac-seg__item"
          data-on={o.value === value || undefined}
          title={o.title}
          disabled={disabled}
          onClick={() => onValueChange(o.value)}
        >
          {o.mark}
          {o.label}
          {o.hint != null && o.hint !== "" ? <span className="ac-seg__hint">{o.hint}</span> : null}
          {o.count ? <CountChip size={size === "sm" ? "sm" : undefined}>{o.count}</CountChip> : null}
        </button>
      ))}
    </div>
  );
}

/** A button with a second part that opens more options ("Criar issue" | ▾). */
export function SplitButton({
  children,
  onClick,
  menu,
  className,
  ...rest
}: Omit<ButtonProps, "variant" | "asChild"> & {
  /** The second part (e.g. a `Menu` whose trigger is a Button with `aria-label`). */
  menu: ReactNode;
}) {
  return (
    <div className={cx("ac-split", className)}>
      <Button onClick={onClick} {...rest}>
        {children}
      </Button>
      {menu}
    </div>
  );
}
