import { useChannels, useDms } from "@agenteschat/client";
import { titledWithUnread, unreadTotal } from "@agenteschat/client/lib/unread";
import { useEffect, useRef } from "react";

/**
 * The tab's title carries the unread total, "(3) agentes.chat" (unread DM messages and mentions of me, what the
 * sidebar's numbers add up to; DMs with `hiddenAgents` left out, as the sidebar leaves them), over whatever title a
 * page sets.
 */
export function useUnreadTitle(orgId: string, hiddenAgents: ReadonlySet<string>) {
  const channels = useChannels(orgId).data;
  const dms = useDms(orgId).data;
  const total = unreadTotal(channels ?? [], dms ?? [], hiddenAgents);
  const mine = useRef("");
  useEffect(() => {
    const apply = () => {
      const next = titledWithUnread(document.title, total, mine.current);
      mine.current = next.prefix;
      if (next.title !== document.title) document.title = next.title;
    };
    apply();
    // Pages set their own titles: put the total back in front each time.
    const head = document.querySelector("head");
    const watch = head ? new MutationObserver(apply) : null;
    if (head) watch?.observe(head, { subtree: true, childList: true, characterData: true });
    return () => {
      watch?.disconnect();
      document.title = titledWithUnread(document.title, 0, mine.current).title;
      mine.current = "";
    };
  }, [total]);
}
