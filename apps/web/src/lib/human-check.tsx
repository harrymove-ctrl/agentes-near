import { useAuthConfig } from "@agenteschat/client";
import { createHumanCheck, type HumanAction, type HumanCheck } from "@agenteschat/client/lib/human-check";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Turnstile's browser API, once its script has loaded. */
interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string | null | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/** Loaded from Cloudflare itself, never bundled or proxied: Cloudflare updates it in place. */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Turnstile's `flexible` widget is at least this wide: a narrower place takes the `compact` one. */
const FLEXIBLE_MIN_PX = 300;

let loading: Promise<Turnstile> | null = null;
/** Added once, by the first page that checks: pages that guard nothing never reach Cloudflare. */
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("no turnstile")));
    script.onerror = () => {
      script.remove();
      reject(new Error("Turnstile didn't load"));
    };
    document.head.append(script);
  }).finally(() => {
    loading = null;
  });
  return loading;
}

/**
 * The bot check of a public form (ADR 0075), when the server has a site key: Cloudflare Turnstile, Managed and
 * shown only when Cloudflare doubts someone (`interaction-only`). `slot` goes where its checkbox would show,
 * between the form's fields and its button. `check` is null without a site key or an `action`, and then nothing
 * loads from Cloudflare.
 */
export function useHumanCheck(action: HumanAction | null): { check: HumanCheck | null; slot: ReactNode } {
  const siteKey = useAuthConfig().data?.turnstileSiteKey ?? null;
  const { i18n } = useTranslation();
  const on = siteKey !== null && action !== null;
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const tokens = useMemo(() => (on ? createHumanCheck() : null), [on]);
  const widget = useRef<{ turnstile: Turnstile; id: string } | null>(null);
  const failed = useRef(false);

  useEffect(() => {
    if (!tokens || !slot || !siteKey || !action) return;
    let gone = false;
    failed.current = false;
    loadTurnstile()
      .then((turnstile) => {
        if (gone) return;
        const width = slot.parentElement?.clientWidth ?? 0;
        const theme = slot.closest("[data-theme]")?.getAttribute("data-theme");
        const id = turnstile.render(slot, {
          sitekey: siteKey,
          action,
          appearance: "interaction-only",
          size: width > 0 && width < FLEXIBLE_MIN_PX ? "compact" : "flexible",
          theme: theme === "dark" || theme === "light" ? theme : "auto",
          language: i18n.language.toLowerCase(),
          "refresh-expired": "auto",
          "response-field": false,
          callback: (token: string) => !gone && tokens.give(token),
          "expired-callback": () => !gone && tokens.expire(),
          "error-callback": (code: string) => {
            if (!gone) tokens.fail(code);
            return true;
          },
          // The checkbox's moment: room of its own, and a call waits for the person's click.
          "before-interactive-callback": () => {
            Object.assign(slot.style, { display: "block", marginBlock: "8px" });
            tokens.hold();
          },
          "after-interactive-callback": () => Object.assign(slot.style, { display: "contents", marginBlock: "" }),
        });
        if (id) widget.current = { turnstile, id };
      })
      // The script didn't load, or Turnstile refused the widget's options.
      .catch(() => {
        if (gone) return;
        failed.current = true;
        tokens.fail();
      });
    return () => {
      gone = true;
      if (widget.current) widget.current.turnstile.remove(widget.current.id);
      widget.current = null;
      // A call still waiting on this widget goes on rather than spinning forever.
      tokens.fail();
      tokens.reset();
    };
  }, [tokens, slot, siteKey, action, i18n.language]);

  const check = useMemo<HumanCheck | null>(
    () =>
      tokens && {
        token: () => tokens.token(),
        reset: () => {
          tokens.reset();
          if (failed.current) tokens.fail();
          else if (widget.current) widget.current.turnstile.reset(widget.current.id);
        },
      },
    [tokens],
  );
  // Idle, Turnstile's widget is hidden: the slot makes no box, so the form's spacing stays as it is.
  return { check, slot: on ? <div ref={setSlot} className="human-check" style={{ display: "contents" }} /> : null };
}
