import { type Agent, keys } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInUp, FadeOut } from "react-native-reanimated";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { useOrgMaybe } from "@/providers/org";
import { WorkspaceSky } from "@/sky/Sky";
import { Text, useTheme } from "@/ui";
import { agentLook } from "../shared/logic";
import { OrgAvatar } from "../shared/OrgAvatar";

/** How many of the team stand on the horizon. */
const TEAM = 4;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/**
 * The team arrives on the horizon as you come in: each one rises a few points onto it and fades in, the first (the
 * one at work) leading and the others closing in behind with shrinking gaps, so the four read as one wave, not a
 * queue. A rare moment (signing in, switching workspace), so it may take its time; nothing waits on it.
 */
const ARRIVE_AT = [140, 200, 245, 280];
const arrive = (i: number, reduced: boolean) =>
  reduced
    ? FadeIn.duration(200)
    : FadeInUp.duration(420)
        .delay(ARRIVE_AT[i] ?? 280)
        .easing(EASE_OUT)
        .withInitialValues({ opacity: 0, transform: [{ translateY: 14 }] });

/**
 * The passage into the app after signing in: the workspace's mark over its sky, "Entrando na Acme…", and the team
 * already there on the horizon (the agents the phone knows of it; none on a first visit), so you see who you are
 * about to meet. The screen then becomes the conversations (or the first run when there is no workspace yet). It
 * also stands in for the launch splash, already gone by then, for as long as the account takes to load.
 */
export function Entering({ org }: { org: string | null }) {
  const { t } = useTranslation();
  const { colors: c, reducedMotion } = useTheme();
  const state = useOrgMaybe();
  const qc = useQueryClient();
  // What the phone already holds of this workspace's agents: never a request, the account is still loading.
  const agents = state?.orgId ? (qc.getQueryData<Agent[]>(keys.agents(state.orgId)) ?? []) : [];
  const team = agents.filter((a) => !a.former).slice(0, TEAM);
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(260)}
      style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]}
      accessibilityLiveRegion="polite"
    >
      {/* This workspace's own sky (its server's: day on agentes.chat, dusk on a team's own), low on the screen: the
          horizon the team stands on. It sits on the screen's bottom edge, so it comes in from nothing over its top
          half instead of starting on a hard line, and stays whole down to the edge. */}
      <WorkspaceSky fadeTop={0.55} fade={2} style={styles.sky} />
      <View style={styles.center}>
        {org ? (
          <OrgAvatar logo={state?.org?.logo} size={72} />
        ) : (
          <AgentAvatar agent={{ color: "sky", eyes: "round", id: "agentes" }} size={88} expression="happy" />
        )}
        <Text variant="display" style={styles.text}>
          {org ? t("mobile.entering.title", { org }) : t("mobile.entering.titleNew")}
        </Text>
        <Text variant="subhead" tone="muted" style={styles.text}>
          {org && team.length > 0 ? t("mobile.entering.team") : t("mobile.entering.lead")}
        </Text>
      </View>
      {team.length > 0 ? (
        <View style={styles.team} accessibilityElementsHidden>
          {team.map((a, i) => (
            <Animated.View key={a.id} entering={arrive(i, reducedMotion)} style={styles.member}>
              {/* The first one at work: the team is busy, not posed. */}
              <AgentAvatar
                agent={{ ...agentLook(a), id: a.id }}
                size={36}
                framed={false}
                mode={i === 0 ? "run" : "idle"}
              />
              <Text variant="caption" tone="ink2" numberOfLines={1} style={styles.name}>
                {a.name}
              </Text>
            </Animated.View>
          ))}
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sky: { position: "absolute", left: 0, right: 0, bottom: 0, height: 380 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32 },
  text: { textAlign: "center" },
  team: {
    position: "absolute",
    left: 32,
    right: 32,
    bottom: 120,
    flexDirection: "row",
    justifyContent: "center",
    gap: 18,
  },
  member: { alignItems: "center", gap: 4, maxWidth: 72 },
  name: { maxWidth: 72 },
});
