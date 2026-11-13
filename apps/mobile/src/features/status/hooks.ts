import {
  type AgentPresence,
  type AgentStatus,
  type MemberPresence,
  type MemberStatus,
  type Person,
  useAgentStatuses,
  useAiStatus,
  usePeople,
} from "@agenteschat/client";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import {
  agentPresenceShown,
  agentStatusText,
  clearsText,
  isOutOfOffice,
  type LIMIT_ICON,
} from "@agenteschat/client/lib/presence";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentWhyKey, lineText, personLine } from "./logic";

/**
 * Who is how (ADR 0084): people's presence and line (`GET …/people`) and agents' (`GET …/agent-status`, an agent
 * with no AI drawn offline). The lists refetch on `member.status` / `agent.status` (`applyWorkspaceEvent`); the
 * agents' also every 30 seconds while something shows them.
 */
export interface PresenceOf {
  /** A person's presence and line; null while the people load or for someone not in them. */
  person: (userId: string) => { presence: MemberPresence; status: MemberStatus | null } | null;
  /** An agent's presence as drawn, its line in words and its row; null while the statuses load. */
  agent: (agentId: string) => AgentShown | null;
}

export interface AgentShown {
  presence: AgentPresence;
  /** What it says it does, worded ("🛠️ Deploy da v2"); null: no line. */
  line: { emoji: string | null; icon?: typeof LIMIT_ICON; text: string } | null;
  status: AgentStatus | undefined;
  noAi: boolean;
}

export function usePresenceOf(): PresenceOf {
  const orgId = useOrgId();
  const { t, i18n } = useTranslation();
  const people = usePeople(orgId);
  const agents = useAgentStatuses(orgId);
  const ai = useAiStatus(orgId);
  return useMemo(() => {
    const byUser = new Map((people.data ?? []).map((p) => [p.userId, p]));
    const byAgent = new Map((agents.data ?? []).map((a) => [a.agentId, a]));
    return {
      person: (userId) => {
        const p = byUser.get(userId);
        return p ? { presence: p.presence, status: p.status } : null;
      },
      agent: (agentId) => {
        if (!agents.data) return null;
        const status = byAgent.get(agentId);
        // At work it has an AI, whatever the AIs' list reads for this person (the right hand's is each person's own).
        const noAi = aiStateOf(ai.data, agentId) === "no_ai" && status?.working !== true;
        const presence = agentPresenceShown(status, !noAi);
        // Without an AI it does nothing: no line either.
        const line = !noAi && status?.status ? agentStatusText(t, status.status, i18n.language) : null;
        return { presence, line, status, noAi };
      },
    };
  }, [people.data, agents.data, ai.data, t, i18n.language]);
}

/** Your own row in the people: your presence as you see it (hidden stays hidden) and your line. */
export function useMyPerson(): Person | undefined {
  const orgId = useOrgId();
  const meId = useMeId();
  const people = usePeople(orgId);
  return meId ? people.data?.find((p) => p.userId === meId) : undefined;
}

/**
 * The quiet line of a DM's pill (ADR 0084): an agent's presence and what it does (its line, else `doing` from its
 * live run, else `rest`: its role); a person's line with when it clears, else their presence. Undefined while
 * their presence is unknown (`rest` then, for an agent).
 */
export function useDmStatusLine(
  who: { type: string; id: string } | null,
  doing: string | null | undefined,
  rest: string | undefined,
): string | undefined {
  const { t, i18n } = useTranslation();
  const of = usePresenceOf();
  if (!who) return undefined;
  if (who.type === "agent") {
    const a = of.agent(who.id);
    if (!a) return doing ?? rest;
    // Its run here is at work before the list's next read says so.
    const presence = doing ? agentPresenceShown(a.status, true, true) : a.presence;
    return [t(`presence.${presence}`), a.line ? lineText(a.line) : (doing ?? rest)].filter(Boolean).join(" · ");
  }
  const p = of.person(who.id);
  if (!p) return undefined;
  return p.status ? personLine(t, i18n.language || "en", p.status) : t(`presence.${p.presence}`);
}

export interface AgentProfileStatus {
  presence: AgentPresence;
  /** "Ocupado · Num trabalho pesado". */
  line: string;
  /** Its line in full, with who wrote it; null: none. */
  card: { emoji: string | null; icon?: typeof LIMIT_ICON; text: string; note: string } | null;
  /** Out of office with conversations waiting for it (ADR 0118): how many, its queue's way in. */
  waiting: number;
}

/**
 * An agent's presence on its profile (ADR 0084): the badge's presence, a line with why ("Ocupado · Num trabalho
 * pesado", "Ausente · Parado desde 09:21") and its status for the card: the line, and who wrote it (its own, with
 * when it clears) or that it is what it does now. Null while the statuses load.
 */
export function useAgentProfileStatus(agentId: string, name: string): AgentProfileStatus | null {
  const { t, i18n } = useTranslation();
  const when = useWhen();
  const shown = usePresenceOf().agent(agentId);
  if (!shown) return null;
  const activeAt = shown.status?.activeAt ?? null;
  const why = t(`presence.agentWhy.${agentWhyKey(shown.presence, activeAt, shown.noAi)}`, {
    when: activeAt ? when.short(activeAt).toLocaleLowerCase(when.locale) : "",
  });
  const own = shown.status?.status;
  const until = own?.until ?? null;
  const note = !own
    ? ""
    : own.by !== "self"
      ? t("presence.byAuto")
      : until
        ? t("mobile.status.bySelfUntil", {
            name,
            when: lowerFirst(clearsText(t, i18n.language || "en", until), i18n.language),
          })
        : t("presence.bySelf", { name });
  return {
    presence: shown.presence,
    line: `${t(`presence.${shown.presence}`)} · ${why}`,
    card: shown.line ? { ...shown.line, note } : null,
    waiting: own && isOutOfOffice(own) ? (own.count ?? 0) : 0,
  };
}

/** A person's or an agent's presence in a word ("Ocupado"); undefined while unknown or without `who`. */
export function usePresenceWord(who: { type: string; id: string } | null): string | undefined {
  const { t } = useTranslation();
  const of = usePresenceOf();
  if (!who) return undefined;
  const presence = who.type === "agent" ? of.agent(who.id)?.presence : of.person(who.id)?.presence;
  return presence ? t(`presence.${presence}`) : undefined;
}
