import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx } from "../cx";
import type { AgentColor } from "./AgentLook";
import { PixelDone, PixelFail, PixelStop } from "./PixelMarks";
import { PixelSpinner } from "./PixelSpinner";

/** A line's state: working on it, done, it failed, or the run was stopped during it. */
export type ToolBlockState = "run" | "done" | "fail" | "stop";

export interface ToolBlockLine {
  key: string;
  state: ToolBlockState;
  /** The app's logo (a connector's mark, or the icon of one of ours). */
  logo: ReactNode;
  /** "Consultando o GitHub…", "Consultou o GitHub". */
  label: string;
  /** Grey words after it: the tool's own name or the built-in's label. */
  hint?: string | null;
  /** "1,2 s". */
  time?: string;
  /** "×5": several calls of the same kind in a row. */
  count?: string;
  /** Why it failed, under the line. */
  why?: string | null;
  /** Its open view (what it was given and answered, the code and its output); without it the line doesn't open. */
  detail?: ReactNode;
  /** Opens by itself (a call running code shows it as it runs). */
  defaultOpen?: boolean;
}

export type ToolBlockItem = { kind: "line"; line: ToolBlockLine } | { kind: "note"; key: string; node: ReactNode };

export interface ToolBlockHead {
  /** What it does now ("Consultando o banco…"), or "Usou 5 ferramentas" once done. */
  text: string;
  /** Changes when what it does changes: the words slide in again. */
  textKey?: string;
  /** The mark after the text: the spinner while it works. None once done. */
  state?: ToolBlockState;
  /** "4 passos" while it works. */
  count?: string;
  /** "6 s" once done. */
  time?: string;
}

/**
 * The tools of one reply: one line while it works, what it does now, the apps' logos and how
 * many steps; a click opens every call, each with its phrase, the tool in grey, its time and a pixel mark
 * (the orbit, one green pixel, an exclamation), and opens again into what it was given and answered. What the
 * agent said between calls and the messages it read sit among the lines (`note`). A single call (`one`) is its own
 * line, with nothing to open around it: what was said goes in that line's open view.
 */
export function ToolBlock({
  logos,
  head,
  items,
  color,
  label,
  defaultOpen = false,
  onToggle,
  className,
  one = false,
}: {
  logos: ReactNode[];
  head: ToolBlockHead;
  items: ToolBlockItem[];
  /** The agent's color: its spinners. */
  color?: AgentColor;
  /** The block's name for screen readers ("O que a Ana fez"). */
  label: string;
  defaultOpen?: boolean;
  /** Opened (load the saved steps) or closed; with `one`, its line. */
  onToggle?: (open: boolean) => void;
  className?: string;
  /** The work is one call: its line in place of the head ("Criou uma rotina", not "Usou 1 ferramenta"). */
  one?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Its lines stay once opened, so closing folds them away smoothly.
  const [shown, setShown] = useState(defaultOpen);
  const id = useId();
  const only = one ? items.find((i) => i.kind === "line") : undefined;
  if (only?.kind === "line") {
    const notes = items.flatMap((i) => (i.kind === "note" ? [i] : []));
    const detail =
      notes.length > 0 ? (
        <>
          {notes.map((n) => (
            <p key={n.key} className="ac-tools__note">
              {n.node}
            </p>
          ))}
          {only.line.detail}
        </>
      ) : (
        only.line.detail
      );
    return (
      <section className={cx("ac-tools ac-tools--one", className)} aria-label={label}>
        <ol className="ac-tools__lines" aria-live="polite">
          <Line line={{ ...only.line, detail }} color={color} onToggle={onToggle} />
        </ol>
      </section>
    );
  }
  return (
    <section className={cx("ac-tools", className)} aria-label={label}>
      <button
        type="button"
        className="ac-tools__head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          setShown(true);
          onToggle?.(!open);
        }}
      >
        {logos.length > 0 && <span className="ac-tools__logos">{logos}</span>}
        <span className="ac-tools__now" aria-live="polite">
          <span
            key={head.textKey ?? head.text}
            className={cx("ac-tools__text", head.state === "run" && "ac-tools__shimmer")}
          >
            {head.text}
          </span>
        </span>
        {head.count && <span className="ac-tools__count">{head.count}</span>}
        {head.time && <span className="ac-tools__count">{head.time}</span>}
        {head.state && <Mark state={head.state} color={color} />}
        <Chevron className="ac-tools__chev" />
      </button>
      <div className="ac-tools__fold" id={id} data-folded={!open || undefined}>
        <div>
          {shown && (
            <ol className="ac-tools__lines">
              {items.map((item) =>
                item.kind === "note" ? (
                  <li key={item.key} className="ac-tools__note">
                    {item.node}
                  </li>
                ) : (
                  <Line key={item.line.key} line={item.line} color={color} />
                ),
              )}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

function Line({
  line,
  color,
  onToggle,
}: {
  line: ToolBlockLine;
  color?: AgentColor;
  onToggle?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(line.defaultOpen === true);
  // Open while it runs (its code), it folds when the call ends; a click opens it again.
  const running = useRef(line.state === "run");
  useEffect(() => {
    if (running.current && line.state !== "run") setOpen(false);
    running.current = line.state === "run";
  }, [line.state]);
  const id = useId();
  const opens = Boolean(line.detail);
  const body = (
    <>
      <span className="ac-tools__logo">{line.logo}</span>
      <span className="ac-tools__label">
        <b className={line.state === "run" ? "ac-tools__shimmer" : undefined}>{line.label}</b>
        {line.hint && <small>{line.hint}</small>}
      </span>
      {line.count && <span className="ac-tools__time">{line.count}</span>}
      {line.time && <span className="ac-tools__time">{line.time}</span>}
      <Mark state={line.state} color={color} />
      {opens ? <Chevron className="ac-tools__linechev" /> : <span className="ac-tools__linechev" />}
    </>
  );
  return (
    <li className="ac-tools__line" data-s={line.state}>
      {opens ? (
        <button
          type="button"
          className="ac-tools__row"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => {
            setOpen(!open);
            onToggle?.(!open);
          }}
        >
          {body}
        </button>
      ) : (
        <p className="ac-tools__row">{body}</p>
      )}
      {line.why && <p className="ac-tools__why">{line.why}</p>}
      {open && opens && (
        <div className="ac-tools__detail" id={id}>
          {line.detail}
        </div>
      )}
    </li>
  );
}

/** The pixel marks: the orbit while it works, one green pixel when done, an exclamation if it failed. */
function Mark({ state, color }: { state: ToolBlockState; color?: AgentColor }) {
  return (
    <span className="ac-tools__mark">
      {state === "run" ? (
        <PixelSpinner size={14} color={color} />
      ) : state === "done" ? (
        <PixelDone size={14} />
      ) : state === "fail" ? (
        <PixelFail size={14} />
      ) : (
        <PixelStop size={12} dim />
      )}
    </span>
  );
}

function Chevron({ className }: { className: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
