import { openOwnPage } from "@/features/ai/parts";
import { appLinkFromUrl } from "@/features/links/app-links";
import { rememberLink } from "@/features/links/pending";
import { SHARE_ROUTE } from "@/features/share/inbox";

/**
 * Every URL the system opens the app with (a universal link / App Link to the website, or `agenteschat://`), before
 * expo-router reads it: the website's address becomes the app's screen (`appLinkFromUrl`), and a page the app has no
 * screen for opens in the browser, the app staying where it was (on its start at launch). What another app shared
 * through the system's share sheet opens "Compartilhar com…".
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  try {
    // The share extension opens the app with `agenteschat://dataUrl=…` (expo-share-intent): "Compartilhar com…".
    if (path.includes("dataUrl=")) return SHARE_ROUTE;
    const link = appLinkFromUrl(path);
    if (!link) return path;
    if ("web" in link) {
      openOwnPage(path);
      return initial ? "/" : "";
    }
    // Signed out, the sign-in comes first; the link is opened right after it.
    if (link.href.startsWith("/link?")) rememberLink(link.href);
    return link.href;
  } catch {
    return initial ? "/" : path;
  }
}
