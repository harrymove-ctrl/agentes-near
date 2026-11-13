import type { Channel } from "@agenteschat/client";
import { canTalk, listsAgent } from "@agenteschat/client/lib/audience";
import { Avatar, Button } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { WelcomeCard } from "@/components/WelcomeCard";
import { useDirectory } from "@/hooks/useDirectory";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/** How long after joining someone is still arriving. */
const ARRIVING_MS = 86_400_000;
/** The faces on the card: a few people, then the agents. */
const PEOPLE_SHOWN = 3;
const AGENTS_SHOWN = 4;

const closedKey = (userId: string, orgId: string) => `${STORAGE_KEYS.arrivalClosed}.${userId}.${orgId}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * Whether #general greets this person (ADR 0090): someone who came in by an invitation or an approved request in
 * the last day (the workspace's owner made it), until they close the welcome, which this browser keeps per person
 * and workspace.
 */
export function useArrival(channel: Pick<Channel, "name">) {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [closed, setClosed] = useState(() => storage.get(closedKey(me.user.id, org.id)) !== null);
  const joinedAt = dir.memberById.get(me.user.id)?.joinedAt;
  const arriving = !!joinedAt && Date.now() - new Date(joinedAt).getTime() < ARRIVING_MS;
  return {
    show: channel.name === "general" && org.role !== "owner" && arriving && !closed,
    close: () => {
      storage.set(closedKey(me.user.id, org.id), "1");
      setClosed(true);
    },
  };
}

/**
 * A newcomer's first #general: the onboarding's welcome card with who works there, and the first things to do: say
 * hi here (the composer takes the focus), talk to an agent, meet the team.
 */
export function ArrivalCard({
  channel,
  onSayHi,
  onClose,
}: {
  channel: Pick<Channel, "name">;
  onSayHi: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const people = dir.members.filter((m) => m.userId !== me.user.id).slice(0, PEOPLE_SHOWN);
  const agents = dir.agents.filter((a) => listsAgent(org, a)).slice(0, AGENTS_SHOWN);
  const host = agents.find((a) => canTalk(a));
  return (
    <WelcomeCard
      className="welcome-card--channel"
      titleId="arrival-title"
      level={2}
      title={t("members.arrival.title", { org: org.name, name: firstName(me.user.name) })}
      lead={t("members.arrival.lead", { channel: channel.name })}
      crew={
        people.length + agents.length > 0 ? (
          <>
            {people.map((p) => (
              <span key={p.userId} className="welcome-card__who">
                <Avatar name={p.name} imageUrl={p.image} size="lg" />
                <span className="welcome-card__name">{firstName(p.name)}</span>
              </span>
            ))}
            {agents.map((a) => (
              <span key={a.id} className="welcome-card__who">
                <AgentAvatar agent={a} name={a.name} size="lg" />
                <span className="welcome-card__name">{a.name}</span>
              </span>
            ))}
          </>
        ) : undefined
      }
      actions={
        <>
          <Button icon="message" onClick={onSayHi}>
            {t("members.arrival.sayHi", { channel: channel.name })}
          </Button>
          {host && (
            <Button
              onClick={() =>
                void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: host.id } })
              }
            >
              <AgentAvatar agent={host} name={host.name} size="xs" />
              {t("members.arrival.talkTo", { name: host.name })}
            </Button>
          )}
          <Button icon="members" onClick={() => void navigate({ to: "/org/$orgId/team", params: { orgId: org.id } })}>
            {t("members.arrival.team")}
          </Button>
        </>
      }
      onClose={onClose}
      closeLabel={t("common.close")}
    />
  );
}
