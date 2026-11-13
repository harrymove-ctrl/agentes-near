import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";
import { Icon } from "../icons/Icon";

export interface EventPillProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** A request waiting for someone: its words in ink (the pulsing mark and a `primary` action say the rest). */
  waiting?: boolean;
  /** The event's mark (an `Icon`, `PixelStop`), quiet. */
  mark: ReactNode;
  /** One sentence: what happened ("You stopped Ada", "Routine «Sentry» delivered a report"). */
  children: ReactNode;
  time?: string;
  /** Its `EventPillAction`s and `EventPillMore`, inside the frame after a hairline. */
  actions?: ReactNode;
  /** Under the frame: the opened text, a reason's field. */
  below?: ReactNode;
}

/**
 * An automatic event of a conversation (an agent stopped, a follow-up set, a request decided) as one object: a thin
 * frame holding the sentence and what can be done about it, aligned with the messages' text. Never a voice, never a
 * card: no fill, one hairline.
 */
export function EventPill({
  mark,
  children,
  time,
  actions,
  below,
  waiting = false,
  className,
  ...rest
}: EventPillProps) {
  return (
    <div className={cx("ac-eventpill", waiting && "ac-eventpill--waiting", className)} {...rest}>
      <span className="ac-eventpill__frame">
        <span className="ac-eventpill__main">
          <span className="ac-eventpill__mark">{mark}</span>
          <span className="ac-eventpill__text">{children}</span>
          {time && <span className="ac-eventpill__time">{time}</span>}
        </span>
        {actions && <span className="ac-eventpill__actions">{actions}</span>}
      </span>
      {below}
    </div>
  );
}

export interface EventPillActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  lead?: ReactNode;
  /** What a request waiting for the viewer asks for ("Connect", "Continue now"): a soft tint, no border. */
  primary?: boolean;
}

/** One action inside an `EventPill` ("Continue", "Add a reason", "Cancel"), split from the next by a hairline. */
export function EventPillAction({
  lead,
  primary = false,
  className,
  children,
  type = "button",
  ...rest
}: EventPillActionProps) {
  return (
    <button
      type={type}
      className={cx("ac-eventpill__action", primary && "ac-eventpill__action--primary", className)}
      {...rest}
    >
      {lead}
      {children}
    </button>
  );
}

/** The action that opens what the line leaves out ("Show", "See details") under the pill; its chevron turns. */
export function EventPillMore({
  open,
  className,
  children,
  ...rest
}: Omit<EventPillActionProps, "lead"> & { open: boolean }) {
  return (
    <EventPillAction aria-expanded={open} className={cx("ac-eventpill__more", className)} {...rest}>
      {children}
      <Icon name="chevronRight" size={14} className="ac-eventpill__chev" />
    </EventPillAction>
  );
}
