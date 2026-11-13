import type { User } from "@agenteschat/client";
import { channelsQuery } from "@agenteschat/client";
import { type AgentAppearance, Avatar, Icon } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { OrgMark } from "@/components/ProfilePhoto";

export interface PreviewAgent {
  name: string;
  role: string;
  look: AgentAppearance | undefined;
  /** Comes with the template on screen: tinted until it is made. */
  fresh?: boolean;
  /** Made, asleep until the plan. */
  asleep?: boolean;
}

/**
 * The workspace's sidebar beside the question (wide screens), drawn with the sidebar's own classes and filling in as
 * the person answers: its name and logo, #general and the template's channels, the right hand and the team. Only a
 * picture: nothing in it can be focused or pressed. `orgId` once the team is made: its channels as they are.
 */
export function OnboardingPreview({
  org,
  logo,
  channels,
  fresh,
  orgId,
  agents,
  person,
  personal,
}: {
  org: string;
  logo: string | null;
  channels: string[];
  fresh: string[];
  orgId: string | null;
  agents: PreviewAgent[];
  person: Pick<User, "name" | "image">;
  /** A personal workspace has no team (ADR 0159): its empty place speaks of its agents. */
  personal: boolean;
}) {
  const { t } = useTranslation();
  const made = useQuery({ ...channelsQuery(useApi(), orgId ?? ""), enabled: orgId !== null }).data;
  const names = [...new Set(made ? made.map((c) => c.name) : channels)].sort((a, b) => a.localeCompare(b));
  // The right hand stands first, the team after it.
  const team = agents.length - 1;
  return (
    // No caption over it: the frame starts on the step's top line, and its name ("Your workspace, as you answer") is
    // for screen readers.
    <aside className="onb-preview" aria-label={t("onboarding.flow.preview.label")}>
      <div className="onb-preview__frame" aria-hidden="true" inert>
        <div className="sidebar onb-preview__side">
          <div className="sidebar__top">
            <div className="sidebar__org">
              <span className="sidebar__org-button">
                <OrgMark logo={logo} className="sidebar__org-mark" />
                <span className="sidebar__org-text">
                  <span className="sidebar__org-name">{org}</span>
                  <span className="sidebar__org-meta">
                    {t("settings.tileState.members", { count: 1 })} ·{" "}
                    {t("sidebarAgents.count", { count: agents.length })}
                  </span>
                </span>
                <Icon name="chevronDown" size={16} />
              </span>
            </div>
          </div>
          <div className="sidebar__scroll">
            <div className="sidebar__group sidebar__section" data-open="true">
              <div className="sidebar__section-head">
                <span className="sidebar__section-toggle">
                  <Icon name="chevronDown" size={14} className="sidebar__section-chevron" />
                  <span className="sidebar__label">{t("shell.channels")}</span>
                </span>
              </div>
              <div className="sidebar__section-body">
                {names.map((c) => (
                  <span
                    key={c}
                    className="sidebar__item"
                    data-kind="channel"
                    data-fresh={fresh.includes(c) || undefined}
                  >
                    <Icon name="channel" className="sidebar__channel-icon" />
                    <span className="sidebar__item-label">{c}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="sidebar__group sidebar__section" data-open="true">
              <div className="sidebar__section-head">
                <span className="sidebar__section-toggle">
                  <Icon name="chevronDown" size={14} className="sidebar__section-chevron" />
                  <span className="sidebar__label">{t("shell.agents")}</span>
                </span>
              </div>
              <div className="sidebar__section-body">
                {agents.map((a) => (
                  <span key={a.name} className="sidebar__item" data-fresh={a.fresh || undefined}>
                    <AgentAvatar
                      name={a.name}
                      appearance={a.look}
                      size="sm"
                      state={a.asleep ? "sleeping" : undefined}
                    />
                    <span className="sidebar__item-text">
                      <span className="sidebar__item-label ac-captop">{a.name}</span>
                      <span className="sidebar__item-role">{a.role}</span>
                    </span>
                  </span>
                ))}
                {team === 0 && (
                  <span className="onb-preview__ghost">
                    {t(personal ? "onboarding.flow.preview.ghostPersonal" : "onboarding.flow.preview.ghost")}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="sidebar__foot">
            <div className="sidebar__me">
              <span className="onb-preview__me">
                <Avatar kind="person" name={person.name} imageUrl={person.image} size="sm" />
                <span className="sidebar__item-text">
                  <span className="sidebar__item-label ac-captop">{person.name}</span>
                  <span className="sidebar__item-role">{t("presence.online")}</span>
                </span>
              </span>
              <Icon name="bell" />
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
