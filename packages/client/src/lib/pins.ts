import type { TFunction } from "i18next";
import type { MessagePin } from "../api/types";
import { previewOf } from "./consultations";
import { textOrMedia } from "./media";

/** A pin's one-line preview: its text, or what it carries (a photo, a file). */
export const pinPreview = (t: TFunction, p: MessagePin) => previewOf(textOrMedia(t, p.message.body, p.message.meta));

/**
 * The pins a conversation's pinned bar shows: in a thread, its root and its replies; in the main timeline, all of the
 * channel's (a thread's opens its thread). Keeps the given order (the server's: the latest pin first).
 */
export function pinsIn(pins: readonly MessagePin[], threadId?: string | null): MessagePin[] {
  if (!threadId) return [...pins];
  return pins.filter((p) => p.threadId === threadId || p.messageId === threadId);
}
