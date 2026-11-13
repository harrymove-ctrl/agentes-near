import { Select as RSelect } from "radix-ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx";
import { movesByKeys, trackInput } from "../device";
import { EDGE_ROOM } from "../floating";
import { Icon } from "../icons/Icon";
import { useFieldControl } from "./Field";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Consecutive options with the same group get a heading (e.g. the model provider). */
  group?: string;
  /** Something before the label in the list (a person's avatar, an icon). */
  leading?: ReactNode;
  /**
   * A note behind an ⓘ at the option's end (plain sentences): shown while the pointer rests on the ⓘ, on a tap or
   * click on it (which never picks the option), and while the keys rest on the option; always its description.
   */
  hint?: string;
  /** A row that does something rather than a choice ("Nova categoria…"): a line sets the first one apart. */
  action?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: SelectOption<V>[];
  /** Taken from the surrounding `Field` when omitted. */
  id?: string;
  "aria-label"?: string;
  /** What the choice means, outside a `Field` (a strip's control: its meaning lives in its tip). */
  "aria-describedby"?: string;
  placeholder?: string;
  size?: "md" | "sm";
  disabled?: boolean;
  className?: string;
  /** Accessible name of the listbox; defaults to `aria-label`. */
  listLabel?: string;
  /** What the trigger shows for the chosen option (default: its `leading`, smaller, then its label). */
  renderValue?: (option: SelectOption<V>) => ReactNode;
  /**
   * The trigger's edge a list wider than the trigger lines up with: `end` for a select that ends its row, so the
   * list keeps the row's edge.
   */
  align?: "start" | "end";
  /** The list closed and focus goes back to the trigger (`preventDefault()` keeps it where it is). */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * What Radix gets for an option whose value is "" ("Ninguém"): Radix reads "" as nothing chosen and shows the
 * placeholder, so the trigger of a select set to that option would show an empty box.
 */
const EMPTY_VALUE = "\u0000";
const toRadix = (v: string) => (v === "" ? EMPTY_VALUE : v);

/** The options, a line before the first of a run of action rows that follows choices. */
function renderItems<V extends string>(items: SelectOption<V>[], all: typeof items) {
  return items.map((o) => {
    const item = <SelectItem key={o.value || EMPTY_VALUE} option={o} />;
    const before = all[all.indexOf(o) - 1];
    if (!o.action || !before || before.action) return item;
    return [<RSelect.Separator key={`${o.value}-sep`} className="ac-menu__separator" />, item];
  });
}

function SelectItem<V extends string>({ option: o }: { option: SelectOption<V> }) {
  const hintId = `hint${useId().replace(/[^\w-]/g, "")}`;
  const mark = useRef<HTMLSpanElement>(null);
  // Where the ⓘ is while its note shows: the list scrolls and clips, so the note is drawn over the page, above it.
  const [at, setAt] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (o.hint) trackInput();
  }, [o.hint]);
  const show = () => setAt(mark.current?.getBoundingClientRect() ?? null);
  const hide = () => setAt(null);
  const keep = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    // The chosen option shows by its background and a check at its end, whose room every row keeps: names line up.
    <RSelect.Item
      value={toRadix(o.value)}
      disabled={o.disabled}
      className="ac-menu__item"
      {...(o.hint
        ? {
            "aria-describedby": hintId,
            onFocus: () => (movesByKeys() ? show() : undefined),
            onBlur: hide,
          }
        : {})}
    >
      {o.leading && (
        <span className="ac-menu__leading" aria-hidden="true">
          {o.leading}
        </span>
      )}
      <span className="ac-menu__label">
        <RSelect.ItemText>{o.label}</RSelect.ItemText>
        {o.description && <span className="ac-menu__desc">{o.description}</span>}
      </span>
      {o.hint && (
        <span
          ref={mark}
          className="ac-hint ac-menu__hint"
          aria-hidden="true"
          data-state={at ? "open" : "closed"}
          onPointerEnter={show}
          onPointerLeave={hide}
          onPointerDown={keep}
          onPointerUp={keep}
          // Only shows: a mouse enters before it clicks, so a toggle would hide what the hover just showed.
          onClick={(e) => {
            keep(e);
            show();
          }}
        >
          <Icon name="info" size={14} />
          <span id={hintId} hidden>
            {o.hint}
          </span>
        </span>
      )}
      <svg className="ac-menu__check" viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5.5 10.5 3 3 6-7" />
      </svg>
      {at &&
        createPortal(
          <span
            className="ac-hint__bubble ac-glass ac-menu__tip"
            aria-hidden="true"
            style={{ right: window.innerWidth - at.right - 4, top: at.top - 6 }}
          >
            {o.hint}
          </span>,
          document.body,
        )}
    </RSelect.Item>
  );
}

/** The chosen option in a trigger: a person's face or a maker's logo before the name, as in the list. */
export function ChosenValue<V extends string>({ option }: { option: SelectOption<V> }) {
  return (
    <>
      {option.leading && (
        <span className="ac-select__lead" aria-hidden="true">
          {option.leading}
        </span>
      )}
      <span className="ac-select__text">{option.label}</span>
    </>
  );
}

/** Runs of consecutive options by `group` (ungrouped ones keep their place). */
function groupOptions<V extends string>(options: SelectOption<V>[]) {
  const out: [string | undefined, SelectOption<V>[]][] = [];
  for (const o of options) {
    const last = out[out.length - 1];
    if (last && last[0] === o.group) last[1].push(o);
    else out.push([o.group, [o]]);
  }
  return out;
}

/**
 * One choice from a short list. Our own trigger and listbox (Radix Select for
 * keyboard, focus and screen readers), never the native `<select>`. For more
 * than ~12 options use a searchable list in a Dialog.
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  id,
  placeholder,
  size = "md",
  disabled,
  className,
  listLabel,
  renderValue,
  align = "start",
  onCloseAutoFocus,
  ...rest
}: SelectProps<V>) {
  const wiring = useFieldControl({ id });
  const chosen = options.find((o) => o.value === value);
  return (
    <div className={cx("ac-select", size === "sm" && "ac-select--sm", className)}>
      <RSelect.Root
        // A value none of the options has (a list still loading, an option gone) is nothing chosen to Radix ("", its
        // placeholder): passed as it is, Radix shows that value with no item to draw it, an empty box.
        value={chosen ? toRadix(chosen.value) : value === undefined ? undefined : ""}
        onValueChange={(v) => onValueChange((v === EMPTY_VALUE ? "" : v) as V)}
        disabled={disabled}
      >
        <RSelect.Trigger
          className="ac-select__trigger"
          id={wiring.id}
          aria-label={rest["aria-label"]}
          aria-describedby={
            [wiring["aria-describedby"], rest["aria-describedby"]].filter(Boolean).join(" ") || undefined
          }
          aria-invalid={wiring["aria-invalid"]}
        >
          <span className="ac-select__value">
            {/* In elements of ours, never bare text nor Radix's portal of the chosen item's text: a browser translating
                the page replaces text nodes, and React then fails removing them when the value or the page changes. */}
            <RSelect.Value
              placeholder={placeholder ? <span className="ac-select__text">{placeholder}</span> : undefined}
            >
              {chosen ? (renderValue?.(chosen) ?? <ChosenValue option={chosen} />) : undefined}
            </RSelect.Value>
          </span>
          <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
            <path d="m6 8 4 4 4-4" />
          </svg>
        </RSelect.Trigger>
        <RSelect.Portal>
          <RSelect.Content
            className="ac-menu ac-menu--select"
            position="popper"
            sideOffset={4}
            collisionPadding={EDGE_ROOM}
            align={align}
            aria-label={listLabel ?? rest["aria-label"]}
            onCloseAutoFocus={onCloseAutoFocus}
          >
            <RSelect.Viewport>
              {groupOptions(options).map(([group, items]) =>
                group ? (
                  <RSelect.Group key={group}>
                    <RSelect.Label className="ac-menu__heading">{group}</RSelect.Label>
                    {renderItems(items, options)}
                  </RSelect.Group>
                ) : (
                  renderItems(items, options)
                ),
              )}
            </RSelect.Viewport>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </div>
  );
}
