/**
 * Text waiting to be put in a conversation's composer (⌘K "Pedir a um
 * agente" opens the DM with it). Read with `peekDraft` (render-safe), then
 * `clearDraft` once used.
 */
const drafts = new Map<string, string>();

export const setDraftFor = (key: string, text: string) => {
  drafts.set(key, text);
};
export const peekDraft = (key: string) => drafts.get(key);
export const clearDraft = (key: string) => {
  drafts.delete(key);
};
