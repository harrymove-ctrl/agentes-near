/**
 * The page column starts at the top on a new path. Without this the router hands the column's scroll on to the
 * next page: it carries over every scrolled element it isn't told to reset, keyed by the element's place in the DOM,
 * and every page's `main` sits in the same place. A change of search alone (`?open=`, a dialog over a list) keeps
 * the scroll, and Back and Forward still put a page back where it was. Where a page's columns scroll on their own
 * (`.page-split`), its last one, what the list or nav opened, starts at the top too: another settings section. Each
 * such column carries a `data-scroll-restoration-id`, so the router keys its scroll by that name and never hands it to
 * another page's scroller that happens to sit at the same place in the DOM.
 * `selectors` goes to the router's `scrollToTopSelectors`, `track` to its `onBeforeLoad` event.
 */
export function pageScrollReset() {
  let pathChanged = true;
  return {
    selectors: [
      () => (pathChanged ? document.querySelector("main.shell__main") : null),
      () => (pathChanged ? document.querySelector("main.shell__main .page-split > :last-child") : null),
    ],
    track: (e: { pathChanged: boolean }) => {
      pathChanged = e.pathChanged;
    },
  };
}
