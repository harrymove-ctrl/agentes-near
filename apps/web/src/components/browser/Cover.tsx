import { cx, Icon, type IconName, PixelSpinner } from "@agenteschat/ui";
import { type ReactNode, useRef } from "react";
import { ComputerSky, type colorOf } from "../Sky";
import "./browser.css";

/**
 * What covers the page (or the agent's desktop) instead of it: a state said plainly, with a spinner only
 * while something is on its way; `action`: what the person can do about it.
 */
export function Cover({
  icon,
  art,
  spinner,
  sky,
  color,
  text,
  help,
  action,
  className,
  clear,
}: {
  className?: string;
  /** Dimmed, not frosted: the picture under it stays in sight (a switch between watching and control, a question). */
  clear?: boolean;
  icon?: IconName;
  /** A picture over the words instead of the icon (the computer's portrait). */
  art?: ReactNode;
  spinner?: boolean;
  /** The agent's sky behind it (a screen opening). */
  sky?: boolean;
  color: ReturnType<typeof colorOf>;
  text: ReactNode;
  help?: ReactNode;
  action?: ReactNode;
}) {
  const box = useRef<HTMLSpanElement>(null);
  return (
    <div className={cx("brw-dim", sky && "brw-dim--sky", clear && "is-clear", className)}>
      {sky && <ComputerSky color={color} clear={() => [box.current]} />}
      <span className="brw-dim__box" role="status" ref={box}>
        {art}
        <span className="brw-dim__row">
          {spinner ? <PixelSpinner size={16} color={color} /> : icon && <Icon name={icon} size={16} />}
          {text}
        </span>
        {help && <small>{help}</small>}
        {action}
      </span>
    </div>
  );
}
