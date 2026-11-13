import { type ReactNode, useId, useState } from "react";
import { cx } from "../cx";
import { Spinner } from "./Skeleton";

export interface WorkStep {
  key: string;
  label: ReactNode;
  /** "3 s". */
  time?: string;
  failed?: boolean;
  /** Still loading: a spinner instead of the check. */
  pending?: boolean;
  /** Shown under the step (e.g. the code it ran and its output). */
  detail?: ReactNode;
  /** What the agent said between steps (narration): muted text, no check. */
  note?: boolean;
}

/**
 * What an agent did, under its message: "4 passos · himetrica, Drive · 12 s",
 * expandable into the steps (each with a check, or an alert when it failed).
 */
export function WorkSummary({
  summary,
  steps,
  defaultOpen = false,
  onToggle,
  className,
}: {
  /** The header line, e.g. <><strong>4 passos</strong> · himetrica, Drive · 12 s</>. */
  summary: ReactNode;
  steps: WorkStep[];
  defaultOpen?: boolean;
  /** Called when it opens (load the steps lazily) or closes. */
  onToggle?: (open: boolean) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cx("ac-work", className)}>
      <button
        type="button"
        className="ac-work__head"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setOpen(!open);
          onToggle?.(!open);
        }}
      >
        <svg className="ac-work__chev" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span>{summary}</span>
      </button>
      {open && (
        <ol className="ac-work__steps" id={id}>
          {steps.map((s) => (
            <li key={s.key} className={cx("ac-work__step", s.note && "ac-work__step--note")}>
              {s.note ? (
                <span className="ac-work__gap" aria-hidden="true" />
              ) : (
                <span
                  className={cx("ac-tick", s.failed && "ac-tick--failed", s.pending && "ac-tick--pending")}
                  aria-hidden="true"
                >
                  {s.pending ? (
                    <Spinner size={14} />
                  ) : s.failed ? (
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M6 3v3.5M6 8.6v.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                    </svg>
                  )}
                </span>
              )}
              <span>{s.label}</span>
              {s.time && <span className="ac-work__time">{s.time}</span>}
              {s.detail && <div className="ac-work__detail">{s.detail}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One reaction pill: an emoji (or icon) + count; pressed when it's mine. */
export function Reaction({
  pressed,
  count,
  label,
  title,
  children,
  onClick,
  disabled,
}: {
  pressed?: boolean;
  /** How many, as the person's language writes it ("1.284"). */
  count?: ReactNode;
  /** Accessible name: "Útil, 2". */
  label: string;
  /** Tooltip, e.g. who reacted. */
  title?: string;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="ac-react"
      aria-pressed={pressed}
      aria-label={label}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
      {count !== undefined && <span className="tabular">{count}</span>}
    </button>
  );
}

export function Reactions({ children, label }: { children: ReactNode; label: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar-like group of toggle buttons
    <div className="ac-reacts" role="group" aria-label={label}>
      {children}
    </div>
  );
}
