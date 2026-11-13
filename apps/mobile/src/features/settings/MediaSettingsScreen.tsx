import type { Agent, AgentMediaLevel, GifRating, OrgSettings } from "@agenteschat/client";
import { useAgents, useSettings, useUpdateAgent, useUpdateSettings } from "@agenteschat/client";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { shownMediaSettings } from "@agenteschat/client/lib/media";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { Note } from "../ai/parts";
import { AgentFace } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { Loaded } from "../shared/parts";
import { SettingsPage } from "./parts";

const RATINGS: GifRating[] = ["g", "pg"];
const LEVELS: AgentMediaLevel[] = ["never", "sometimes", "often"];

type MediaPatch = Partial<Pick<OrgSettings, "gifs" | "gifRating" | "agentStickers" | "agentMedia">>;

/**
 * GIFs e figurinhas (ADR 0091), as the web's: what people can send (GIFs and their rating, the agents' stickers), how
 * often agents follow a light reply with one on their own, and each agent's own switch. Who configures the workspace
 * changes them; everyone else reads them. What this server can't do is said beside its control, which stays off. The
 * server's GIPHY key is set up on the web only.
 */
export function MediaSettingsScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const settings = useSettings(orgId);
  const update = useUpdateSettings(orgId);
  const agents = useAgents(orgId);
  const editable = can(org, "configure");
  const title = t("settings.section.media");
  if (!settings.data) {
    return (
      <SettingsPage title={title}>
        {settings.isError ? (
          <View style={styles.note}>
            <Note icon="x">{t("common.loadFailed")}</Note>
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )}
      </SettingsPage>
    );
  }
  // What is being saved shows at once.
  const pending: MediaPatch = update.isPending ? (update.variables ?? {}) : {};
  const shown = { ...settings.data, ...pending };
  const save = (patch: MediaPatch) => {
    if (editable) update.mutate(patch, { onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }) });
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
    <SettingsPage title={title} frozen={settingsFrozen(org, "media")}>
      <Loaded>
        <GroupedFooter>{t("settings.sectionText.media")}</GroupedFooter>
        {!editable ? (
          <View style={styles.note}>
            <Note icon="lock">{t("settings.readOnly")}</Note>
          </View>
        ) : null}
        <GroupedHeader>{t("settings.media.chatTitle")}</GroupedHeader>
        <GroupedList>
          <GroupedRow
            icon="image"
            label={t("settings.media.gifs")}
            {...(shown.gifsAvailable
              ? {
                  hint: {
                    name: t("common.about", { label: t("settings.media.gifs") }),
                    text: t("settings.media.gifsHelp"),
                  },
                }
              : { sub: t("settings.media.gifsUnavailable"), subLines: 2 })}
            toggle={gifsOn}
            disabled={!editable || !shown.gifsAvailable}
            onPress={() => save({ gifs: !gifsOn })}
          />
          <GroupedRow
            icon="smile"
            label={t("settings.media.stickers")}
            hint={{
              name: t("common.about", { label: t("settings.media.stickers") }),
              text: t("settings.media.stickersHelp"),
            }}
            toggle={shown.agentStickers}
            disabled={!editable}
            onPress={() => save({ agentStickers: !shown.agentStickers })}
          />
        </GroupedList>
        <GroupedHeader
          hint={{
            name: t("common.about", { label: t("settings.media.rating") }),
            text: t("settings.media.ratingHelp"),
          }}
        >
          {t("settings.media.rating")}
        </GroupedHeader>
        <GroupedList>
          {RATINGS.map((rating) => (
            <GroupedRow
              key={rating}
              label={t(`settings.media.ratings.${rating}`)}
              checked={shown.gifRating === rating}
              disabled={!editable || !gifsOn}
              onPress={() => save({ gifRating: rating })}
            />
          ))}
        </GroupedList>
        <GroupedHeader
          {...(shown.agentMediaAvailable
            ? {
                hint: {
                  name: t("common.about", { label: t("settings.media.level") }),
                  text: t("settings.media.levelHelp"),
                },
              }
            : {})}
        >
          {t("settings.media.level")}
        </GroupedHeader>
        <GroupedList>
          {LEVELS.map((option) => (
            <GroupedRow
              key={option}
              label={t(`settings.media.levels.${option}`)}
              checked={level === option}
              disabled={!editable || !shown.agentMediaAvailable}
              onPress={() => save({ agentMedia: option })}
            />
          ))}
        </GroupedList>
        {shown.agentMediaAvailable ? null : <GroupedFooter>{t("settings.media.levelUnavailable")}</GroupedFooter>}
        <GroupedHeader>{t("settings.media.agentsTitle")}</GroupedHeader>
        <GroupedList>
          {team.map((agent) => (
            <AgentMediaRow key={agent.id} agent={agent} />
          ))}
        </GroupedList>
        {agentsNote ? <GroupedFooter>{agentsNote}</GroupedFooter> : null}
      </Loaded>
    </SettingsPage>
  );
}

/**
 * One agent's own switch: whoever edits agents changes it. It counts at any level: at Nunca the agent sends none on
 * its own, and still sends one when asked while it is on.
 */
function AgentMediaRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const update = useUpdateAgent(orgId, agent.id);
  const saved = agent.mediaReplies ?? true;
  const on = (update.isPending ? update.variables?.mediaReplies : undefined) ?? saved;
  return (
    <GroupedRow
      leading={<AgentFace agentId={agent.id} size={32} live={false} />}
      label={t("settings.media.agentOn", { name: agent.name })}
      labelLines={2}
      {...(agent.role ? { sub: agent.role } : {})}
      toggle={on}
      disabled={!can(org, "manage_agents")}
      onPress={() =>
        update.mutate({ mediaReplies: !on }, { onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }) })
      }
    />
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginVertical: 16 },
});
