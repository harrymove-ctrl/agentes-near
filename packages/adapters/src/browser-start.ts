/** The agent's start page: a file the runner writes for each agent, which its Chrome opens on (protocol 33). */
export const START_FILE = "agentes-start.html";
/** A new tab: Chrome's own new tab page. */
export const NEW_TAB_URL = "chrome://newtab/";
/** The pages Chrome shows with no site in them, inert for the allowlist: the agent's start page, a new tab. */
export function isStartPage(url: string): boolean {
  if (url === NEW_TAB_URL || url === "chrome://new-tab-page/") return true;
  try {
    const u = new URL(url);
    return u.protocol === "file:" && u.pathname.endsWith(`/${START_FILE}`);
  } catch {
    return false;
  }
}
