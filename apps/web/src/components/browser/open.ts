import { useEffect, useState } from "react";

/**
 * "Open this agent's browser card" from elsewhere (the activity bar, a notification): the
 * card in the conversation opens in place (and scrolls into view) instead of a page of its
 * own. A request waits for the card that matches it, so a
 * notification can ask before the conversation has rendered.
 */
export interface BrowserCardRequest {
  /** The agent whose browser card opens (the bar). */
  agentId?: string;
  /** The help request whose card opens, taking control (a notification). */
  handoffId?: string;
  at: number;
}

let pending: BrowserCardRequest | null = null;
const listeners = new Set<() => void>();
/** A request older than this is stale (the person went elsewhere meanwhile). */
const FRESH_MS = 60_000;

export function requestBrowserCard(req: Omit<BrowserCardRequest, "at">) {
  pending = { ...req, at: Date.now() };
  for (const l of listeners) l();
}

/**
 * The request for this card, once: true when it matches (the request is then used up).
 * `match` decides, from an agent id and/or a handoff id the card shows.
 */
export function useBrowserCardRequest(match: { agentId?: string; handoffId?: string }): number | null {
  const [hit, setHit] = useState<number | null>(null);
  const { agentId, handoffId } = match;
  useEffect(() => {
    const check = () => {
      const r = pending;
      if (!r || Date.now() - r.at > FRESH_MS) return;
      const ok = (r.handoffId && r.handoffId === handoffId) || (!r.handoffId && r.agentId && r.agentId === agentId);
      if (!ok) return;
      // In this order: React Compiler folds `r` into `pending` here, so clearing first would read `at` off null.
      setHit(r.at);
      pending = null;
    };
    check();
    listeners.add(check);
    return () => {
      listeners.delete(check);
    };
  }, [agentId, handoffId]);
  return hit;
}
