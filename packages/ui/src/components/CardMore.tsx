import { type RefObject, useEffect, useState } from "react";
import { Button } from "./Button";

/** A row this far into the fade counts as hidden: its first line may show, faded, but it can't be read. */
const FADE_READ = 40;

/** What a cut card hides: whether its content runs past it, and how many of its rows (list items, table rows). */
export interface CardCut {
  cut: boolean;
  hidden: number;
}

/** The rows of a card's content: list items and table rows, without the ones that hold other rows. */
function rowsOf(body: HTMLElement): HTMLElement[] {
  const all = [...body.querySelectorAll<HTMLElement>("li, tbody > tr")];
  return all.filter((el) => !el.querySelector("li, tbody > tr"));
}

/**
 * Whether `body` (overflow hidden, its card's height capped in CSS) holds more than it shows, and how many rows end
 * under its fade. Measured again whenever the body or its content changes size.
 */
export function useCardCut(body: RefObject<HTMLElement | null>, enabled = true): CardCut {
  const [state, setState] = useState<CardCut>({ cut: false, hidden: 0 });
  useEffect(() => {
    const el = body.current;
    if (!enabled || !el) {
      setState((s) => (s.cut ? { cut: false, hidden: 0 } : s));
      return;
    }
    const measure = () => {
      const cut = el.scrollHeight > el.clientHeight + 1;
      const bottom = el.getBoundingClientRect().bottom - FADE_READ;
      const hidden = cut ? rowsOf(el).filter((r) => r.getBoundingClientRect().bottom > bottom).length : 0;
      setState((s) => (s.cut === cut && s.hidden === hidden ? s : { cut, hidden }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const size = new ResizeObserver(measure);
    size.observe(el);
    for (const child of el.children) size.observe(child);
    const rows = new MutationObserver(() => {
      for (const child of el.children) size.observe(child);
      measure();
    });
    rows.observe(el, { childList: true, subtree: true });
    return () => {
      size.disconnect();
      rows.disconnect();
    };
  }, [body, enabled]);
  return state;
}

/**
 * The foot of a cut card: its content fades into the card's ground and "See more" sits on the fade, with how many
 * rows it hides. The card opens all of it (a dialog, or the widget's panel).
 */
export function CardMore({
  label,
  hiddenLabel,
  hidden,
  onOpen,
}: {
  /** "See more". */
  label: string;
  /** What screen readers hear after the label: "5 more". */
  hiddenLabel?: string;
  hidden: number;
  onOpen: () => void;
}) {
  return (
    <div className="ac-card-more">
      <Button size="sm" onClick={onOpen} aria-label={hiddenLabel ? `${label}, ${hiddenLabel}` : undefined}>
        {label}
        {hidden > 0 && (
          <span className="ac-card-more__n" aria-hidden="true">
            +{hidden}
          </span>
        )}
      </Button>
    </div>
  );
}
