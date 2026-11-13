/** A link's secret: letters, digits, `-` and `_` (packages/client `parseConnectLink` takes the same). */
const SECRET = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * A secret a link carries in its fragment (`/owner#claim=…`, `/desktop/handover#token=…`): browsers never send
 * the fragment to a server, so it stays out of request logs. Read once, then taken out of the address bar and
 * the history; null when there is none, or it isn't one.
 */
export function takeFragmentParam(name: string): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get(name);
  if (value !== null) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  return value && SECRET.test(value) ? value : null;
}
