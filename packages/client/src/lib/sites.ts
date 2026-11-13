/** `example.com` or `*.example.com` (the server checks again). */
export const SITE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/;

/** "https://www.Example.com/x" → "www.example.com"; "*.example.com" stays. */
export function cleanSite(input: string): string {
  const s = input.trim().toLowerCase();
  const m = /^(?:[a-z]+:\/\/)?([^/?#\s]+)/.exec(s);
  return (m?.[1] ?? s).replace(/:\d+$/, "");
}

/** A page with nothing on it yet (`about:blank`): the person in control gets the address bar at once. */
export const isBlankPage = (url: string | null | undefined) =>
  Boolean(
    url &&
      (/^about:/i.test(url) ||
        url === "chrome://newtab/" ||
        url === "chrome-extension://mbgkclemiokgppkieijlfaoehgdjlhbl/start.html"),
  );

/** The address as a browser's bar shows it at rest: no scheme, no lone slash after the host; none for a blank page. */
export const shownAddress = (url: string | null | undefined) =>
  !url || isBlankPage(url) ? "" : url.replace(/^https?:\/\//i, "").replace(/^([^/?#]+)\/$/, "$1");

/**
 * Why opening a site in the agent's browser was refused (`POST …/browser/open`), as the i18n key that says it.
 * `cloud`: the workspace's own computer, which is never off.
 */
export function openRefusalKey(code: string | undefined, cloud = false) {
  switch (code) {
    case "browser.not_allowed":
      return "browser.inCard.goNotAllowed";
    case "browser.bad_address":
      return "browser.inCard.goBadAddress";
    case "browser.open_failed":
      return "browser.inCard.goFailed";
    case "browser.not_in_control":
      return "browser.live.notInControl";
    case "machine.offline":
      return cloud ? "browser.inCard.offlineCloud" : "browser.inCard.offline";
    default:
      return "browser.live.actionFailed";
  }
}
