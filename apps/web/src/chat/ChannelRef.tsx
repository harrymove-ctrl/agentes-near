import { useArchivedChannels, useChannelCard, useChannels, useJoinChannel } from "@agenteschat/client";
import { joinable } from "@agenteschat/client/lib/channel-access";
import { channelCardFacts, resolveChannelRef } from "@agenteschat/client/lib/channel-refs";
import { Button, Chip, Icon, movesByKeys, Popover, useHoverCard } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FocusEvent, type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRestoreChannel } from "@/components/entity-menus";
import { useOrg } from "@/components/org-context";
import { HOVER_OPEN_MS } from "@/components/ProfileCard";

/**
 * `#name` in a message: a link to the channel it means (`resolveChannelRef`), with its card on hover or keyboard
 * focus; a click opens the channel, even with the card showing. A channel the viewer can't see stays the text as written; an archived one opens only its card. From the
 * keyboard, Enter opens the channel and ArrowDown or Space moves into the card (Join, Open).
 */
export function ChannelRef({ name, text, refs }: { name: string; text: string; refs?: Record<string, string> }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const channels = useChannels(org.id).data ?? [];
  const ref = resolveChannelRef(name, refs, channels);
  // A channel the list doesn't have (archived, or not mine): only the server knows if it may show.
  const lookup = useChannelCard(org.id, ref?.id ?? "", Boolean(ref && !ref.known));
  const card = useHoverCard(HOVER_OPEN_MS);
  // Keyboard focus on the link shows the card too, without taking the focus (Enter opens the channel).
  const [focused, setFocused] = useState(false);
  const open = card.open || (focused ? "hover" : false);
  const body = useRef<HTMLDivElement>(null);
  const [intoCard, setIntoCard] = useState(false);
  // The card may already be open from the focus (without taking it): move in once it shows.
  useEffect(() => {
    if (!intoCard || open !== "press") return;
    setIntoCard(false);
    (body.current?.querySelector<HTMLElement>("button") ?? body.current)?.focus();
  });
  if (!ref || (!ref.known && !lookup.data)) return <>{text}</>;
  const shown = ref.known?.name ?? lookup.data?.name ?? name;
  const archived = !ref.known && lookup.data?.archived === true;
  const label = archived ? t("channelRefs.archivedLabel", { name: shown }) : t("channelRefs.label", { name: shown });
  const focus = {
    onFocus: () => {
      if (!open && movesByKeys()) setFocused(true);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!(e.relatedTarget instanceof Node && body.current?.contains(e.relatedTarget))) setFocused(false);
    },
  };
  const className = archived ? "channel-ref channel-ref--archived" : "channel-ref";
  return (
    <Popover
      hover={card}
      open={open !== false}
      onOpenChange={(o) => {
        if (!o) setFocused(false);
      }}
      moveFocus={open === "press"}
      label={t("channelRefs.card", { name: shown })}
      side="bottom"
      className="profile-card channel-card"
      trigger={
        archived ? (
          <button type="button" className={className} aria-label={label} aria-haspopup="dialog" {...focus}>
            #{shown}
          </button>
        ) : (
          // The link navigates (and so keeps the card closed: a prevented click never toggles it).
          <Link
            to="/org/$orgId/c/$channelId"
            params={{ orgId: org.id, channelId: ref.id }}
            className={className}
            aria-label={label}
            aria-keyshortcuts="ArrowDown Space"
            // Before the hover card's own click, which would pin the card it shows instead of following the link.
            onClick={(e: MouseEvent) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              setFocused(false);
              card.close();
              void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: ref.id } });
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key !== "ArrowDown" && e.key !== " ") return;
              e.preventDefault();
              setFocused(false);
              card.onOpenChange(true);
              setIntoCard(true);
            }}
            {...focus}
          >
            #{shown}
          </Link>
        )
      }
    >
      {open && (
        <div ref={body} tabIndex={-1}>
          <ChannelCardBody
            channelId={ref.id}
            onDone={() => {
              setFocused(false);
              card.close();
            }}
          />
        </div>
      )}
    </Popover>
  );
}

function ChannelCardBody({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const card = useChannelCard(org.id, channelId);
  const join = useJoinChannel(org.id, channelId);
  // An archived one this person may bring back (their creator or who manages channels): Restaurar.
  const restorable = useArchivedChannels(org.id, card.data?.archived === true).data?.some((x) => x.id === channelId);
  const restore = useRestoreChannel();
  const c = card.data;
  if (!c) return <p className="small muted">{card.isError ? t("channelRefs.gone") : t("channelRefs.loading")}</p>;
  const openIt = () => {
    onDone();
    void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId } });
  };
  return (
    <div className="profile-card__body">
      <div className="channel-card__head">
        <Icon name={c.archived ? "archive" : c.visibility === "private" ? "lock" : "channel"} size={16} />
        <span className="profile-card__name">#{c.name}</span>
        {c.archived && <Chip>{t("channelRefs.archived")}</Chip>}
      </div>
      {c.topic && <p className="channel-card__topic">{c.topic}</p>}
      <p className="small muted channel-card__facts">{channelCardFacts(t, c)}</p>
      {c.archived && restorable && (
        <div className="profile-card__actions">
          <Button size="sm" icon="undo" disabled={restore.pending} onClick={() => restore.run(c, onDone)}>
            {t("channel.restore")}
          </Button>
        </div>
      )}
      {!c.archived && (
        <div className="profile-card__actions">
          {joinable(c) && (
            <Button
              size="sm"
              variant="primary"
              loading={join.isPending}
              onClick={() => join.mutate(undefined, { onSuccess: openIt })}
            >
              {t("channelRefs.join")}
            </Button>
          )}
          <Button size="sm" onClick={openIt}>
            {t("channelRefs.open")}
          </Button>
        </div>
      )}
    </div>
  );
}
