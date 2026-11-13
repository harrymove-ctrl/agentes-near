import type { NotificationEvent } from "@agenteschat/client";
import { createIsland, raisesIsland, settledBy } from "@agenteschat/client/lib/island";
import { AppState } from "react-native";
import { openConversationNow } from "@/lib/push";

/**
 * The island on the phone (ADR 0071 §9): one list for the workspace on screen, fed by the socket
 * (`useUserEvents`) and drawn by `NoticeIsland`, growing out of the camera's island.
 */
export const island = createIsland();

/**
 * A notification event, for the island: what was read, done or removed leaves it; something new shows while the app
 * is in front (in the background the push does), never for the conversation on screen.
 */
export function feedIsland(event: NotificationEvent) {
  const settled = settledBy(event);
  if (settled) island.settle(settled);
  if (event.type !== "notification.upserted" || AppState.currentState !== "active") return;
  const open = openConversationNow();
  const screens = open ? [{ channelId: open.channelId, threadId: open.threadId ?? null }] : [];
  if (raisesIsland(event, screens)) island.arrive(event.notification);
}
