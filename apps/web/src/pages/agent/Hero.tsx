import { useAgentDetail } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type AgentColor, Button, Icon, Menu, MenuItem } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { NoAiChip } from "@/components/NoAi";
import { useOrg } from "@/components/org-context";
import { AgentCover } from "@/components/Sky";
import { UsageQueueChip } from "@/components/UsageQueue";
import { useToast } from "@/lib/toast";
import { useStreams } from "@/realtime/context";
import { useAgentEdit } from "./context";

const LIVE = new Set(["running", "queued", "thinking", "waiting_approval"]);

/**
 * Opens the name's field in Configurações › Identidade e jeito (it edits in place: its button turns into the field,
 * which takes the focus), trying a few times while the tab shows.
 */
function editNameSoon(tries = 5) {
  setTimeout(() => {
    const name = document.getElementById("agp-name");
    if (name instanceof HTMLInputElement) name.focus();
    else if (name) name.click();
    else if (tries > 1) editNameSoon(tries - 1);
  });
}

/** The agent's live run, if any: "status|channelId|connector" (a string, so the selector is stable). */
function useLiveRun(agentId: string) {
  const key = useStreams((s) => {
    let found: { status: string; channelId: string; connector: string } | null = null;
    for (const r of Object.values(s.runs)) {
      if (r.agentId !== agentId || !LIVE.has(r.status)) continue;
      // Working beats waiting.
      if (!found || found.status === "waiting_approval")
        found = { status: r.status, channelId: r.channelId, connector: r.connector ?? "" };
    }
    return found ? `${found.status}|${found.channelId}|${found.connector}` : "";
  });
  if (!key) return null;
  const [status = "", channelId = "", connector = ""] = key.split("|");
  return { status, channelId, connector };
}

/** `panel` / `onExpand`: in the panel beside its DM, where "Conversar" is the conversation next to it (its × is the panel's). */
export function AgentHero({
  onArchive,
  panel,
  onExpand,
}: {
  onArchive: () => void;
  panel?: boolean;
  onExpand?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const { agent, draft, viewer, goTo, saved } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const live = useLiveRun(agent.id);
  const busy = Boolean(live && live.status !== "waiting_approval");
  const name = draft.name.trim() || agent.name;
  const channelNames = (detail.data?.channels ?? []).filter((c) => saved.channels?.includes(c.id) ?? true);
  const home = channelNames[0];
  const g = agentGrammar(agent.name);
  const face = useRef<HTMLSpanElement>(null);
  const acts = useRef<HTMLDivElement>(null);
  return (
    <header className="agp-hero">
      {/* Open sky: the cover edge to edge, the agent on its bottom edge, no card. */}
      <section className="agp-idcard" aria-label={name}>
        <div className="agp-cover" data-busy={busy || undefined}>
          <AgentCover color={draft.look.color as AgentColor} busy={busy} clear={() => [face.current, acts.current]} />
          <div className="agp-cover__acts" ref={acts}>
            {!panel && (
              // The same glass as "…" beside it: a solid button on the light cover read as a washed-out slab.
              <Button asChild size="sm" className="agp-chat agp-glass">
                <Link to="/org/$orgId/dm/agent/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
                  <Icon name="message" size={14} />
                  {t("agent.chat")}
                </Link>
              </Button>
            )}
            <Menu
              align="end"
              label={t("agent.moreActions")}
              trigger={
                <Button size="sm" iconOnly icon="more" className="agp-glass" aria-label={t("agent.moreActions")} />
              }
            >
              {home && (
                <MenuItem
                  icon="channel"
                  onSelect={() =>
                    void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: home.id } })
                  }
                >
                  {t("agent.openIn", { channel: home.name })}
                </MenuItem>
              )}
              {viewer === "admin" && (
                <MenuItem
                  icon="edit"
                  onSelect={() => {
                    goTo("settings", "identity");
                    editNameSoon();
                  }}
                >
                  {t("agent.editIdentity")}
                </MenuItem>
              )}
              <MenuItem icon="book" onSelect={() => goTo("memory")}>
                {t("agent.viewMemory")}
              </MenuItem>
              {viewer !== "member" && (
                <MenuItem icon="routines" onSelect={() => goTo("activity")}>
                  {t("agent.viewRuns")}
                </MenuItem>
              )}
              <MenuItem
                icon="copy"
                onSelect={() => {
                  void navigator.clipboard?.writeText(`@${agent.handle}`).catch(() => {});
                  toast.show(t("agentPage.copied", { handle: agent.handle }));
                }}
              >
                {t("agentPage.copyHandle", { handle: agent.handle })}
              </MenuItem>
              {viewer === "admin" && (
                <MenuItem icon="archive" danger onSelect={onArchive}>
                  {t("agentPage.archive.action", g)}
                </MenuItem>
              )}
            </Menu>
            {onExpand && (
              <Button
                size="sm"
                iconOnly
                icon="external"
                className="agp-glass"
                aria-label={t("agentPage.panel.expand")}
                title={t("agentPage.panel.expand")}
                onClick={onExpand}
              />
            )}
          </div>
        </div>
        {/* The face over the cover's bottom edge, cut out by a ring of the page; who it is beside it. */}
        <div className="agp-idrow">
          <span className="agp-face" ref={face}>
            <AgentAvatar agentId={agent.id} appearance={draft.look} size="xl" name={name} />
          </span>
          <div className="agp-ident">
            <h1 className="agp-name">{name}</h1>
            <span className="agp-handle">
              @{draft.handle || agent.handle}
              {(draft.role.trim() || agent.role) && ` · ${draft.role.trim() || agent.role}`}
            </span>
            <NoAiChip agentId={agent.id} />
            <UsageQueueChip agentId={agent.id} />
          </div>
        </div>
      </section>
    </header>
  );
}
