import { type Message, usePinMessage } from "@agenteschat/client";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { can } from "@agenteschat/client/lib/permissions";
import { voiceOf } from "@agenteschat/client/lib/voice";
import { Button, EmojiPickerPopover, Menu } from "@agenteschat/ui";
import { chartBlocksOf, chartBlockToWidgetSpec } from "@agenteschat/ui/widgets/spec";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelActions } from "@/components/channel-actions";
import { MenuEntries } from "@/components/DesktopMenus";
import { useOrg } from "@/components/org-context";
import { PinToDashboard } from "@/components/widgets/PinToDashboard";
import {
  contextMenuHandler,
  copyText,
  type MenuEntry,
  QUICK_REACTIONS,
  selectedTextAt,
  tidy,
} from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { CorrectionDialog } from "./MessageFeedback";
import { DOWN, ReactButton, reactionOf, useEmojiLabels, useMessageReactions } from "./Reactions";
import { SaveToWikiDialog } from "./SaveToWiki";

/** A message's address (`messagePath`): its conversation, or a reply's thread, with `?m=` (it scrolls to it). */
export const messageLink = (
  origin: string,
  orgId: string,
  m: Pick<Message, "id" | "channelId"> & { threadId?: string | null },
) => `${origin}${messagePath(orgId, m)}`;

/** "…" on any message: the same list as its right click (`useMessageMenu`'s `more`). */
export function MessageMoreMenu({ entries }: { entries: MenuEntry[] }) {
  const { t } = useTranslation();
  if (!entries.length) return null;
  return (
    <Menu
      align="end"
      label={t("channel.more")}
      trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={t("channel.more")} />}
    >
      <MenuEntries entries={entries} />
    </Menu>
  );
}

/** "Responder" on the hover bar: the message's thread in the panel (a thread view: the composer). */
export function ReplyButton({ message }: { message: Message }) {
  const { t } = useTranslation();
  const actions = useChannelActions();
  if (!actions?.reply || message.local) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon="reply"
      aria-label={t("channel.reply")}
      title={t("channel.reply")}
      onClick={() => actions.reply?.(message)}
    />
  );
}

/** People's messages: the same glass bar as agents': Reagir, Responder and "…". */
export function PersonMessageActions({
  message,
  authorName,
  more,
}: {
  message: Message;
  authorName: string;
  more: MenuEntry[];
}) {
  const { t } = useTranslation();
  const reactions = useMessageReactions(message.id, message.reactions);
  return (
    <div className="ac-msg__actions" role="toolbar" aria-label={t("channel.actions", { name: authorName })}>
      <ReactButton onPick={(emoji) => reactions.toggle(reactionOf(emoji))} />
      <ReplyButton message={message} />
      <MessageMoreMenu entries={more} />
    </div>
  );
}

/**
 * A message's menu (lib/context-menu.ts), one list for its right click and its "…" (`more`): reactions with every
 * emoji, Responder, Copiar texto, Copiar link, Fixar mensagem, Salvar na wiki. With text selected in it, the
 * selection's own menu (Copiar, Responder; Salvar na wiki saves the selection). `touch` is the same menu for a tap on
 * touch, where it stands in for the bar, so an agent's reply (`feedback`) also has the bar's Não ajudou and Corrigir
 * resposta. `dialog` goes with the message. Fixar needs `post` (the server's rule) and a conversation that isn't
 * read only.
 */
export function useMessageMenu(
  message: Message,
  channelName: string,
  options: { feedback?: boolean; agentName?: string; readOnly?: boolean } = {},
) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useChannelActions();
  const reactions = useMessageReactions(message.id, message.reactions, { feedback: options.feedback });
  // What Salvar na wiki saves: the selection when it was asked, else the whole message.
  const [saving, setSaving] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [picking, setPicking] = useState(false);
  const labels = useEmojiLabels();
  const pin = usePinMessage(org.id);
  // An agent's chart can go on a board as a widget (ADR 0135): the first one the message has that reads as one.
  const chart = useMemo(
    () =>
      message.author.type === "agent" && message.author.id && !message.local && !options.readOnly
        ? (chartBlocksOf(message.body).find((b) => chartBlockToWidgetSpec(b) !== null) ?? null)
        : null,
    [message.author.type, message.author.id, message.local, message.body, options.readOnly],
  );
  const [pinningChart, setPinningChart] = useState(false);
  const entries = (selected: string, touch = false): MenuEntry[] => {
    if (message.local) return [];
    const copy = (text: string, id: string, label: string): MenuEntry => ({
      kind: "item",
      id,
      label,
      icon: "copy",
      run: () => void copyText(text, () => toast.show(t("contextMenu.textCopied"))),
    });
    const reply: MenuEntry[] = actions?.reply
      ? [
          {
            kind: "item",
            id: "reply",
            label: t("contextMenu.reply"),
            icon: "reply",
            run: () => actions.reply?.(message),
          },
        ]
      : [];
    const copyLink: MenuEntry = {
      kind: "item",
      id: "copy-link",
      label: t("messageRefs.copy"),
      icon: "link",
      run: () =>
        void copyText(messageLink(window.location.origin, org.id, message), () =>
          toast.show(t("contextMenu.linkCopied")),
        ),
    };
    const wiki = (text: string): MenuEntry => ({
      kind: "item",
      id: "wiki",
      label: t("contextMenu.saveToWiki"),
      icon: "book",
      run: () => setSaving(text),
    });
    if (selected) {
      return [copy(selected, "copy", t("contextMenu.copy")), ...reply, { kind: "separator" }, copyLink, wiki(selected)];
    }
    // A file with no words has no text to copy or save.
    const words = message.body.trim() !== "" && !voiceOf(message.meta);
    const pinned = Boolean(message.pinned);
    const pinEntry: MenuEntry | null =
      options.readOnly || !can(org, "post")
        ? null
        : {
            kind: "item",
            id: "pin",
            label: t(pinned ? "contextMenu.unpin" : "contextMenu.pin"),
            icon: "pin",
            run: () =>
              pin.mutate(
                { channelId: message.channelId, messageId: message.id, pinned: !pinned },
                { onSuccess: () => toast.show(t(pinned ? "contextMenu.unpinned" : "contextMenu.pinned")) },
              ),
          };
    return [
      {
        kind: "reactions",
        label: t("contextMenu.react"),
        emojis: QUICK_REACTIONS,
        pick: (emoji) => reactions.toggle(reactionOf(emoji)),
        more: { label: t("reactions.add"), run: () => setPicking(true) },
      },
      ...reply,
      ...(touch && options.feedback
        ? ([
            {
              kind: "item",
              id: "not-helpful",
              label: t("channel.notHelpful"),
              icon: "thumbDown",
              run: () => reactions.toggle(DOWN),
            },
            { kind: "item", id: "correct", label: t("channel.correct"), icon: "edit", run: () => setCorrecting(true) },
          ] satisfies MenuEntry[])
        : []),
      { kind: "separator" },
      ...(words ? [copy(message.body, "copy-text", t("contextMenu.copyText"))] : []),
      copyLink,
      { kind: "separator" },
      ...(pinEntry ? [pinEntry] : []),
      ...(chart
        ? ([
            {
              kind: "item",
              id: "pin-widget",
              label: t("widgets.pin.label"),
              icon: "grid",
              run: () => setPinningChart(true),
            },
          ] satisfies MenuEntry[])
        : []),
      ...(words ? [wiki(message.body)] : []),
    ];
  };
  const onContextMenu = contextMenuHandler((e) => entries(selectedTextAt(e.target)));
  const touch = tidy(entries("", true));
  const more = tidy(entries(""));
  const dialog = (
    <>
      {saving !== null && (
        <SaveToWikiDialog
          open
          onClose={() => setSaving(null)}
          text={saving}
          source={{ kind: "message", channelId: message.channelId, messageId: message.id }}
          from={t("wiki.fromMessage", { channel: channelName })}
        />
      )}
      {pinningChart && chart && message.author.id && (
        <PinToDashboard
          orgId={org.id}
          messageId={message.id}
          agentId={message.author.id}
          block={chart}
          onClose={() => setPinningChart(false)}
        />
      )}
      {correcting && (
        <CorrectionDialog
          open
          onOpenChange={setCorrecting}
          messageId={message.id}
          agentName={options.agentName ?? ""}
        />
      )}
      {picking && (
        <EmojiPickerPopover
          open
          onOpenChange={setPicking}
          labels={labels}
          onPick={(emoji) => reactions.toggle(reactionOf(emoji))}
          side="bottom"
          align="end"
          // The whole row's box (`.ac-msg` is positioned): the picker opens beside the row, as its menu did.
          trigger={<span aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />}
        />
      )}
    </>
  );
  return { onContextMenu, touch, more, dialog };
}
