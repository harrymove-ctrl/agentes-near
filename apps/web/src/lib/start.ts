import { STORAGE_KEYS, storage } from "./storage";

/**
 * What opens when a workspace opens (ADR 0108), the web's part: the last page this browser showed in each workspace,
 * and the workspace this tab shows, so the person's choice applies when a workspace opens, never on a move inside it.
 */

type Places = Record<string, string>;

function readPlaces(): Places {
  try {
    const raw = JSON.parse(storage.get(STORAGE_KEYS.lastPlace) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Places) : {};
  } catch {
    return {};
  }
}

/** A page of the workspace that "Onde você parou" can open: not its bare address, nor its onboarding. */
export const isPlace = (orgId: string, path: string) =>
  path.startsWith(`/org/${orgId}/`) && !/^\/org\/[^/]+\/(onboarding)?\/?$/.test(path);

/** The last page shown in this workspace, or null. */
export function lastPlace(orgId: string): string | null {
  const path = readPlaces()[orgId];
  return typeof path === "string" && isPlace(orgId, path) ? path : null;
}

export function rememberPlace(orgId: string, path: string) {
  if (isPlace(orgId, path)) storage.set(STORAGE_KEYS.lastPlace, JSON.stringify({ ...readPlaces(), [orgId]: path }));
}

/** The channel a workspace path shows (`/org/{orgId}/c/{channelId}`), if any. */
export const channelOfPath = (path: string) => /^\/org\/[^/]+\/c\/([^/?#]+)/.exec(path)?.[1] ?? null;

/** Whether a workspace path is a conversation: a channel or a direct message. */
export const isChatPath = (path: string) => /^\/org\/[^/]+\/(c|dm)\//.test(path);

/** The workspace this tab shows; null before the first one, and after the app's own address (`/`), which opens one. */
let shown: string | null = null;
export const showWorkspace = (orgId: string | null) => {
  shown = orgId;
};
/** Whether going to this workspace's bare address opens it: another workspace, or the first in this tab. */
export const opensWorkspace = (orgId: string) => shown !== orgId;
