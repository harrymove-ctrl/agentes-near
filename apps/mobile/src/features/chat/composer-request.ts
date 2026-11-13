import { useSyncExternalStore } from "react";

/**
 * Text another screen hands to a conversation's composer: "Falar com o Theo" in two agents' conversation goes
 * back to the conversation that asked with "@theo " in its field; empty text only focuses the field (an agent tapped in
 * "New" opens your conversation ready to type). One at a time; the conversation's screen in view takes it once
 * (`takeComposerRequest`), so the one the person went back to gets it.
 */
export interface ComposerRequest {
  channelId: string;
  text: string;
  /** When it was asked: tells two requests with the same text apart. */
  at: number;
}

let pending: ComposerRequest | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export function requestComposerText(channelId: string, text: string): void {
  pending = { channelId, text, at: Date.now() };
  changed();
}

/** The composer put it in its field: no other screen takes it again. */
export function takeComposerRequest(at: number): void {
  if (pending?.at !== at) return;
  pending = null;
  changed();
}

/** The request waiting, for any conversation. */
export const currentComposerRequest = (): ComposerRequest | null => pending;

/** The request waiting for this conversation, if any. */
export const composerRequestFor = (request: ComposerRequest | null, channelId: string): ComposerRequest | null =>
  request?.channelId === channelId ? request : null;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useComposerRequest = (channelId: string): ComposerRequest | null =>
  useSyncExternalStore(subscribe, () => composerRequestFor(currentComposerRequest(), channelId));
