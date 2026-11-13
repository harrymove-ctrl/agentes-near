import { type ReactNode, useRef } from "react";
import { cx } from "../cx";
import { useScrollSides } from "../hooks/useScrollSides";
import { Icon } from "../icons/Icon";

export interface CarouselProps {
  /** Names the row for screen readers ("Olhos"). */
  label: string;
  previousLabel: string;
  nextLabel: string;
  children: ReactNode;
  className?: string;
}

/**
 * One row of choices that slides sideways (the agent's eyes and what it
 * wears), item by item. An arrow floats over each edge with more to see (the
 * row fades under it), so the row starts where rows that fit do; trackpads and
 * touch scroll it too.
 */
export function Carousel({ label, previousLabel, nextLabel, children, className }: CarouselProps) {
  const track = useRef<HTMLDivElement>(null);
  const more = useScrollSides(track);
  const go = (direction: 1 | -1) => {
    const el = track.current;
    el?.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };
  return (
    <div className={cx("ac-carousel", className)} data-more={more}>
      <button
        type="button"
        className="ac-carousel__arrow"
        aria-label={previousLabel}
        disabled={more !== "start" && more !== "both"}
        onClick={() => go(-1)}
      >
        <Icon name="chevronLeft" size={14} />
      </button>
      {/* biome-ignore lint/a11y/useSemanticElements: a row of pressable choices, not a native fieldset */}
      <div ref={track} className="ac-carousel__track" role="group" aria-label={label}>
        {children}
      </div>
      <button
        type="button"
        className="ac-carousel__arrow"
        aria-label={nextLabel}
        disabled={more !== "end" && more !== "both"}
        onClick={() => go(1)}
      >
        <Icon name="chevronRight" size={14} />
      </button>
    </div>
  );
}
