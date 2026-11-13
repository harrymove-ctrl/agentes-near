import type { Agent, AgentMediaLevel, GifRating, OrgSettings } from "@agenteschat/client";
import { useAgents, useSettings, useUpdateAgent, useUpdateSettings } from "@agenteschat/client";
import { shownMediaSettings } from "@agenteschat/client/lib/media";
import { can } from "@agenteschat/client/lib/permissions";
import { Card, CardFooter, CardHeader, Segmented, Switch } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { GifKeyCard } from "@/components/GifKeyCard";
import { ErrorState, LoadingList } from "@/components/Loading";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";

const RATINGS: GifRating[] = ["g", "pg"];
const LEVELS: AgentMediaLevel[] = ["never", "sometimes", "often"];

type MediaPatch = Partial<Pick<OrgSettings, "gifs" | "gifRating" | "agentStickers" | "agentMedia">>;

/**
 * Configurações › GIFs e figurinhas (ADR 0091): what people can send (GIFs and their rating, the agents' stickers),
 * how often agents follow a light reply with one on their own, and each agent's own switch (which also decides whether
 * it sends one when asked, at any level). Who configures the workspace changes it; everyone else reads it. What this
 * server can't do is said beside its control, which stays off.
 */
export function MediaSettingsSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  const agents = useAgents(org.id);
  const editable = can(org, "configure");
  if (!settings.data) {
    return settings.isError ? (
      <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
    ) : (
      <LoadingList count={3} avatar={false} trailing />
    );
  }
  // What is being saved shows at once.
  const pending: MediaPatch = update.isPending ? (update.variables ?? {}) : {};
  const shown = { ...settings.data, ...pending };
  const save = (patch: MediaPatch) => {
    if (editable) update.mutate(patch);
  };
  const { gifsOn, level } = shownMediaSettings(shown);
  const team = (agents.data ?? []).filter((a) => !a.former);
  const agentsNote =
    team.length === 0 && agents.isSuccess
      ? t("settings.media.noAgents")
      : level === "never" && shown.agentMediaAvailable
        ? t("settings.media.agentsNever")
        : null;

  return (
    <>
      {!editable && <p className="page__note">{t("settings.readOnly")}</p>}
      <Card aria-labelledby="media-chat">
        <CardHeader id="media-chat" icon="sticker" title={t("settings.media.chatTitle")} />
        <div className="settings-rows">
          <PrefRow
            id="media-gifs"
            icon="image"
            label={t("settings.media.gifs")}
            hint={shown.gifsAvailable ? t("settings.media.gifsHelp") : undefined}
            status={!shown.gifsAvailable && t("settings.media.gifsUnavailable")}
            control={
              <Switch
                checked={gifsOn}
                onCheckedChange={(on) => save({ gifs: on })}
                disabled={!editable || !shown.gifsAvailable}
                aria-label={t("settings.media.gifs")}
              />
            }
          />
          <PrefRow
            id="media-rating"
            icon="shield"
            label={t("settings.media.rating")}
            hint={t("settings.media.ratingHelp")}
            control={
              <Segmented
                size="sm"
                label={t("settings.media.rating")}
                value={shown.gifRating}
                onValueChange={(gifRating) => save({ gifRating })}
                options={RATINGS.map((r) => ({ value: r, label: t(`settings.media.ratings.${r}`) }))}
                disabled={!editable || !gifsOn}
              />
            }
          />
          <PrefRow
            id="media-stickers"
            icon="smile"
            label={t("settings.media.stickers")}
            hint={t("settings.media.stickersHelp")}
            control={
              <Switch
                checked={shown.agentStickers}
                onCheckedChange={(on) => save({ agentStickers: on })}
                disabled={!editable}
                aria-label={t("settings.media.stickers")}
              />
            }
          />
        </div>
      </Card>
      {/* The server's own GIPHY key, for its owner on a server that isn't agentes.chat's own (null to anyone else). */}
      <GifKeyCard jevMissing={!shown.agentMediaAvailable} />
      <Card aria-labelledby="media-agents">
        <CardHeader id="media-agents" icon="agent" title={t("settings.media.agentsTitle")} />
        <div className="settings-rows">
          <PrefRow
            id="media-level"
            icon="routines"
            label={t("settings.media.level")}
            hint={shown.agentMediaAvailable ? t("settings.media.levelHelp") : undefined}
            status={!shown.agentMediaAvailable && t("settings.media.levelUnavailable")}
            control={
              <Segmented
                size="sm"
                label={t("settings.media.level")}
                value={level}
                onValueChange={(agentMedia) => save({ agentMedia })}
                options={LEVELS.map((l) => ({ value: l, label: t(`settings.media.levels.${l}`) }))}
                disabled={!editable || !shown.agentMediaAvailable}
              />
            }
          />
          {team.map((agent) => (
            <AgentMediaRow key={agent.id} agent={agent} />
          ))}
        </div>
        {agentsNote && <CardFooter>{agentsNote}</CardFooter>}
      </Card>
    </>
  );
}

/**
 * One agent's own switch: whoever edits agents changes it. It counts at any level: at Nunca the agent sends none on
 * its own, and still sends one when asked while it is on.
 */
function AgentMediaRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const update = useUpdateAgent(org.id, agent.id);
  const saved = agent.mediaReplies ?? true;
  const asked = update.isPending ? update.variables?.mediaReplies : undefined;
  const id = `media-agent-${agent.id}`;
  return (
    <PrefRow
      id={id}
      lead={<AgentAvatar agentId={agent.id} name={agent.name} size="sm" />}
      label={agent.name}
      status={agent.role || undefined}
      control={
        <Switch
          checked={asked ?? saved}
          onCheckedChange={(next) => update.mutate({ mediaReplies: next })}
          disabled={!can(org, "manage_agents")}
          aria-label={t("settings.media.agentOn", { name: agent.name })}
          aria-describedby={agent.role ? `${id}-help` : undefined}
        />
      }
    />
  );
}
