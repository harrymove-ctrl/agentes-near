/**
 * `bun test --preload ./scripts/geometry/capture.ts <paths>` with GEOMETRY_OUT set: while the tests run, saves every
 * distinct screen they reach as HTML, for `check.ts` to lay out in Chromium. Two screens are the same when their tags
 * and classes are, whatever their words, in the same language (the page's `lang`).
 */
import { beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const shapeOf = (html: string) => html.replace(/>[^<]+</g, "><").replace(/\s(?!class=)[\w:-]+="[^"]*"/g, "");

const OUT = process.env.GEOMETRY_OUT;

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  const seen = new Set<string>();

  const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  const screenName = () => {
    const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
    const dialog = dialogs[dialogs.length - 1];
    if (dialog)
      return `dialog: ${text(dialog.querySelector("h1,h2,.ac-dialog__title")) || dialog.getAttribute("aria-label") || "untitled"}`;
    return text(document.querySelector("h1")) || text(document.querySelector(".ac-page-header__title")) || "component";
  };

  const snapshot = () => {
    try {
      const html = document.body?.innerHTML;
      if (!html || html.length < 200) return;
      // A screen in another language is another screen: its longer words are what the check measures there.
      const id = Bun.hash(document.documentElement.lang + shapeOf(html)).toString(36);
      if (seen.has(id)) return;
      seen.add(id);
      const file = `${OUT}/${id}.html`;
      if (existsSync(file)) return;
      const body = html.replace(/<script[\s\S]*?<\/script>/g, "");
      writeFileSync(file, `<!--${JSON.stringify({ screen: screenName() })}-->\n${body}`);
    } catch {
      // A screen that can't be read is one state fewer, never a failed test.
    }
  };

  // A change that only rewrites words (another language) moves no element: a test saves that screen itself.
  (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot = snapshot;

  // The state a test ends on is the one it asserted: taken as its root unmounts, whatever the time since the last one.
  const client = createRequire(new URL("../../packages/ui/package.json", import.meta.url))("react-dom/client");
  const createRoot = client.createRoot;
  client.createRoot = (...args: unknown[]) => {
    const root = createRoot(...args);
    const unmount = root.unmount.bind(root);
    root.unmount = () => {
      snapshot();
      unmount();
    };
    return root;
  };

  let watched: Element | null = null;
  beforeEach(() => {
    if (typeof document === "undefined" || !document.body || watched === document.body) return;
    watched = document.body;
    new MutationObserver(snapshot).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "data-state"],
    });
  });
}
