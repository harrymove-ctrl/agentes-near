import { badgeCount } from "@agenteschat/client/lib/unread";
import { Button, CountBadge } from "@agenteschat/ui";

/**
 * Back to the latest messages: a round button at the bottom right of the message list, while the person reads more
 * than a screen above the end or something new arrived below. It counts what arrived, in red when one mentions the
 * person (as the sidebar's mention count). Always mounted, so it fades in and out; hidden, it is out of the tab order
 * and of the accessibility tree.
 */
export function ToLatest({
  shown,
  count,
  mentionsMe,
  label,
  onClick,
}: {
  shown: boolean;
  count: number;
  mentionsMe: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="channel__latest" data-shown={shown || undefined} aria-hidden={!shown || undefined}>
      <span className="channel__latest-at">
        <Button
          iconOnly
          icon="arrowDown"
          className="channel__latest-btn"
          aria-label={label}
          tabIndex={shown ? 0 : -1}
          onClick={onClick}
        />
        {count > 0 && (
          <CountBadge className="channel__latest-count" data-mention={mentionsMe || undefined} aria-hidden="true">
            {badgeCount(count)}
          </CountBadge>
        )}
      </span>
    </div>
  );
}
