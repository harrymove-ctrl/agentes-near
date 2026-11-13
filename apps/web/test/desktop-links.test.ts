import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { routeNewWindowLinks } from "@/lib/desktop";

/**
 * A link that opens a new window, in the desktop app: the site sends it to `window.open` (the window's
 * `on_new_window` takes it from there, main_window.rs) before the shell plugin's listener on `body` can take it
 * and ask the app over IPC, which the site may not do.
 */

let root: HTMLElement;
let opened: string[];
let pluginSaw: string[];
let stop: () => void;
let realOpen: typeof window.open;
const plugin = (e: Event) => {
  const link = (e.target as Element).closest("a");
  if (link) pluginSaw.push(link.href);
  e.preventDefault();
};

beforeEach(() => {
  realOpen = window.open;
  opened = [];
  pluginSaw = [];
  window.open = ((url?: string | URL) => {
    opened.push(String(url));
    return null;
  }) as typeof window.open;
  root = document.createElement("div");
  document.body.append(root);
  stop = routeNewWindowLinks(root);
  document.body.addEventListener("click", plugin);
});

afterEach(() => {
  stop();
  document.body.removeEventListener("click", plugin);
  root.remove();
  window.open = realOpen;
});

function link(href: string, target?: string) {
  const a = document.createElement("a");
  a.href = href;
  if (target) a.target = target;
  a.textContent = "link";
  root.append(a);
  return a;
}

const click = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(e);
  return e;
};

describe("links that open a new window in the app", () => {
  test("go to window.open, and the plugin never sees them", () => {
    const e = click(link("https://example.com/", "_blank"));
    expect(opened).toEqual(["https://example.com/"]);
    expect(e.defaultPrevented).toBe(true);
    expect(pluginSaw).toEqual([]);
  });

  test("the words inside a link count as the link", () => {
    const a = link("mailto:dev@example.com", "_blank");
    const word = document.createElement("span");
    a.replaceChildren(word);
    const e = click(word);
    expect(e.defaultPrevented).toBe(true);
    // happy-dom runs the link's own default action at the link, while the click still bubbles up to the root, so
    // it opens there too. A browser runs it after the dispatch, where the root's preventDefault stops it.
    expect(opened).toContain("mailto:dev@example.com");
  });

  test("a click the page already handled (a popup) is left alone", () => {
    const a = link("https://example.com/sign-in", "_blank");
    a.addEventListener("click", (e) => e.preventDefault());
    click(a);
    expect(opened).toEqual([]);
  });

  test("links that stay in the window, other buttons and other schemes are left alone", () => {
    click(link("https://example.com/page"));
    click(link("https://example.com/", "_blank"), { button: 1 });
    click(link("blob:https://example.com/1234", "_blank"));
    expect(opened).toEqual([]);
  });

  test("stops when the page goes", () => {
    stop();
    click(link("https://example.com/", "_blank"));
    expect(opened).toEqual([]);
    expect(pluginSaw).toEqual(["https://example.com/"]);
  });
});
