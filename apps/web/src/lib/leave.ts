/** The ghost of a panel that just closed, while it plays its exit; a panel opening in the same commit takes it away. */
let leaving: (() => void) | null = null;

/**
 * Plays an element's exit after React removed it: a lifeless copy (inert, no handlers) takes its place in `<body>` with
 * `data-leaving`, keeping where its lists were scrolled, until the exit ends. Its CSS decides the exit: no
 * `[data-leaving]` animation (reduced motion, a test's DOM with no styles) and the copy goes at once. Call it from a
 * layout effect's cleanup, while the element is still in the page.
 */
export function leaveAnimated(nodes: (Element | null | undefined)[]) {
  const live = nodes.filter((n): n is HTMLElement => n instanceof HTMLElement && n.isConnected);
  if (live.length === 0) return;
  const copies = live.map((node) => {
    const scrolled: [number, number][] = [];
    node.querySelectorAll("*").forEach((el, i) => {
      if (el.scrollTop > 0) scrolled.push([i, el.scrollTop]);
    });
    const copy = node.cloneNode(true) as HTMLElement;
    copy.inert = true;
    copy.removeAttribute("id");
    copy.setAttribute("aria-hidden", "true");
    copy.dataset.leaving = "";
    for (const el of copy.querySelectorAll("[data-dirty], [id]")) {
      el.removeAttribute("id");
      el.removeAttribute("data-dirty");
    }
    document.body.append(copy);
    const inside = copy.querySelectorAll("*");
    for (const [i, top] of scrolled) inside[i]?.scrollTo({ top });
    return copy;
  });
  const moving = copies.filter((c) => {
    const name = getComputedStyle(c).animationName;
    return name && name !== "none";
  });
  const done = () => {
    for (const c of copies) c.remove();
    if (leaving === done) leaving = null;
  };
  if (moving.length === 0) return done();
  leaving = done;
  // The longest exit is --dur-base (180ms); a hidden copy (a phone's scrim) never fires animationend.
  setTimeout(done, 400);
  queueMicrotask(() => {
    if (leaving === done) leaving = null;
  });
}

/** A panel opening in the same commit another closed: the ghost goes and the new one skips its entrance. */
export function takeOverLeaving(): boolean {
  if (!leaving) return false;
  leaving();
  return true;
}
