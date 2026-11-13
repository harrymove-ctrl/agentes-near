import {
  type Agent,
  useAiStatus,
  useComputerSetup,
  useMessages,
  useSetAgentStyle,
  useTeamAnswered,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, noAiCardOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { introCards, introLeadKey, isRightHand, offersTeamSetup } from "@agenteschat/client/lib/right-hand";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { WAVE_SECONDS } from "@agenteschat/ui/agent/stickers";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInUp, useReducedMotion } from "react-native-reanimated";
import { StickerCanvas } from "@/agent/StickerCanvas";
import { useOrg } from "@/providers/org";
import { WorkspaceSky } from "@/sky/Sky";
import { Button, EventPillAction, EventPillText, type IconName, LineIcon, Text } from "@/ui";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { AskWaiting } from "../chat/asks";
import { MESSAGE_STICKER } from "../chat/media";
import { useFailed } from "../routines/hooks";
import { AgentFace, OpensAgent } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useSurface } from "../shared/parts";
import { FirstRunCard, useFirstRun } from "./FirstRun";
import { useSendAnswer } from "./TeamCard";

/**
 * The top of the right hand's DM (ADR 0137), drawn by the app and never stored, so it costs nothing and works before
 * any AI is connected, as on the web: its greeting, then, for the workspace's owners, the first-run checklist (ADR
 * 0155 §6). Anyone else gets one card at a time (`introCards`): a waiting pill with "Connect" (tinted) while there is
 * no AI, then how agents talk to them (ADR 0147); the owner gets that question once the checklist is complete and the
 * team answered them once, so it never stands beside the first task. With no card left, a line to build the team with
 * it, at any time; a personal workspace's words speak of one person's agents (ADR 0159). On the person's first visit
 * (`waveFrom`, when its wave started), its waving sticker under the greeting, drawn as a sticker message is and
 * decorative.
 */
export function RightHandIntro({ agent, channelId, waveFrom }: { agent: Agent; channelId: string; waveFrom?: number }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const team = dir.agents.filter((a) => !isRightHand(a));
  const held = usePlanHold(orgId, org) !== null;
  const setup = useComputerSetup(orgId);
  const checklist = useFirstRun(agent).state;
  // A hold is known with the edition: until then no card, so Connect doesn't flash before the checklist.
  const noAi = aiStateOf(status.data, agent.id) === "no_ai";
  const aiKnown = Boolean(status.data) && !setup.isPending;
  const createsAgents = can(org, "create_agents");
  const cards = introCards({
    noAi: noAi && aiKnown,
    aiKnown,
    askStyle: org?.agentStyle === null,
    held,
    noAiCard: useMessages(orgId, channelId).data?.some((m) => noAiCardOf(m.meta)),
    checklist,
    answered: useTeamAnswered(orgId, team),
  });
  const send = useSendAnswer(channelId);
  return (
    <View style={styles.intro}>
      {/* The first visit: the sign-in's sky goes on at the top of the conversation and the right hand wakes on its
          horizon, so arriving reads as one moment, not a new screen (the face leads, the sky is decoration). */}
      {waveFrom !== undefined ? (
        <View style={styles.arrival} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Animated.View
            entering={reduced ? FadeIn.duration(200) : FadeIn.duration(400)}
            style={StyleSheet.absoluteFill}
          >
            <WorkspaceSky fadeTop={0.35} fade={0.6} style={StyleSheet.absoluteFill} />
          </Animated.View>
          <Animated.View
            entering={
              reduced
                ? FadeIn.duration(200)
                : FadeInUp.duration(420)
                    .delay(120)
                    .easing(Easing.bezier(0.23, 1, 0.32, 1))
            }
          >
            <AgentFace agentId={agent.id} size={72} framed={false} expression="happy" />
          </Animated.View>
        </View>
      ) : null}
      <View style={styles.head}>
        <OpensAgent agentId={agent.id}>
          <AgentFace agentId={agent.id} size={36} />
        </OpensAgent>
        <Text variant="body" style={[styles.bold, styles.shrink]}>
          {agent.name}
        </Text>
      </View>
      <View style={styles.text}>
        <Text variant="body" style={styles.bold}>
          {t(modeKey(org, "rightHand.intro.greeting"), agentGrammar(agent.name))}
        </Text>
        <Text variant="body" tone="ink2">
          {t(modeKey(org, introLeadKey(held, team.length > 0)))}
        </Text>
        {waveFrom !== undefined ? (
          <View style={styles.sticker} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <StickerCanvas
              look={agentLook(agent)}
              mood="wave"
              size={MESSAGE_STICKER}
              seed={agent.id}
              live
              playFor={WAVE_SECONDS}
              from={waveFrom}
            />
          </View>
        ) : null}
        {cards.includes("connect") && (
          <AskWaiting
            forMe
            mark="brain"
            words={t(modeKey(org, "rightHand.intro.connect.title"))}
            actions={
              <EventPillAction
                key="connect"
                primary
                label={t("rightHand.intro.connect.action")}
                onPress={() => openConnectAi({ agentId: agent.id })}
              />
            }
            below={
              <EventPillText>
                <Text variant="footnote" tone="muted">
                  {t(modeKey(org, "rightHand.intro.connect.text"))}
                </Text>
              </EventPillText>
            }
          />
        )}
        <FirstRunCard agent={agent} channelId={channelId} />
        {cards.includes("style") && <StyleCard />}
        {offersTeamSetup({ noAi, aiKnown, createsAgents, hasTeam: team.length > 0, cards, held, checklist }) ? (
          <View>
            <Text variant="small" tone="muted">
              {t(modeKey(org, "rightHand.intro.again.question"))}
            </Text>
            <Button
              variant="text"
              size="sm"
              label={t(modeKey(org, "rightHand.intro.again.action"))}
              onPress={() => send(t(modeKey(org, "rightHand.intro.again.message")))}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** "Como prefere que eu fale com você?": two answers, saved for every agent here; gone once the person picks. */
function StyleCard() {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const failed = useFailed();
  const save = useSetAgentStyle(orgId);
  return (
    <IntroCard icon="chat" title={t("rightHand.intro.style.question")} text={t("rightHand.intro.style.text")}>
      <Button
        variant="primary"
        size="card"
        wide
        label={t("rightHand.intro.style.simple")}
        disabled={save.isPending}
        onPress={() => save.mutate("simple", { onError: failed })}
      />
      <Button
        variant="secondary"
        size="card"
        wide
        label={t("rightHand.intro.style.technical")}
        disabled={save.isPending}
        onPress={() => save.mutate("technical", { onError: failed })}
      />
    </IntroCard>
  );
}

function IntroCard({
  icon,
  title,
  text,
  children,
}: {
  icon: IconName;
  title: string;
  text?: string;
  children: ReactNode;
}) {
  const c = useColors();
  const surface = useSurface();
  return (
    <View style={[styles.card, surface]}>
      <View style={styles.cardHead}>
        <LineIcon name={icon} size={15} color={c.ink2} variant="subhead" />
        <Text variant="subhead" style={[styles.bold, styles.fill]}>
          {title}
        </Text>
      </View>
      {text ? (
        <Text variant="small" tone="muted">
          {text}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 6 },
  // The arrival's band: full width past the intro's margin, the face's feet on its lower third.
  arrival: {
    height: 160,
    marginHorizontal: -16,
    marginTop: -16,
    marginBottom: 8,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 16,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  text: { gap: 8 },
  bold: { fontWeight: "600" },
  sticker: { width: MESSAGE_STICKER, height: MESSAGE_STICKER, marginTop: 4 },
  fill: { flex: 1, minWidth: 0 },
  // A long name wraps beside the face instead of running past the screen's edge.
  shrink: { flexShrink: 1 },
  card: { marginTop: 6, borderRadius: 20, padding: 14, gap: 10 },
  // A question that wraps keeps its icon on its first line.
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
});
