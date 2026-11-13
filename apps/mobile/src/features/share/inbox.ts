import type { ShareIntent } from "expo-share-intent";
import { useSyncExternalStore } from "react";

/** A file another app shared, as the chat's attachment strip takes it (`{ uri, name, type }`). */
export interface SharedFile {
  uri: string;
  name: string;
  type: string;
}

/** What arrived from the system's share sheet: files (photos, videos, documents) and/or text (a link, a quote). */
export interface Shared {
  files: SharedFile[];
  text: string | null;
  /** When it arrived: tells two shares of the same thing apart. */
  at: number;
}

/** The screen that takes what other apps share ("Compartilhar com…"). */
export const SHARE_ROUTE = "/share-to";

/** The most one message carries, as the conversation's own attachment strip (`MAX_PENDING`). */
export const SHARE_MAX_FILES = 10;

/**
 * The share intent (`expo-share-intent`) in the app's terms. A file without a path is skipped; a missing name or type
 * gets one from its kind, as a picked photo does. The text is the shared text, or the link alone when only a link
 * came; a link already inside the text isn't repeated.
 */
export function sharedFromIntent(intent: ShareIntent, at = Date.now()): Shared | null {
  const files: SharedFile[] = [];
  for (const f of intent.files ?? []) {
    if (!f?.path) continue;
    const type = f.mimeType || "application/octet-stream";
    const fallback = type.startsWith("image/") ? "photo.jpg" : type.startsWith("video/") ? "video.mp4" : "file";
    // iOS may hand a bare path (the photo library's own file): uploads need the file URL.
    const uri = f.path.startsWith("/") ? `file://${f.path}` : f.path;
    files.push({ uri, name: f.fileName || fallback, type });
  }
  const text = intent.text?.trim() || null;
  const url = intent.webUrl?.trim() || null;
  const words = text && url && !text.includes(url) ? `${text}\n${url}` : (text ?? url);
  if (files.length === 0 && !words) return null;
  return { files, text: words, at };
}

/** The words that go: the person's own line first, then what was shared as text. */
export function shareMessage(line: string, shared: Shared): string {
  return [line.trim(), shared.text ?? ""].filter(Boolean).join("\n\n");
}

// One share at a time: a new one replaces what wasn't sent (the system's sheet opens the app again for it).
let current: Shared | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export function receiveShare(shared: Shared): void {
  current = shared;
  changed();
}

export function clearShare(): void {
  if (!current) return;
  current = null;
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useShared = (): Shared | null => useSyncExternalStore(subscribe, () => current);
