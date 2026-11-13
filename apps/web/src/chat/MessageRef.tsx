import { useMessageCard } from "@agenteschat/client";
import { type MessageLink, messageRefLabel } from "@agenteschat/client/lib/message-links";
import { Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/**
 * A message's link in a message (ours: `parseMessageLink`), as a pill like Discord's: "# general › 💬", "@Ana › 💬"
 * in a DM, "# general › Thread › 💬" for a reply. A click opens the message in the app (scrolled to and highlighted),
 * never a new tab. One the viewer can't see is a plain "Mensagem sem acesso" pill that names nothing of its place.
 */
export function MessageRef({ link }: { link: MessageLink }) {
  const { t } = useTranslation();
  const card = useMessageCard(link.orgId, link.messageId);
  if (card.isPending) {
    return (
      <span className="channel-ref message-ref" aria-busy="true">
        <Icon name="message" size={14} label={t("messageRefs.message")} />
      </span>
    );
  }
  const c = card.data;
  if (!c) {
    return (
      <span className="message-ref message-ref--none">
        <Icon name="lock" size={14} />
        {messageRefLabel(t, null)}
      </span>
    );
  }
  const where =
    c.kind === "dm" ? (
      `@${c.name}`
    ) : (
      <>
        <Icon name="channel" size={14} />
        {c.name}
      </>
    );
  const parts = (
    <>
      {where}
      {c.threadId && (
        <>
          <Icon name="chevronRight" size={14} className="message-ref__sep" />
          {t("messageRefs.thread")}
        </>
      )}
      <Icon name="chevronRight" size={14} className="message-ref__sep" />
      <Icon name="message" size={14} />
    </>
  );
  const label = messageRefLabel(t, c);
  const search = { m: c.id };
  return c.threadId ? (
    <Link
      to="/org/$orgId/threads/$threadId"
      params={{ orgId: link.orgId, threadId: c.threadId }}
      search={search}
      className="channel-ref message-ref"
      aria-label={label}
      title={label}
    >
      {parts}
    </Link>
  ) : (
    <Link
      to="/org/$orgId/c/$channelId"
      params={{ orgId: link.orgId, channelId: c.channelId }}
      search={search}
      className="channel-ref message-ref"
      aria-label={label}
      title={label}
    >
      {parts}
    </Link>
  );
}
