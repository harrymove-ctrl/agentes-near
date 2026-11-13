import { domWindow } from "@agenteschat/ui/testing/dom";

const SCRIPT = 'script[src^="https://challenges.cloudflare.com/"]';

type Widget = { id: string; options: Record<string, unknown>; removed: boolean; given: number };

/**
 * Cloudflare's Turnstile for page tests, with no network: its script "loads" once a page adds it, and each widget
 * hands out `<id>-1`, `<id>-2`… when rendered and after each reset. `installTurnstile({ loads: false })`: the script
 * fails to load, as when a blocker stops it. `{ gives: false }`: widgets hand out nothing until `give` (a slow
 * widget, or one waiting for a click).
 */
export function installTurnstile({ loads = true, gives = true } = {}) {
  const widgets: Widget[] = [];
  const resets: string[] = [];
  const give = (id: string) =>
    queueMicrotask(() => {
      const w = widgets.find((x) => x.id === id);
      if (w && !w.removed) (w.options.callback as (token: string) => void)(`${w.id}-${++w.given}`);
    });
  const turnstile = {
    render(_el: HTMLElement, options: Record<string, unknown>) {
      const w = { id: `w${widgets.length + 1}`, options, removed: false, given: 0 };
      widgets.push(w);
      if (gives) give(w.id);
      return w.id;
    },
    reset(id: string) {
      resets.push(id);
      if (gives) give(id);
    },
    remove(id: string) {
      const w = widgets.find((x) => x.id === id);
      if (w) w.removed = true;
    },
  };
  domWindow().happyDOM.settings.handleDisabledFileLoadingAsSuccess = loads;
  // The script defines it as it loads: a page sees it only once it added the script.
  const loaded = (event: Event) => {
    if ((event.target as HTMLScriptElement | null)?.src?.startsWith("https://challenges.cloudflare.com/")) {
      Object.assign(window, { turnstile });
    }
  };
  document.addEventListener("load", loaded, true);
  cleanups.push(() => document.removeEventListener("load", loaded, true));
  return { turnstile, widgets, resets, give, scripts: () => [...document.querySelectorAll(SCRIPT)] };
}

const cleanups: (() => void)[] = [];

export function removeTurnstile() {
  for (const cleanup of cleanups.splice(0)) cleanup();
  domWindow().happyDOM.settings.handleDisabledFileLoadingAsSuccess = false;
  delete (window as { turnstile?: unknown }).turnstile;
  for (const script of document.querySelectorAll(SCRIPT)) script.remove();
}
