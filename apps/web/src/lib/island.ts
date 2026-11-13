import type { NotificationEvent } from "@agenteschat/client";
import { createIsland, type OnScreen, raisesIsland, settledBy } from "@agenteschat/client/lib/island";

/**
 * The island in this tab (ADR 0071 §9): one list for the workspace on screen, fed by the socket
 * (`realtime/context.tsx`) and drawn by `NoticeIsland`.
 */
export const island = createIsland();

/** The conversations on screen (a channel, a DM, a thread beside it): nothing shows for them. */
const screens = new Set<OnScreen>();

/** This conversation is on screen until the returned release. */
export function holdOnScreen(screen: OnScreen): () => void {
  screens.add(screen);
  return () => {
    screens.delete(screen);
  };
}

/**
 * A notification event, for the island: what was read, done or removed leaves it; something new shows, only in a
 * tab in view (a tab in the background has the browser's notification instead, ADR 0071).
 */
export function feedIsland(event: NotificationEvent) {
  const settled = settledBy(event);
  if (settled) island.settle(settled);
  if (event.type !== "notification.upserted" || document.visibilityState !== "visible") return;
  if (raisesIsland(event, [...screens])) island.arrive(event.notification);
}
