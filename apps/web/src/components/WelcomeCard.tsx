import { Button, cx } from "@agenteschat/ui";
import { type ReactNode, useRef } from "react";
import { WelcomeSky } from "@/components/Sky";
import "./welcome.css";

/**
 * The welcome on a small sky: the onboarding's last step and a newcomer's first #general (ADR 0090). A title and a
 * lead, the faces of who works there, actions on the sky's glass and a close button, each when given. The sky stays
 * calm behind the words, and its pixel agents keep off the faces and the buttons.
 */
export function WelcomeCard({
  title,
  titleId,
  lead,
  crew,
  actions,
  onClose,
  closeLabel,
  level = 1,
  className,
}: {
  title: ReactNode;
  titleId: string;
  lead: ReactNode;
  crew?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  /** The title's heading level: 2 under a page's own title (a channel's). */
  level?: 1 | 2;
  className?: string;
}) {
  const text = useRef<HTMLDivElement>(null);
  const faces = useRef<HTMLDivElement>(null);
  const acts = useRef<HTMLDivElement>(null);
  const shut = useRef<HTMLButtonElement>(null);
  const Heading = level === 2 ? "h2" : "h1";
  return (
    <section className={cx("welcome-card", className)} aria-labelledby={titleId}>
      <WelcomeSky calm={() => [text.current]} clear={() => [faces.current, acts.current, shut.current]} />
      <div className="welcome-card__text" ref={text}>
        <Heading id={titleId} className="welcome-card__title">
          {title}
        </Heading>
        <p className="welcome-card__lead">{lead}</p>
      </div>
      {crew && (
        <div className="welcome-card__crew" ref={faces}>
          {crew}
        </div>
      )}
      {actions && (
        <div className="welcome-card__acts" ref={acts}>
          {actions}
        </div>
      )}
      {onClose && (
        <Button
          ref={shut}
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="welcome-card__close"
          aria-label={closeLabel}
          onClick={onClose}
        />
      )}
    </section>
  );
}
