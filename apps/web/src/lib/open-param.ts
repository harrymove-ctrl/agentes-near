import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

/**
 * The item a list page has open in its details dialog, kept in the URL
 * (`?open=…`) so a reload, a shared link or Back reopens it. Replaces the
 * history entry: opening and closing details isn't a page of its own.
 * Numbers (an issue's) go as numbers, so the URL reads `?open=6`.
 * `aliases`: older names the route reads as this one; they go with it.
 */
export function useOpenParam(
  name = "open",
  aliases: readonly string[] = [],
): [string | null, (value: string | number | null) => void] {
  const value = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown>)[name];
      return v === undefined || v === null || v === "" ? null : String(v);
    },
  });
  const navigate = useNavigate();
  const set = useCallback(
    (next: string | number | null) =>
      void navigate({
        to: ".",
        replace: true,
        search: ((prev: Record<string, unknown>) => {
          const out = { ...prev };
          for (const alias of aliases) delete out[alias];
          if (next === null) delete out[name];
          else out[name] = next;
          return out;
        }) as never,
      }),
    [navigate, name, aliases],
  );
  return [value, set];
}

/**
 * `validateSearch` for a page with an open item. A number (an issue's) stays a
 * number: the router JSON-quotes a string that reads as one (`?open=%22131%22`),
 * so a digits-only string becomes a number too. Anything else stays a string.
 */
export function openSearch(search: Record<string, unknown>): { open?: string | number } {
  const v = search.open;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? { open: v } : {};
  if (typeof v !== "string" || !v) return {};
  return /^\d{1,15}$/.test(v) ? { open: Number(v) } : { open: v };
}

/** `validateSearch` for the tasks' pages: the open task, and `m`, a message of its conversation to open at. */
export function taskSearch(search: Record<string, unknown>): { open?: string | number; m?: string } {
  const m = typeof search.m === "string" && search.m ? { m: search.m } : {};
  return { ...openSearch(search), ...m };
}

/** The thread open in the panel beside a conversation: `reply` puts the focus in its composer, `focus` opens at a message. */
export interface ThreadPanel {
  id: string;
  reply: boolean;
  focus?: string;
}

/** `validateSearch` for a conversation: the thread in its panel, its `reply` and `tm` (the panel's own `?m=`). */
export function threadSearch(search: Record<string, unknown>): { thread?: string; reply?: true; tm?: string } {
  if (typeof search.thread !== "string" || !search.thread) return {};
  return {
    thread: search.thread,
    ...(search.reply === true || search.reply === "true" ? { reply: true as const } : {}),
    ...(typeof search.tm === "string" && search.tm ? { tm: search.tm } : {}),
  };
}

/**
 * The thread in a conversation's panel, kept in the URL (`?thread=…`) so a reload, a shared link and Back and Forward
 * keep it. Unlike `useOpenParam` each change is a history entry, so Back closes what was just opened; `replace` is for
 * a thread found gone, which leaves nothing to come back to. `enabled` false (a thread view, which holds no panel of
 * its own but shares the URL with the conversation beside it): always empty.
 */
export function useThreadPanel(
  enabled: boolean,
): [ThreadPanel | null, (next: ThreadPanel | null, how?: { replace?: boolean }) => void] {
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const router = useRouter();
  const navigate = useNavigate();
  const panel = useMemo<ThreadPanel | null>(() => {
    const { thread, reply, tm } = threadSearch(search);
    return enabled && thread ? { id: thread, reply: Boolean(reply), ...(tm ? { focus: tm } : {}) } : null;
  }, [enabled, search]);
  const set = useCallback(
    (next: ThreadPanel | null, how?: { replace?: boolean }) => {
      if (!enabled) return;
      if (!next && !threadSearch(router.state.location.search as Record<string, unknown>).thread) return;
      void navigate({
        to: ".",
        replace: how?.replace,
        search: ((prev: Record<string, unknown>) => {
          const { thread: _thread, reply: _reply, tm: _tm, ...rest } = prev;
          if (!next) return rest;
          return {
            ...rest,
            thread: next.id,
            ...(next.reply ? { reply: true } : {}),
            ...(next.focus ? { tm: next.focus } : {}),
          };
        }) as never,
      });
    },
    [enabled, navigate, router],
  );
  return [panel, set];
}
