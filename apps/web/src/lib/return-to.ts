import { STORAGE_KEYS, sessionStore } from "./storage";

/**
 * Screens that take over from where the person was: "Criar agente" (its own rail, no sidebar) and a new workspace's
 * onboarding. Cancelling, closing or leaving one goes back to the last page this tab showed outside them
 * (`notePlace`), kept per tab so it outlives a reload or a sign-in in between, else to the given fallback.
 */
export const isFlowPath = (path: string) =>
  /^\/org\/[^/]+\/agents\/new\/?$/.test(path) || /^\/onboarding\/?$/.test(path);

/** Every workspace page shown (`href`: path, search and hash): the last one outside a flow is where its exits go. */
export function notePlace(href: string) {
  const path = href.split(/[?#]/)[0] ?? "";
  if (path.startsWith("/org/") && !isFlowPath(path)) sessionStore.set(STORAGE_KEYS.flowReturn, href);
}

/** Where a flow's exit goes: the last page shown in `orgId` outside a flow, else `fallback`. */
export function returnPlace(orgId: string, fallback = `/org/${orgId}`): string {
  const href = sessionStore.get(STORAGE_KEYS.flowReturn);
  return href?.startsWith(`/org/${orgId}/`) ? href : fallback;
}
