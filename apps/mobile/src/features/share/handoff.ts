import { useSyncExternalStore } from "react";
import type { SharedFile } from "./inbox";

/**
 * What the share sheet hands to the conversation it opens: the files and the words, sent there at once through the
 * conversation's own sending (uploads, the message, the agent's "pensando…"), so a shared photo goes exactly as one
 * picked in the chat. One at a time; the conversation it is for takes it once.
 */
export interface ShareHandoff {
  channelId: string;
  files: SharedFile[];
  text: string;
  at: number;
}

let pending: ShareHandoff | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export function handShare(handoff: Omit<ShareHandoff, "at">): void {
  pending = { ...handoff, at: Date.now() };
  changed();
}

/** The conversation sent it: nobody sends it again. */
export function takeShareHandoff(at: number): void {
  if (pending?.at !== at) return;
  pending = null;
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The handoff waiting for this conversation, if any. */
export const useShareHandoff = (channelId: string): ShareHandoff | null =>
  useSyncExternalStore(subscribe, () => (pending?.channelId === channelId ? pending : null));
