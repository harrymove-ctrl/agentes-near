/**
 * Message permalinks in chat (web and phone): "Copiar link da mensagem" copies one (`messagePath`), and one pasted
 * in a message (`parseMessageLink`, only this server's) shows as a pill like Discord's, "# general › 💬", whose
 * place and author the server gives only to who may see the message (`useMessageCard`).
 */

import type { TFunction } from "i18next";
import type { MessageCard } from "../api/types";

export {
  type FileLink,
  filePath,
  type MessageLink,
  messagePath,
  parseFileLink,
  parseMessageLink,
} from "@agenteschat/tokens/message-links";

/** The pill's accessible name: "Mensagem de Bia em #general", "…na DM com Ana"; null card: no access. */
export function messageRefLabel(t: TFunction, card: MessageCard | null | undefined): string {
  if (!card) return t("messageRefs.noAccess");
  const words = { author: card.author, name: card.name };
  if (card.kind === "dm") return t("messageRefs.dmLabel", words);
  return card.threadId ? t("messageRefs.threadLabel", words) : t("messageRefs.label", words);
}
