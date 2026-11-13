import { RadioGroup as RRadioGroup } from "radix-ui";
import { Fragment, type ReactNode } from "react";
import { cx } from "../cx";
import { useLocked } from "./Field";

export interface OptionListItem<V extends string> {
  value: V;
  title: ReactNode;
  /** Quiet words after the title ("Recomendado", "Em teste"). */
  tag?: ReactNode;
  /** One short line under the title. */
  description?: ReactNode;
  /** Before the text: an illustration (`AutonomyPixels`), an icon, an avatar. Without it, a radio dot. */
  leading?: ReactNode;
  /** Shown but not choosable now (say why in `description`). */
  disabled?: boolean;
  /** Cards only: at the bottom of the card (a chip with where it runs). */
  foot?: ReactNode;
  /** Rows only: quiet words at the row's end (where it runs). Hidden on narrow screens. */
  side?: ReactNode;
  /** Its settings, under the row while it is the one chosen, aligned with the row's text. */
  children?: ReactNode;
}

export interface OptionListProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  options: OptionListItem<V>[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Shown but not changeable (the choice is kept, the others fade). */
  disabled?: boolean;
  /**
   * `rows` (default): full-width rows. `cards`: side by side, the illustration
   * on top; the chosen card's
   * settings go under all of them. One column on narrow screens. `tiles`: two
   * per row, the leading icon on the title's line.
   */
  layout?: "rows" | "cards" | "tiles";
  /**
   * Rows only: the chosen row and its settings are one card, the
   * settings full width under a hairline; rows with a leading keep their radio dot too.
   */
  attached?: boolean;
  className?: string;
}

/**
 * A vertical list of choices as full-width rows of the same height, one left
 * edge, neutral selection (e.g. a mission's Autonomia and Quem faz o
 * trabalho). Radix RadioGroup: `role="radio"` rows, one tab stop, arrow
 * keys move and select. A row leads with its illustration, or a radio dot.
 * The chosen row can carry its own settings (`children`) right under it.
 */
export function OptionList<V extends string>({
  value,
  onValueChange,
  options,
  disabled,
  layout = "rows",
  attached,
  className,
  ...rest
}: OptionListProps<V>) {
  const locked = useLocked();
  const cards = layout === "cards";
  const tiles = layout === "tiles";
  const card = attached && !cards && !tiles;
  const item = (o: OptionListItem<V>) => (
    <RRadioGroup.Item
      key={o.value}
      value={o.value}
      disabled={o.disabled}
      className={cx("ac-optrow", o.leading ? "ac-optrow--lead" : undefined)}
    >
      {(!o.leading || card) && <span className="ac-optrow__dot" aria-hidden="true" />}
      {o.leading && <span className="ac-optrow__lead">{o.leading}</span>}
      {cards && o.leading && <span className="ac-optrow__dot ac-optrow__dot--corner" aria-hidden="true" />}
      <span className="ac-optrow__text">
        <span className="ac-optrow__title">
          {o.title}
          {o.tag && <span className="ac-optrow__tag">{o.tag}</span>}
        </span>
        {o.description && <span className="ac-optrow__desc">{o.description}</span>}
      </span>
      {cards && o.foot && <span className="ac-optrow__foot">{o.foot}</span>}
      {!cards && !tiles && o.side && <span className="ac-optrow__side">{o.side}</span>}
    </RRadioGroup.Item>
  );
  const chosen = options.find((o) => o.value === value);
  return (
    <RRadioGroup.Root
      className={cx(
        "ac-optlist",
        cards && "ac-optlist--cards",
        tiles && "ac-optlist--tiles",
        (disabled || locked) && "ac-optlist--locked",
        card && "ac-optlist--attached",
        className,
      )}
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      disabled={disabled}
      orientation={cards || tiles ? undefined : "vertical"}
      loop
      {...rest}
    >
      {cards ? (
        <>
          <div className="ac-optlist__cards">{options.map(item)}</div>
          {chosen?.children && <div className="ac-optrow__more ac-optrow__more--cards">{chosen.children}</div>}
        </>
      ) : (
        options.map((o) =>
          card && o.value === value && o.children ? (
            <div key={o.value} className="ac-optcard">
              {item(o)}
              <div className="ac-optrow__more ac-optrow__more--card">{o.children}</div>
            </div>
          ) : (
            <Fragment key={o.value}>
              {item(o)}
              {o.value === value && o.children && (
                <div className={cx("ac-optrow__more", o.leading ? "ac-optrow__more--lead" : undefined)}>
                  {o.children}
                </div>
              )}
            </Fragment>
          ),
        )
      )}
    </RRadioGroup.Root>
  );
}
