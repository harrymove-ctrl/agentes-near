import { type CSSProperties, useEffect, useState } from "react";
import { cx } from "../cx";

/** The widest a GIF shows in a message (CSS pixels): bigger than a sticker, never a banner. */
export const CHAT_GIF_MAX = 300;

const REDUCE = "(prefers-reduced-motion: reduce)";
const reducedNow = () => typeof matchMedia === "function" && matchMedia(REDUCE).matches;

/** Whether the person asked for less motion, following the setting while the page is open. */
function useReducedMotion() {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(REDUCE);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export interface ChatGifProps {
  /** The moving file (our server's media route, `size=full`). */
  src: string;
  /** Its still frame (`size=still`): shown with reduced motion until hovered or focused. */
  still: string;
  /** Of the file, in pixels: the box keeps its shape before it loads (nothing below jumps). */
  width: number;
  height: number;
  /** The accessible name ("GIF: gato dançando"). */
  label: string;
  /** Its title (the provider's words): what its place shows when its file no longer loads. */
  title?: string;
  /** The small mark on its corner ("GIF"). */
  mark: string;
  /** Where it comes from, shown on hover ("GIPHY"). */
  source: string;
  className?: string;
}

/**
 * A GIF in a message (ADR 0091): the picture itself in the cut-corner frame, as wide as it is up to 300px, with a
 * small "GIF" mark and its source on hover. With reduced motion it stands still and plays only while hovered or
 * focused (it takes the keyboard's focus for that). A file that no longer loads (GIFs turned off in the workspace,
 * the GIF gone) leaves a quiet card of its size with its title and the mark, never a broken picture.
 */
export function ChatGif({ src, still, width, height, label, title, mark, source, className }: ChatGifProps) {
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  const style = {
    "--gif-w": `${Math.min(CHAT_GIF_MAX, w)}px`,
    "--gif-ar": `${w} / ${h}`,
  } as CSSProperties;
  if (failed) {
    return (
      <span className={cx("ac-gif ac-gif--off", className)} style={style} role="img" aria-label={label}>
        {title?.trim() && (
          <span className="ac-gif__title" aria-hidden="true">
            {title.trim()}
          </span>
        )}
        <span className="ac-gif__mark" aria-hidden="true">
          {mark}
        </span>
      </span>
    );
  }
  const moving = !reduced || playing;
  const body = (
    <>
      <img
        src={moving ? src : still}
        alt={label}
        width={w}
        height={h}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      <span className="ac-gif__mark" aria-hidden="true">
        {mark}
      </span>
      <span className="ac-gif__source" aria-hidden="true">
        {source}
      </span>
    </>
  );
  if (!reduced) {
    return (
      <span className={cx("ac-gif", className)} style={style}>
        {body}
      </span>
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering or focusing only plays it, nothing to activate
    <span
      className={cx("ac-gif", className)}
      style={style}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: with reduced motion the keyboard plays it by focusing it
      tabIndex={0}
      data-still={playing ? undefined : ""}
      onMouseEnter={() => setPlaying(true)}
      onMouseLeave={() => setPlaying(false)}
      onFocus={() => setPlaying(true)}
      onBlur={() => setPlaying(false)}
    >
      {body}
    </span>
  );
}
