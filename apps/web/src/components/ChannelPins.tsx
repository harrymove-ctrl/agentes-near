import { type MessagePin, usePinMessage, usePins } from "@agenteschat/client";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { pinPreview, pinsIn } from "@agenteschat/client/lib/pins";
import { Button, CountChip, Icon, Popover } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import "./threads/threads.css";

/**
 * The pinned bar under a conversation's header (channel, DM or thread), only while something is pinned there: the
 * latest pin (who wrote it, its first line) and how many there are. A click opens every pin (`PinsPopover`).
 */
export function ChannelPinnedBar(props: { channelId: string; channelName?: string; threadId?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const pins = pinsIn(usePins(org.id, props.channelId).data ?? [], props.threadId);
  const latest = pins[0];
  if (!latest) return null;
  return (
    <PinsPopover {...props} align="start">
      <button type="button" className="pinbar" aria-label={t("channel.pins.button", { count: pins.length })}>
        <Icon name="pin" size={14} />
        <span className="pinbar__text">
          <b>{dir.authorName(latest.message.author)}</b> {pinPreview(t, latest)}
        </span>
        {pins.length > 1 && <CountChip>{pins.length}</CountChip>}
      </button>
    </PinsPopover>
  );
}

/** The channel header's pin: every pin of the channel, or that there are none yet. */
export function ChannelPinsButton({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t } = useTranslation();
  return (
    <PinsPopover channelId={channelId} channelName={channelName} align="end">
      <button
        type="button"
        className="ac-btn ac-btn--ghost ac-btn--icon channel__icon channel__pin"
        aria-label={t("channel.header.pins")}
        title={t("channel.header.pins")}
      >
        <Icon name="pin" />
      </button>
    </PinsPopover>
  );
}

/**
 * Every pin here, the latest first, from its trigger (`children`): a row goes to the message (paged in and
 * highlighted; a thread's opens its thread at it), "Desafixar" for whoever may post. Live through `message.pinned` /
 * `message.unpinned`, which refresh the pins query.
 */
function PinsPopover({
  channelId,
  channelName,
  threadId,
  align,
  children,
}: {
  channelId: string;
  /** A channel's name (`#name` in the list's title); none in a DM or a thread. */
  channelName?: string;
  threadId?: string;
  align: "start" | "end";
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const pin = usePinMessage(org.id);
  const [open, setOpen] = useState(false);
  const pins = pinsIn(usePins(org.id, channelId).data ?? [], threadId);
  const mayUnpin = can(org, "post");
  const go = (p: MessagePin) => {
    setOpen(false);
    if (!threadId && p.threadId && actions?.openThread) actions.openThread(p.threadId, p.messageId);
    else actions?.jumpTo?.(p.messageId);
  };
  const title = channelName ? t("channel.pins.in", { channel: channelName }) : t("channel.pins.title");
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align={align}
      className="thread-pop pins-pop"
      label={channelName ? t("channel.pins.label", { channel: channelName }) : t("channel.pins.title")}
      trigger={children}
    >
      <div className="thread-pop__head">
        <b>{title}</b>
        <small>{pins.length}</small>
      </div>
      {pins.length === 0 && <p className="thread-pop__empty">{t("channel.pins.empty")}</p>}
      <div className="thread-pop__list">
        {pins.map((p) => {
          const author = p.message.author;
          const name = dir.authorName(author);
          return (
            <div key={p.messageId} className="pins-pop__item">
              <button type="button" className="thread-pop__row ac-mediarow" onClick={() => go(p)}>
                <span className="ac-mediarow__face">
                  {author.id ? <ActorAvatar actor={{ type: author.type, id: author.id }} name={name} /> : <span />}
                </span>
                <span className="ac-mediarow__head thread-pop__name">
                  <b>{name}</b>
                </span>
                <small className="ac-mediarow__end pins-pop__time">{clockAt(i18n.language, p.message.createdAt)}</small>
                <small className="ac-mediarow__body thread-pop__sub">{pinPreview(t, p)}</small>
              </button>
              {mayUnpin && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="close"
                  aria-label={t("channel.pins.unpin", { name })}
                  title={t("contextMenu.unpin")}
                  disabled={pin.isPending}
                  onClick={() => pin.mutate({ channelId, messageId: p.messageId, pinned: false })}
                />
              )}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}
