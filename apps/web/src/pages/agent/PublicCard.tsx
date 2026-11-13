import type { Agent } from "@agenteschat/client";
import { useAgentDetail } from "@agenteschat/client";
import { audienceSummary } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { tellsNameStory } from "@agenteschat/client/lib/right-hand";
import { type AgentColor, Avatar, Button, Card, CardHeader, Chip, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { AgentCover } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

/** "Pedir acesso": a direct message to the agent's owner (none without one: the note names the admins). */
export function AskAccessButton({ agent, size = "sm" }: { agent: Pick<Agent, "ownerUserId">; size?: "sm" | "md" }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  if (!agent.ownerUserId) return null;
  return (
    <Button asChild size={size} variant="primary" icon="message">
      <Link to="/org/$orgId/dm/person/$userId" params={{ orgId: org.id, userId: agent.ownerUserId }}>
        {t("profile.askAccess")}
      </Link>
    </Button>
  );
}

/**
 * The agent's page for someone who doesn't see how it works (`seesDetails`): its face, name and role, who answers
 * for it, who it answers, where it works, and a way to ask for access. No tabs.
 */
export function AgentPublicCard({
  agent,
  children,
}: {
  agent: Agent;
  /** Cards first in its column (the team's right hand's own AI for the viewer). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const detail = useAgentDetail(org.id, agent.id);
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const channels = detail.data?.channels ?? [];
  const g = agentGrammar(agent.name);
  const look = lookOf(agent);
  return (
    <div className="page page--full agp">
      <header className="agp-hero">
        <section className="agp-idcard" aria-label={agent.name}>
          <div className="agp-cover">
            <AgentCover color={(look?.color ?? "indigo") as AgentColor} busy={false} />
          </div>
          <div className="agp-idrow">
            <span className="agp-face">
              <AgentAvatar agentId={agent.id} size="xl" name={agent.name} />
            </span>
            <div className="agp-ident">
              <h1 className="agp-name">{agent.name}</h1>
              <span className="agp-handle">
                @{agent.handle}
                {agent.role && ` · ${agent.role}`}
              </span>
              {tellsNameStory(agent) && (
                <span className="small muted agp-story">{t("rightHand.profile.nameStory")}</span>
              )}
            </div>
          </div>
        </section>
      </header>
      <div className="agp-view">
        <div className="agp-cols">
          <div className="agp-col">
            {children}
            <Card as="section" className="agp-card" aria-labelledby="pub-who">
              <CardHeader id="pub-who" icon="person" title={t("agentPage.overview.who", g)} />
              <div className="agp-person">
                {owner ? (
                  <Avatar kind="person" size="lg" name={owner.name} imageUrl={owner.image} />
                ) : (
                  <span className="newag__ib">
                    <Icon name="members" size={16} />
                  </span>
                )}
                <span className="agp-person__t">
                  <b className="ac-captop">{owner ? owner.name : t("newAgent.noOwnerOption")}</b>
                  <span>{owner ? t("agentPage.overview.ownerRole") : t("newAgent.noOwnerHelp")}</span>
                </span>
              </div>
              <div className="agp-kv">
                <div>
                  <span className="agp-k">{t("audience.section")}</span>
                  <span className="agp-chips">
                    <Chip icon="message">
                      {audienceSummary(t, agent, (id) => dir.memberById.get(id)?.name, dir.roleName)}
                    </Chip>
                  </span>
                </div>
              </div>
            </Card>
            <Card as="section" className="agp-card" aria-labelledby="pub-where">
              <CardHeader id="pub-where" icon="channel" title={t("agentPage.overview.where", g)} />
              {channels.length ? (
                <span className="agp-chips">
                  {channels.map((c) => (
                    <Chip key={c.id} icon="channel">
                      {c.name}
                    </Chip>
                  ))}
                </span>
              ) : (
                <span className="small muted">{t("agentPage.overview.noChannels", { handle: agent.handle })}</span>
              )}
            </Card>
            <Card as="section" className="agp-card" aria-labelledby="pub-hidden">
              <CardHeader id="pub-hidden" icon="lock" title={t("profile.detailsHiddenTitle")} />
              <p className="small muted">{t("profile.detailsHidden", agentGrammar(agent.name))}</p>
              <div className="ac-acts">
                <AskAccessButton agent={agent} />
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
