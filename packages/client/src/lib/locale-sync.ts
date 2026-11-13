import { type AppLocale, isAppLocale } from "@agenteschat/i18n/locale";
import { useEffect, useRef } from "react";

/** What a device keeps: the language it shows (or "auto", this device's own) and whether the server has yet to hear it. */
export interface LocaleState {
  stored: AppLocale | "auto" | null;
  /** Picked on this device while signed out (the sign-in page's picker): the next sign-in sends it. */
  pending: boolean;
}

/**
 * Once signed in, the language every device of the person shows (ADR 0122):
 * 1. A pick on this device the server hasn't heard (`pending`) wins and is sent, "auto" included.
 * 2. A language kept on this device while the server has none picked (`localeAuto` not false) is the person's pick
 *    too: one made before the server kept picks, or one whose send failed. It wins and is sent.
 * 3. Else a language the person picked anywhere (`localeAuto` false) wins.
 * 4. Else each device follows its own (`detected`), and the server keeps the last one detected for emails and pushes.
 */
export function localeSync(input: {
  state: LocaleState;
  detected: AppLocale;
  server: { locale?: string | null; localeAuto?: boolean };
}): { use: AppLocale; store: AppLocale | "auto"; patch?: { locale: AppLocale; auto: boolean } } {
  const { state, detected, server } = input;
  const own = state.stored && state.stored !== "auto" ? state.stored : null;
  const picked = server.localeAuto === false && isAppLocale(server.locale) ? server.locale : null;
  if (own && (state.pending || !picked)) return { use: own, store: own, patch: { locale: own, auto: false } };
  if (picked && !state.pending) return { use: picked, store: picked };
  return {
    use: detected,
    store: "auto",
    ...(server.locale !== detected || server.localeAuto === false ? { patch: { locale: detected, auto: true } } : {}),
  };
}

/** Runs `localeSync` once per signed-in person, when their `/me` arrives. */
export function useLocaleSync(opts: {
  user: { id: string; locale?: string | null; localeAuto?: boolean } | null | undefined;
  read: () => LocaleState;
  detected: () => AppLocale;
  apply: (code: AppLocale, store: AppLocale | "auto") => void;
  send: (patch: { locale: AppLocale; auto: boolean }) => Promise<unknown>;
}) {
  const done = useRef<string | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const { user } = opts;
  useEffect(() => {
    if (!user || done.current === user.id) return;
    done.current = user.id;
    const { read, detected, apply, send } = latest.current;
    const next = localeSync({ state: read(), detected: detected(), server: user });
    apply(next.use, next.store);
    // Not sent: the next sign-in tries again (emails stay in the last language the server heard).
    if (next.patch) send(next.patch).catch(() => {});
  }, [user]);
}
