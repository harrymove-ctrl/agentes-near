import { seenList } from "@agenteschat/client/lib/seen-list";

const safe = (area: () => Storage) => ({
  get(key: string): string | null {
    try {
      return area().getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      area().setItem(key, value);
    } catch {
      // Not persisted.
    }
  },
  remove(key: string) {
    try {
      area().removeItem(key);
    } catch {
      // Ignore.
    }
  },
});

/** localStorage that never throws (private mode, blocked storage). */
export const storage = safe(() => localStorage);
/** sessionStorage (this tab only), the same way. */
export const sessionStore = safe(() => sessionStorage);

/** The JSON list of strings saved under `key` in `storage` (nothing, or anything else saved there: empty). */
export function storedStrings(key: string): string[] {
  try {
    const v = JSON.parse(storage.get(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const STORAGE_KEYS = {
  theme: "agentes.theme",
  lastOrg: "agentes.lastOrg",
  /** The last page shown in each workspace (JSON, by workspace id): where "Onde você parou" opens (ADR 0108). */
  lastPlace: "agentes.lastPlace",
  /** How this browser signed in last ("google", "github", "apple" or "email"): marked on the sign-in screen. */
  lastSignIn: "agentes.lastSignIn",
  /**
   * "1" after Sign out (or Switch account) by hand: on the server the desktop app runs here, the sign-in screen waits
   * for the owner's click instead of signing them in again at once. Any sign-in removes it.
   */
  signedOut: "agentes.signedOut",
  /**
   * sessionStorage, "1": the owner chose Forgot password › Continue on this Mac, so once signed in the app opens
   * "Create a new password" (ADR 0158).
   */
  newPasswordAsk: "agentes.newPasswordAsk",
  /** "0" when the person switched off the picture viewer's hover lens (on by default). */
  imageLens: "agentes.image.lens",
  /** The Drive's view: "grid" (default) or "list". */
  driveView: "agentes.drive.view",
  /** Equipe's view (ADR 0148): "list" (default), "chart", "map", "sectors" or "usage". */
  teamView: "agentes.team.view",
  /** "1" when the person shrank the sidebar to its icon rail (desktop). */
  sidebarCollapsed: "agentes.sidebar.collapsed",
  /** Prefix (`.<user id>.<org id>`): the sidebar categories that person closed in that workspace (JSON array of ids). */
  sidebarSections: "agentes.sidebar.sections",
  /** Prefix (`.<user id>.<org id>`): "1" or "0", the person opened or closed a channel's members column there. */
  membersColumn: "agentes.members.column",
  /** Prefix (`.<user id>.<org id>`): "1" or "0", the person opened or closed the sidebar of a DM with an agent there. */
  dmSidebar: "agentes.dm.sidebar",
  /** Offline-computer notices the person closed (`machineId@offlineSince`), until that computer comes back. */
  outagesDismissed: "agentes.outages.dismissed",
  /** The workspace computer's notice the person closed (`setupNoticeKey`), until its state changes. */
  setupNoticeHidden: "agentes.setup.hidden",
  /** `<user id>.<org id>` entries (JSON array): the person opened the right hand's DM there, so its "Novo" dot is gone. */
  rightHandSeen: "agentes.rightHand.seen",
  /** The desktop app's right click: "ours" (default) or "system" (lib/context-menu.ts). */
  menuLook: "agentes.desktop.menu",
  /** Prefix (`.<message id>`, in `sessionStore`): the Connect dialog already opened by itself for that message. */
  noAiOpened: "agentes.noAi.opened",
  /** Prefix (`.<orgId>`, in `sessionStore`): this tab came back from paying and the hold hasn't lifted yet. */
  paidReturn: "agentes.billing.paid",
  /** Prefix (`.<orgId>`, in `sessionStore`): the agents the onboarding imported there, with their models (JSON). */
  onboardingImports: "agentes.onboarding.imports",
  /**
   * In `sessionStore`: the install an agent's card opened in this tab (`CardInstall`, JSON), so the agent survives
   * connecting GitHub on its site, and a link that only names an agent turns nothing on (`cardInstallAgent`).
   */
  skillInstallFor: "agentes.skills.installFor",
  /** In `sessionStore`: the address this tab signed up with, when the server emailed it a confirmation link. */
  confirmationSent: "agentes.confirmation.sent",
  /** In `sessionStore`: the last page this tab showed outside a flow, where the flow's exits go (lib/return-to.ts). */
  flowReturn: "agentes.flow.return",
  /** In `sessionStore`: my messages waiting for the connection (the shared `outbox`), kept through a reload. */
  outbox: "agentes.outbox",
  /** The app's sounds on this device: "tactile" (default), "sky", "pixel" or "off" (lib/sounds.ts). */
  sounds: "agentes.sounds",
  /** In `sessionStore`, this tab's id; in `storage`, the tab the person used last (it plays sounds while hidden). */
  soundTab: "agentes.sounds.tab",
  /** How many times our notifications ask showed by itself in this browser (`usePushAsk`, ADR 0071). */
  pushOffers: "agentes.push.offers",
  /** In `sessionStore`: when the boot last reloaded because the app's files didn't load (index.html keeps a copy). */
  bootRetry: "agentes.bootRetry",
  /** In `sessionStore`: when the app last reloaded into a new version (`reloadForNewVersion`). */
  versionReload: "agentes.versionReload",
  /**
   * Prefix (`.<invitation token>`, in `sessionStore`): the request this tab made through an invitation link, its key,
   * name and email as JSON, so a reload keeps waiting for the answer (ADR 0090).
   */
  joinAsked: "agentes.join.asked",
  /** Prefix (`.<user id>.<org id>`): "1" once a newcomer closed their welcome in #general (ADR 0090). */
  arrivalClosed: "agentes.arrival.closed",
  /** Prefix (`.<user id>.<org id>`): that person's recent searches there, newest first (JSON array, ADR 0123). */
  searchRecent: "agentes.search.recent",
  /**
   * Prefix (`.<user id>`): what that person typed in each conversation and didn't send (JSON by conversation,
   * `@agenteschat/client/lib/composer-drafts`), forgotten on sign-out.
   */
  composerDrafts: "agentes.drafts",
} as const;

/** The right hand's DM opened, here or from any other way in (`rightHandSeenKey`): its row's "Novo" is gone. */
export const rightHandSeen = seenList(
  () => storage.get(STORAGE_KEYS.rightHandSeen),
  (value) => storage.set(STORAGE_KEYS.rightHandSeen, value),
);
