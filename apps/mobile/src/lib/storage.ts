import { seenList } from "@agenteschat/client/lib/seen-list";
import * as SecureStore from "expo-secure-store";
import { STORAGE_PREFIX } from "@/config";

/**
 * Small values the app remembers (theme, current organization, push token, collapsed sections), in SecureStore.
 * Reads never throw: a missing or unreadable value is `null`.
 */
const key = (name: string) => `${STORAGE_PREFIX}.${name}`;

export async function readValue(name: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key(name));
  } catch {
    return null;
  }
}

export function readValueSync(name: string): string | null {
  try {
    return SecureStore.getItem(key(name));
  } catch {
    return null;
  }
}

/** `writeValue` at once, for a value read back in the same render (`readValueSync`). */
export function writeValueSync(name: string, value: string): void {
  try {
    SecureStore.setItem(key(name), value);
  } catch {
    // Storage unavailable: the app works without remembering.
  }
}

export async function writeValue(name: string, value: string | null): Promise<void> {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key(name));
    else await SecureStore.setItemAsync(key(name), value);
  } catch {
    // Storage unavailable: the app works without remembering.
  }
}

/** Names of the remembered values (one place, so sign-out can clear them all). */
export const STORED = {
  theme: "theme",
  org: "org",
  pushToken: "push-token",
  pushAsked: "push-asked",
  /** The person turned notifications off in the app (no silent re-registration). */
  pushOff: "push-off",
  /** How many times our notifications sheet opened by itself (@agenteschat/client/lib/push-offer). */
  pushOffers: "push-offers",
  /** The wiki pages last opened on this phone, per workspace (JSON: org id → slugs, newest first). */
  wikiRecent: "wiki-recent",
  /** When each workspace was last opened (JSON: org id → ms), for the channel's greeting of a new day (ADR 0090). */
  channelVisits: "channel-visits",
  /** The newcomers who closed their #general welcome (JSON list of "user:org"). */
  arrivalClosed: "arrival-closed",
  /** Conversas' sections the person collapsed (JSON list). */
  homeCollapsed: "home-collapsed",
  /** The Threads tab's sections the person collapsed (JSON list). */
  threadsCollapsed: "threads-collapsed",
  /** Agentes' groups the person collapsed, in every workspace (JSON list of group ids). */
  agentGroupsCollapsed: "agent-groups-collapsed",
  /** The agent profile's tab last chosen (Hoje, Acesso, Memória): every profile opens on it (features/agents). */
  agentProfileTab: "agent-profile-tab",
  /** An invitation opened before signing in: dealt with once the person is in (features/auth/invite.ts). */
  invite: "invite",
  /** The request this phone made through a link, with the key that signs in once approved (features/auth/invite.ts). */
  joinAsked: "join-asked",
  /** The app's sounds on this phone: "tactile" (default), "sky", "pixel" or "off" (lib/sounds.ts). */
  sounds: "sounds",
  /** Offline-computer notices the person closed, by outage (JSON list; features/outages). */
  outagesDismissed: "outages-dismissed",
  /** The last conversation opened in each workspace (JSON by workspace id): "Onde você parou" (ADR 0108). */
  lastPlace: "last-place",
  /** Recent searches, newest first, per workspace (JSON by workspace id; ADR 0123). */
  searchRecent: "search-recent",
  /** Recent searches inside one conversation, newest first (JSON by `<workspace id>:<channel id>`). */
  conversationSearchRecent: "conversation-search-recent",
  /** The person has touched the trackpad: its lesson is over ("1"). */
  trackpadTaught: "trackpad-taught",
  /** The "Double tap = 👍" line under a message was shown once, or the person double tapped already ("1"). */
  doubleTapTaught: "double-tap-taught",
  /** `<user id>.<org id>` entries (JSON list): the right hand's DM was opened there, so its "Novo" is gone. */
  rightHandSeen: "right-hand-seen",
  /** The person held the send button to stop an agent and send once: the composer's hint is over ("1"). */
  stopSendTaught: "stop-send-taught",
} as const;

export async function clearStoredValues(): Promise<void> {
  await Promise.all(Object.values(STORED).map((name) => writeValue(name, null)));
}

/** The right hand's DM opened, from its row or any other way in (`rightHandSeenKey`): its row's "Novo" is gone. */
export const rightHandSeen = seenList(
  () => readValueSync(STORED.rightHandSeen),
  (value) => writeValueSync(STORED.rightHandSeen, value),
);
