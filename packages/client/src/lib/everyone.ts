import { everyoneWord, isEveryoneWord } from "@agenteschat/i18n/everyone";
import { mentionsHandle } from "./markdown";
import { can } from "./permissions";

export { everyoneWord, isEveryoneWord };

/**
 * Whether the "@" list offers the mention of everyone (`@todos`), the server's rule (`insertMessageWithRuns`): the
 * person may `mention_everyone`, anywhere but a DM. The server checks it.
 */
export const offersEveryone = (org: { permissions?: readonly string[] } | null | undefined, dm: boolean) =>
  !dm && can(org, "mention_everyone");

/** The reader's word when what follows "@" starts it ("" too), else null: the list's first entry. */
export function everyoneSuggestion(query: string, locale: string): string | null {
  const word = everyoneWord(locale);
  return word.startsWith(query.toLowerCase()) ? word : null;
}

/** Whether `@handle` in a message is its mention of everyone (a word of any language, with `meta.mentionsEveryone`). */
export const isEveryoneMention = (meta: Record<string, unknown> | null | undefined, handle: string) =>
  meta?.mentionsEveryone === true && isEveryoneWord(handle);

/** Whether a message is a mention of its reader: their `@handle`, or a mention of everyone. */
export const mentionsReader = (
  message: { body: string; meta?: Record<string, unknown> | null },
  handle?: string | null,
) => message.meta?.mentionsEveryone === true || (!!handle && mentionsHandle(message.body, handle));
