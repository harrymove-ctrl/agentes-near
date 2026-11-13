import type {
  AgentPresence,
  AgentStatus,
  AgentStatusLine,
  AiStatus,
  Availability,
  MemberPresence,
  MemberStatus,
  Person,
} from "@agenteschat/client";
import { agentStateIn, keys, useApi } from "@agenteschat/client";
import { agentPresenceShown, agentStatusText } from "@agenteschat/client/lib/presence";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useCallback } from "react";
import { useOrg } from "@/components/org-context";
import { useStreams } from "@/realtime/context";

/*
 * Presence and written status (ADR 0084) for one person or one agent, read from the lists every screen shares
 * (`…/people`, `…/agent-status`, `…/ai-status`). Each face picks its own row (`select`), so a change elsewhere
 * redraws only the faces it touches. Only the sidebar polls the agents' list (`useAgentStatuses`): every face doing it
 * would fetch it once per face.
 */

/** The line's emoji when its author picked none. */
export const STATUS_EMOJI = "💬";

/** A line whose end has passed reads as none (the server clears it on read; a list kept here may be older). */
const live = <T extends { until: string | null }>(line: T | null | undefined, now = Date.now()): T | null =>
  line && (!line.until || new Date(line.until).getTime() > now) ? line : null;

/** What you picked, from how you appear to yourself, when the server didn't say (`Person.availability`). */
export const availabilityOf = (presence: MemberPresence | undefined): Availability =>
  presence === "away" || presence === "busy" || presence === "out" || presence === "hidden" ? presence : "auto";

/** A person's line as its emoji and words. */
export const personLine = (status: MemberStatus) => ({ emoji: status.emoji || STATUS_EMOJI, text: status.text });

export interface PersonPresence {
  presence: MemberPresence;
  status: MemberStatus | null;
  person: Person;
}

/** A person's presence and line; null while the people load or for someone not in the workspace. */
export function usePersonPresence(userId: string | null | undefined): PersonPresence | null {
  const { org } = useOrg();
  const api = useApi();
  const pick = useCallback((list: Person[]) => list.find((p) => p.userId === userId) ?? null, [userId]);
  const person = useQuery({
    queryKey: keys.people(org.id),
    queryFn: () => api.orgs.people(org.id),
    staleTime: 30_000,
    enabled: Boolean(userId),
    select: pick,
  }).data;
  if (!userId || !person) return null;
  return { presence: person.presence, status: live(person.status), person };
}

const presenceMap = (list: Person[]) => new Map(list.map((p) => [p.userId, p.presence]));

/** Everyone's presence in the workspace by user id (empty while the people load). */
export function usePresences(): Map<string, MemberPresence> {
  const { org } = useOrg();
  const api = useApi();
  return (
    useQuery({
      queryKey: keys.people(org.id),
      queryFn: () => api.orgs.people(org.id),
      staleTime: 30_000,
      select: presenceMap,
    }).data ?? EMPTY_PRESENCES
  );
}
const EMPTY_PRESENCES = new Map<string, MemberPresence>();

export interface AgentShown {
  presence: AgentPresence;
  line: AgentStatusLine | null;
  /** Its last run's end (now while one is going); null = it never worked. */
  activeAt: string | null;
  /** No AI to think with: drawn offline (ADR 0084 §3). */
  noAi: boolean;
}

/** An agent's presence as the apps draw it and its line; null while the list loads. */
export function useAgentPresence(agentId: string | null | undefined): AgentShown | null {
  const { org } = useOrg();
  const api = useApi();
  const on = Boolean(agentId) && org.id.length > 0;
  const pickStatus = useCallback((list: AgentStatus[]) => list.find((s) => s.agentId === agentId) ?? null, [agentId]);
  const pickAi = useCallback(
    (status: AiStatus) => status.agents.find((a) => a.agentId === agentId)?.state ?? null,
    [agentId],
  );
  const status = useQuery({
    queryKey: keys.agentStatus(org.id),
    queryFn: () => api.agents.statuses(org.id),
    staleTime: 15_000,
    enabled: on,
    select: pickStatus,
  }).data;
  const ai = useQuery({
    queryKey: keys.aiStatus(org.id),
    queryFn: () => api.agents.aiStatus(org.id),
    staleTime: 30_000,
    enabled: on,
    select: pickAi,
  }).data;
  // A run of its this tab hears: at work before the list's next read says so.
  const working = useStreams((s) => (agentId ? agentStateIn(s, agentId) !== "idle" : false));
  if (!on || status === undefined) return null;
  // At work it has an AI, whatever the AIs' list reads for this person (the right hand's is each person's own).
  const noAi = ai === "no_ai" && !working && status?.working !== true;
  return {
    presence: agentPresenceShown(status ?? undefined, !noAi, working),
    line: noAi ? null : live(status?.status),
    activeAt: status?.activeAt ?? null,
    noAi,
  };
}

/** An agent's line in words with its emoji, or null; `locale` words when an agent out of office is back. */
export const agentLine = (t: TFunction, line: AgentStatusLine | null, locale?: string) =>
  line ? agentStatusText(t, line, locale) : null;
