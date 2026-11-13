import type { ReactNode } from "react";
import { cx } from "../cx";
import { Spinner } from "./Skeleton";

export type WorkLineTone = "working" | "waiting" | "queued" | "done" | "failed" | "stopped";

/**
 * A long work's line (ADR 0121), under the agent's "Vou cuidar disso" and on its card: how it stands
 * ("Em segundo plano · 12 min · próximo update em ~8 min"), the latest update as a second line, and its
 * actions (Tarefa #42, Parar, Ver resultado). Plain text that wraps: nothing is cut.
 */
export function WorkLine({
  tone,
  text,
  update,
  question,
  actions,
  className,
}: {
  tone: WorkLineTone;
  text: string;
  /** The latest update, plain text. */
  update?: string | null;
  /** What it waits to hear: two lines at most, all of it on hover. */
  question?: string | null;
  /** Links and buttons after the line. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("ac-iconline", "ac-workline", `ac-workline--${tone}`, className)} role="status">
      <span className="ac-workline__mark" aria-hidden="true">
        {tone === "working" ? <Spinner size={14} /> : <WorkMark tone={tone} />}
      </span>
      <div className="ac-workline__body">
        <p className="ac-workline__text">
          <span>{text}</span>
          {actions}
        </p>
        {question ? (
          <p className="ac-workline__question" title={question}>
            {question}
          </p>
        ) : null}
        {update ? <p className="ac-workline__update">{update}</p> : null}
      </div>
    </div>
  );
}

function WorkMark({ tone }: { tone: WorkLineTone }) {
  if (tone === "done")
    return (
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  if (tone === "failed")
    return (
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M6 3v3.5M6 8.6v.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  if (tone === "stopped")
    return (
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" />
      </svg>
    );
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 3v3.2l2 1.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** One action on a work's line: a link-looking button ("Tarefa #42", "Ver resultado") or Parar (`danger`). */
export function WorkLineAction({
  children,
  onClick,
  danger,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("ac-workline__action", danger && "ac-workline__action--danger")}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** The agent's plan on a work's card ("Plano do agente"): each step with its mark. */
export function WorkPlan({
  label,
  progress,
  items,
}: {
  label: string;
  /** "2 de 5". */
  progress?: string;
  items: { key: string; text: string; state: "todo" | "doing" | "done" }[];
}) {
  return (
    <div className="ac-workplan">
      <p className="ac-workplan__head">
        <span>{label}</span>
        {progress ? <span className="ac-workplan__count">{progress}</span> : null}
      </p>
      <ol className="ac-workplan__steps">
        {items.map((s) => (
          <li key={s.key} className={cx("ac-workplan__step", `ac-workplan__step--${s.state}`)}>
            <span className={cx("ac-tick", s.state !== "done" && "ac-tick--pending")} aria-hidden="true">
              {s.state === "done" ? (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              ) : s.state === "doing" ? (
                <Spinner size={14} />
              ) : (
                <span className="ac-workplan__dot" />
              )}
            </span>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
