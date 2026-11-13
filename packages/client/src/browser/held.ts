import { useQueries } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type { BrowserHandoff } from "../api/types";

/**
 * A take over held in a conversation (ADR 0040 §6): "Assumir" turns
 * the run's browser card into the control, and the card must outlive the run's live block (the
 * run pauses while the person drives, and may even end). It stays on the run's last saved message,
 * else (the run posted nothing there) at the end of the conversation the run answers in. Shared by
 * the web and the phone app.
 */

const isOpen = (h: Pick<BrowserHandoff, "status">) => h.status === "pending" || h.status === "active";

/** The agent's open take over, bound to this run: its card is held in the run's conversation. */
export function isHeldTakeover(h: BrowserHandoff | null | undefined, runId: string | null | undefined): boolean {
  return Boolean(h && runId && h.kind === "takeover" && h.runId === runId && isOpen(h));
}

/** The person in control of this open handoff is me. */
export const controlledBy = (h: BrowserHandoff | null | undefined, meId: string | null | undefined): boolean =>
  Boolean(h && meId && h.status === "active" && h.controllerUserId === meId);

/** Where a run's held card goes: the run's conversation (its replies' place). */
export interface HeldPlace {
  runId: string;
  agentId: string;
  channelId: string;
  /** The thread its replies go to; null for a flat reply (a DM). */
  threadId: string | null;
}

let places = new Map<string, HeldPlace>();
let snapshot: HeldPlace[] = [];
const listeners = new Set<() => void>();

function changed() {
  snapshot = [...places.values()];
  for (const l of listeners) l();
}

/** A take over bound to a run was heard of (taken here, or its event in that conversation). */
export function rememberHeldPlace(place: HeldPlace) {
  const old = places.get(place.runId);
  if (
    old &&
    old.agentId === place.agentId &&
    old.channelId === place.channelId &&
    (old.threadId ?? null) === (place.threadId ?? null)
  )
    return;
  places = new Map(places).set(place.runId, place);
  changed();
}

/** From a `browser.handoff.updated` event: an open take over's run lives where the event was sent. */
export function noteHandoffPlace(h: BrowserHandoff, channelId: string, threadId: string | null) {
  if (h.kind !== "takeover" || !h.runId || !isOpen(h)) return;
  rememberHeldPlace({ runId: h.runId, agentId: h.agentId, channelId, threadId });
}

/** Tests: start empty. */
export function resetHeldPlaces() {
  places = new Map();
  changed();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => snapshot;

/** Every run known to hold a take over (filter with `heldRowsIn`). */
export const useHeldPlaces = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

/**
 * The held cards a conversation draws as their own row (at its end): runs of this channel
 * (`visible` says which threads this view shows) without a live block (`live`, which draws the
 * card itself) and without a saved message here (`landed`, whose last one carries the card).
 * Each row still checks that the agent's open take over is bound to its run (one per browser).
 */
export function heldRowsIn(
  all: readonly HeldPlace[],
  view: {
    channelId: string;
    visible: (threadId: string | null) => boolean;
    live: ReadonlySet<string>;
    landed: ReadonlySet<string>;
  },
): HeldPlace[] {
  return all.filter(
    (p) =>
      p.channelId === view.channelId &&
      view.visible(p.threadId) &&
      !view.live.has(p.runId) &&
      !view.landed.has(p.runId),
  );
}

/**
 * The open take overs held in a conversation (the phone's rows): bound to one of its runs
 * (`runIds`), and not drawn by a live browser row already (`drawnAgents`). One per agent.
 */
export function heldTakeoversHere(
  handoffs: readonly (BrowserHandoff | null | undefined)[],
  here: { runIds: ReadonlySet<string>; drawnAgents: ReadonlySet<string> },
): BrowserHandoff[] {
  const out: BrowserHandoff[] = [];
  const seen = new Set<string>();
  for (const h of handoffs) {
    if (!h?.runId || !isHeldTakeover(h, h.runId) || !here.runIds.has(h.runId)) continue;
    if (here.drawnAgents.has(h.agentId) || seen.has(h.agentId)) continue;
    seen.add(h.agentId);
    out.push(h);
  }
  return out;
}

/** A held take over's open handoff is read again at most this often (its realtime event keeps it current). */
export const HELD_STALE_MS = 60_000;

/** The open handoff of each of these agents (cached per agent, kept current by the realtime events). */
export function useAgentsBrowserHandoffs(orgId: string, agentIds: readonly string[], enabled = true) {
  const api = useApi();
  return useQueries({
    queries: agentIds.map((agentId) => ({
      queryKey: keys.agentBrowserHandoff(orgId, agentId),
      queryFn: () => api.browser.agentHandoff(orgId, agentId),
      enabled,
      retry: false,
      staleTime: HELD_STALE_MS,
    })),
  }).map((q) => q.data ?? null);
}
