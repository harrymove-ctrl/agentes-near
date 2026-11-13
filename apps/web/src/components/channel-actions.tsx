import type { Agent, Message as MessageType } from "@agenteschat/client";
import { Menu, MenuItem } from "@agenteschat/ui";
import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";

/** What rows deeper in the timeline can do with the composer ("Chamar um agente", retry). */
export interface ChannelActions {
  insertMention: (handle: string) => void;
  retry: (local: MessageType) => void;
  resend: (body: string) => void;
  /** "Responder" on an agent's question: type the answer in the composer. */
  focusComposer: () => void;
  /** A suggestion picked above the conversation (a first task): the composer gets its text, unsent. */
  fillComposer?: (text: string) => void;
  /** A streaming reply grew: stay at the bottom if the person is there. */
  followBottom?: () => void;
  channelAgents: Agent[];
  /**
   * "Responder": in a channel, that message's thread opens in the panel beside it (a reply there
   * starts the thread); in a thread view, the next message answers this one ("Respondendo a Ana"). Absent where
   * nothing can be written.
   */
  reply?: (message: MessageType) => void;
  /**
   * A thread's line or link: the panel beside the channel (absent in a thread view: links go to its page). With
   * `focusMessageId`, it opens at that message (a pin).
   */
  openThread?: (threadId: string, focusMessageId?: string) => void;
  /**
   * A question an agent asked another from here ("Theo ⇄ Iris" in the reply's block): what the two said for it, in
   * the panel beside the channel, read only (absent in a thread view: the block opens it in place).
   */
  openConsultation?: (consultationId: string) => void;
  /** "Pedir correção" after my 👎: my reply in the same conversation, quoting that message and mentioning its agent. */
  requestCorrection?: (message: MessageType, text: string) => void;
  /** A quote was clicked: scroll to the original and highlight it (paging back if needed). */
  jumpTo?: (messageId: string) => void;
  /** "Mudar algo" on a mission's plan: the next message goes to its executor ("Respondendo: Plano"). */
  replyToMission?: (missionId: string, label: string) => void;
}
export const ChannelActionsContext = createContext<ChannelActions | null>(null);
export const useChannelActions = () => useContext(ChannelActionsContext);

const inlineButton = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  color: "inherit",
};

/** "Chamar um agente": inserts `@handle` into the composer. */
export function CallAgentMenu() {
  const { t } = useTranslation();
  const actions = useChannelActions();
  if (!actions || actions.channelAgents.length === 0) return null;
  return (
    <Menu
      label={t("channel.callAgentMenu")}
      trigger={
        <button type="button" className="ac-link ac-link--muted" style={inlineButton}>
          {t("channel.callAgent")}
        </button>
      }
    >
      {actions.channelAgents.map((a) => (
        <MenuItem
          key={a.id}
          leading={<AgentAvatar agentId={a.id} size="sm" name={a.name} />}
          description={`@${a.handle}`}
          onSelect={() => actions.insertMention(a.handle)}
        >
          {a.name}
        </MenuItem>
      ))}
    </Menu>
  );
}
