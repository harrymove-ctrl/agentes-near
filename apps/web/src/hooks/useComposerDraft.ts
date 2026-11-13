import { type ComposerDraft, readDraftBook, withDraft } from "@agenteschat/client/lib/composer-drafts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthClient } from "@/auth/client";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/** How long typing settles before the text is written down (the last change is also written when leaving). */
const SAVE_DELAY_MS = 400;

const bookKey = (userId: string) => `${STORAGE_KEYS.composerDrafts}.${userId}`;

/** The text this person left unsent in a conversation, from this browser's storage. */
export function readComposerDraft(userId: string, key: string): ComposerDraft | undefined {
  return readDraftBook(storage.get(bookKey(userId)), Date.now())[key];
}

/** Writes (or, blank, removes) one entry of this person's book of unsent texts. */
export function writeComposerDraft(userId: string, key: string, text: string) {
  const name = bookKey(userId);
  const next = withDraft(readDraftBook(storage.get(name), Date.now()), key, text, Date.now());
  if (Object.keys(next).length === 0) storage.remove(name);
  else storage.set(name, JSON.stringify(next));
}

/** Every person's unsent texts in this browser, forgotten on sign-out. */
export function forgetComposerDrafts() {
  try {
    const prefix = `${STORAGE_KEYS.composerDrafts}.`;
    for (const name of Object.keys(localStorage)) if (name.startsWith(prefix)) storage.remove(name);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

/** Signing out forgets every unsent text in this browser too (it may be someone else's next). */
export function withComposerDraftsSignOut(auth: AuthClient): AuthClient {
  return {
    ...auth,
    signOut: async () => {
      forgetComposerDrafts();
      await auth.signOut();
    },
  };
}

/**
 * A composer's text that survives switching conversations and reloading: it starts from `handed` (text another
 * screen gave it, like ⌘K "Pedir a um agente") or what was left unsent here, and every change is written down
 * shortly after typing settles, at once when the conversation closes or the page goes away. Sending clears it the
 * same way, with the text set to "".
 */
export function useComposerDraft(userId: string, key: string, handed?: string) {
  const [text, setText] = useState(() => handed ?? readComposerDraft(userId, key)?.text ?? "");
  const pending = useRef<string | null>(handed ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current === null) return;
    writeComposerDraft(userId, key, pending.current);
    pending.current = null;
  }, [userId, key]);

  const set = useCallback(
    (next: string | ((old: string) => string)) => {
      setText((old) => {
        const value = typeof next === "function" ? next(old) : next;
        pending.current = value;
        return value;
      });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  // Handed text replaces what was left here: written down at once, like any change.
  useEffect(() => {
    if (pending.current !== null) flush();
  }, [flush]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return [text, set] as const;
}
