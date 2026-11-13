import type { ReactionCount } from "@agenteschat/client";
import { useReactions, useToggleReaction } from "@agenteschat/client";
import { formatInt, joinNames } from "@agenteschat/client/lib/format";
import {
  Button,
  EMOJI_CATEGORIES,
  type EmojiCategoryId,
  type EmojiPickerLabels,
  EmojiPickerPopover,
  Icon,
  Reaction,
  Reactions,
} from "@agenteschat/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { AgentAvatar } from "./AgentAvatar";
import { useCorrectionAsk } from "./CorrectionAsk";
import { useOrg } from "./org-context";

/** 👍/👎 are stored as `+1`/`-1`: on an agent's reply they are feedback that teaches it. */
export const UP = "+1";
export const DOWN = "-1";
const THUMBS_UP = "👍";
const THUMBS_DOWN = "👎";

/** How a stored reaction shows ("+1" → 👍). */
export const reactionEmoji = (reaction: string) =>
  reaction === UP ? THUMBS_UP : reaction === DOWN ? THUMBS_DOWN : reaction;
/** What a picked emoji is stored as (👍 → "+1"), so the picker's thumbs are the feedback ones. */
export const reactionOf = (emoji: string) => (emoji === THUMBS_UP ? UP : emoji === THUMBS_DOWN ? DOWN : emoji);

/** Whether I reacted with `reaction`, and how many did. */
export function reactionState(list: ReactionCount[] | undefined, reaction: string, userId: string) {
  const r = list?.find((x) => x.reaction === reaction);
  return { mine: Boolean(r?.userIds.includes(userId)), count: r?.count ?? 0 };
}

/** The picker's words, translated. */
export function useEmojiLabels(): EmojiPickerLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      dialog: t("emoji.dialog"),
      search: t("emoji.search"),
      noResults: t("emoji.noResults"),
      recent: t("emoji.recent"),
      results: t("emoji.results"),
      categories: Object.fromEntries(EMOJI_CATEGORIES.map((c) => [c, t(`emoji.categories.${c}`)])) as Record<
        EmojiCategoryId,
        string
      >,
    }),
    [t],
  );
}

/**
 * A message's reactions: the list from the message (server) until this
 * client loaded or heard newer ones (`message.reactions`), and `toggle`.
 * On an agent's reply (`feedback`), 👍 and 👎 are one opinion: one replaces the other,
 * and my 👎 opens the private "refaça ou explique" card under it (`CorrectionAsk`).
 */
export function useMessageReactions(
  messageId: string,
  initial: ReactionCount[] | undefined,
  options: { feedback?: boolean; load?: boolean } = {},
) {
  const { org, me } = useOrg();
  const loaded = useReactions(org.id, messageId, Boolean(options.load));
  const mutation = useToggleReaction(org.id, messageId);
  const ask = useCorrectionAsk();
  const list = loaded.data ?? initial ?? [];
  const toggle = (reaction: string) => {
    const mine = reactionState(list, reaction, me.user.id).mine;
    if (options.feedback && !mine && (reaction === UP || reaction === DOWN)) {
      const other = reaction === UP ? DOWN : UP;
      if (reactionState(list, other, me.user.id).mine) mutation.mutate({ reaction: other, on: false });
    }
    if (options.feedback && (reaction === UP || reaction === DOWN)) {
      if (reaction === DOWN && !mine) ask.open(messageId);
      else ask.clear(messageId);
    }
    mutation.mutate({ reaction, on: !mine });
  };
  return { list, toggle, pending: mutation.isPending, userId: me.user.id };
}

/** "Reagir" on the hover bar: the picker; picking an emoji I already gave takes it back. */
export function ReactButton({ onPick }: { onPick: (emoji: string) => void }) {
  const { t } = useTranslation();
  const labels = useEmojiLabels();
  return (
    <EmojiPickerPopover
      labels={labels}
      onPick={onPick}
      align="end"
      trigger={<Button variant="ghost" size="sm" iconOnly icon="smile" aria-label={t("reactions.react")} />}
    />
  );
}

/**
 * Pills under a message (people's and agents'): emoji + count, pressed when
 * mine, who reacted in the tooltip and the accessible name; "+" adds another.
 */
export function MessageReactions({
  messageId,
  initial,
  feedback,
}: {
  messageId: string;
  initial?: ReactionCount[];
  /** An agent's reply: 👍/👎 replace each other (they teach the agent). */
  feedback?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const labels = useEmojiLabels();
  const { list, toggle, userId } = useMessageReactions(messageId, initial, { feedback });
  const shown = list.filter((r) => r.count > 0);
  if (shown.length === 0) return null;
  const nameOf = (id: string) =>
    id === userId ? t("reactions.you") : (dir.memberById.get(id)?.name ?? t("reactions.someone"));
  const agentName = (id: string) => dir.anyAgent(id)?.name ?? t("reactions.someone");
  return (
    <Reactions label={t("channel.reactions")}>
      {shown.map((r) => {
        const emoji = reactionEmoji(r.reaction);
        const agentIds = r.agentIds ?? [];
        const who = t("reactions.who", {
          count: r.count,
          names: joinNames([...r.userIds.map(nameOf), ...agentIds.map(agentName)], t),
          emoji,
        });
        return (
          <Reaction
            key={r.reaction}
            pressed={r.userIds.includes(userId)}
            count={formatInt(i18n.language, r.count)}
            label={who}
            title={who}
            onClick={() => toggle(r.reaction)}
          >
            <span className="ac-react__emoji" aria-hidden="true">
              {emoji}
            </span>
            {agentIds.length > 0 && (
              // Agents that reacted instead of replying: their mini avatars, in the same pill.
              <span className="msg-react__agents" aria-hidden="true">
                {agentIds.slice(0, 3).map((id) => (
                  <AgentAvatar key={id} agentId={id} name={agentName(id)} size="xs" state="idle" />
                ))}
              </span>
            )}
          </Reaction>
        );
      })}
      <EmojiPickerPopover
        labels={labels}
        onPick={(emoji) => toggle(reactionOf(emoji))}
        side="top"
        align="start"
        trigger={
          <button type="button" className="ac-react ac-react--add" aria-label={t("reactions.add")}>
            <Icon name="smile" size={14} />
            <Icon name="plus" size={14} />
          </button>
        }
      />
    </Reactions>
  );
}
