import { serverUrl } from "@/lib/server";
import { router } from "@/ui/navigation";
import { openOwnPage } from "../ai/parts";
import { appLinkFromUrl } from "./app-links";

/**
 * A page of this server (`/org/…/settings/roles`): the app's own screen when it has one, the website in the in-app
 * browser only where it hasn't, so a screen the app has never sends the person out of it.
 */
export function openWebPath(path: string) {
  const url = `${serverUrl()}${path}`;
  const link = appLinkFromUrl(url);
  if (link && "href" in link) router.push(link.href as never);
  else openOwnPage(url);
}
