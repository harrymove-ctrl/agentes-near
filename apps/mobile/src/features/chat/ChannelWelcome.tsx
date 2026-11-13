import { type Message, useMe, useOverview } from "@agenteschat/client";
import { joinNames, whenAt } from "@agenteschat/client/lib/format";
import { agentActivitySince, dayPart, isNewDay } from "@agenteschat/client/lib/welcome";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { readValueSync, STORED, writeValueSync } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { WorkspaceSky } from "@/sky/Sky";
import { haptics, IconButton, Text, useReducedMotion } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { useSurface } from "../shared/parts";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** How long after joining someone is still arriving (ADR 0090, as on the web). */
const ARRIVING_MS = 86_400_000;
/** Faces on the card. */
const CREW = 3;
/** A swipe up this far, or a flick, puts it away. */
const DISMISS_Y = -36;
const FLICK = 500;

type Visits = Record<string, number>;

function readVisits(): Visits {
  try {
    const raw = JSON.parse(readValueSync(STORED.channelVisits) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Visits) : {};
  } catch {
    return {};
  }
}

/**
 * One greeting per workspace per app run, as on the web: the first channel opened on a new day claims it (never on
 * the very first visit: onboarding greets then). Opening a workspace marks the visit.
 */
const greetings = new Map<string, { last: number | null; show: boolean; channelId?: string; closed?: boolean }>();
function claimGreeting(orgId: string, channelId: string) {
  let g = greetings.get(orgId);
  if (!g) {
    const visits = readVisits();
    const at = visits[orgId];
    const last = typeof at === "number" && Number.isFinite(at) ? at : null;
    g = { last, show: isNewDay(last) };
    greetings.set(orgId, g);
    writeValueSync(STORED.channelVisits, JSON.stringify({ ...visits, [orgId]: Date.now() }));
  }
  if (g.show && !g.channelId) g.channelId = channelId;
  return g;
}

const closedArrivals = (): string[] => {
  try {
    const raw = JSON.parse(readValueSync(STORED.arrivalClosed) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * The top of a channel when it greets you, as the web's (ADR 0090): a newcomer's first #general welcomes them to the
 * workspace; otherwise, on the first channel of a new day, "Boa tarde, Ana." with what its agents left since your last
 * visit and the requests waiting for you. A card on the workspace's sky under the bar, with who did it; it drops in
 * once, and a swipe up or × puts it away (where it came from).
 */
export function ChannelWelcome({
  channelId,
  channelName,
  messages,
  agentIds,
  top,
}: {
  channelId: string;
  channelName: string;
  messages: Message[] | undefined;
  /** The channel's agents, the crew when none of them wrote since. */
  agentIds: string[];
  /** Where it sits: under the floating bar. */
  top: number;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const me = useMe().data;
  const dir = useDirectory();
  const overview = useOverview(orgId);
  const reduced = useReducedMotion();
  const surface = useSurface("e2");
  const [greeting] = useState(() => claimGreeting(orgId, channelId));
  const meId = me?.user.id ?? "";
  const joinedAt = dir.memberById.get(meId)?.joinedAt;
  const closedKey = `${meId}:${orgId}`;
  const [arrivalClosed, setArrivalClosed] = useState(() => closedArrivals().includes(closedKey));
  const arriving =
    channelName === "general" &&
    org?.role !== "owner" &&
    !!joinedAt &&
    Date.now() - new Date(joinedAt).getTime() < ARRIVING_MS &&
    !arrivalClosed;
  const [closed, setClosed] = useState(greeting.closed ?? false);
  const greets = !arriving && greeting.show && greeting.channelId === channelId && !closed && greeting.last !== null;
  const shows = Boolean(me) && (arriving || (greets && messages !== undefined));

  const y = useSharedValue(reduced ? 0 : -12);
  const shown = useSharedValue(0);
  useEffect(() => {
    if (!shows) return;
    shown.set(withTiming(1, { duration: reduced ? 200 : 280, easing: EASE_OUT }));
    if (!reduced) y.set(withTiming(0, { duration: 280, easing: EASE_OUT }));
  }, [shows, reduced, shown, y]);

  const close = () => {
    if (arriving) {
      writeValueSync(STORED.arrivalClosed, JSON.stringify([...closedArrivals(), closedKey]));
      setArrivalClosed(true);
    } else {
      greeting.closed = true;
      setClosed(true);
    }
  };
  // Leaves upward, the way it came; gone from the tree once it's out.
  const putAway = () => {
    haptics.light();
    shown.set(withTiming(0, { duration: 180, easing: EASE_OUT }));
    if (!reduced) y.set(withTiming(-24, { duration: 180, easing: EASE_OUT }));
    setTimeout(close, 190);
  };
  const pan = usePanGesture({
    // Up only: [start, end] offsets, activating 8 above; a move down or sideways first is not this.
    activeOffsetY: [-8, 1e6],
    failOffsetX: [-12, 12],
    onUpdate: (e) => {
      "worklet";
      const ty = e.translationY;
      // Up follows the finger; down resists (rubber band), there is nowhere to go.
      y.set(ty < 0 ? ty : ty * 0.2);
    },
    onDeactivate: (e) => {
      "worklet";
      if (e.translationY < DISMISS_Y || e.velocityY < -FLICK) scheduleOnRN(putAway);
      else y.set(withSpring(0, { duration: 300, dampingRatio: 0.8, velocity: e.velocityY }));
    },
  });
  const style = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateY: y.get() }] }));

  if (!shows || !me) return null;

  const name = firstNameOf(me.user.name);
  let when: string | null = null;
  let title: string;
  let lead: string;
  let crew: string[];
  if (arriving) {
    title = t("members.arrival.title", { org: org?.name ?? "", name });
    lead = t("members.arrival.lead", { channel: channelName });
    crew = dir.agents.slice(0, CREW).map((a) => a.id);
  } else {
    const since = greeting.last ?? Date.now();
    const activity = agentActivitySince(messages ?? [], since);
    const names = joinNames(
      activity.agentIds.slice(0, 3).map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent")),
      t,
    );
    const waiting = overview.data?.approvalsWaitingForMe ?? 0;
    when = t("sky.welcome.lastVisit", { when: whenAt(t, i18n.language, new Date(since).toISOString()) });
    title = t(`sky.welcome.${dayPart(new Date().getHours())}`, { name });
    lead = [
      activity.count === 0
        ? t("sky.welcome.quiet")
        : activity.agentIds.length === 1
          ? t("sky.welcome.activityOne", { names, count: activity.count })
          : t("sky.welcome.activityMany", { names, count: activity.count }),
      waiting > 0 ? t("sky.welcome.approvals", { count: waiting }) : null,
    ]
      .filter(Boolean)
      .join(" ");
    crew = (activity.agentIds.length ? activity.agentIds : agentIds).slice(0, CREW);
  }

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.at, { top }, style]}
        accessibilityRole="summary"
        accessibilityLabel={[when, title, lead].filter(Boolean).join(". ")}
      >
        <View style={[styles.card, surface]}>
          <WorkspaceSky style={StyleSheet.absoluteFill} />
          <View style={styles.head}>
            <View style={styles.grow}>
              {when ? (
                <Text variant="footnote" tone="muted" numberOfLines={1}>
                  {when}
                </Text>
              ) : null}
              <Text variant="title" numberOfLines={2}>
                {title}
              </Text>
            </View>
            <IconButton icon="x" label={t("sky.welcome.dismiss")} onPress={putAway} />
          </View>
          <Text variant="subhead" tone="ink2" numberOfLines={3} style={styles.lead}>
            {lead}
          </Text>
          {crew.length > 0 ? (
            <View style={styles.crew} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {crew.map((id) => (
                <AgentFace key={id} agentId={id} size={36} framed />
              ))}
            </View>
          ) : null}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // On the 16 margin, under the bar, over the conversation.
  at: { position: "absolute", left: 16, right: 16, zIndex: 20 },
  // The app's card (radius 20, raised, the lit top), the sky inside it.
  card: { borderRadius: 20, overflow: "hidden", padding: 16, gap: 8 },
  // The close sits on the title's first line (never centered beside two lines).
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  lead: { marginTop: -2 },
  crew: { flexDirection: "row", gap: 8, marginTop: 4 },
});
