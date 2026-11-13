import { markTerms } from "@agenteschat/client/lib/search-filters";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { type AgentPresetColor, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import { type NativeStackNavigationOptions, useIsFocused, useNavigation } from "expo-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BackHandler,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  EmptyState,
  fieldText,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  PixelOrbit,
  SheetSurface,
  Text,
  useReducedMotion,
  useTheme,
} from "@/ui";
import { router } from "@/ui/navigation";
import { busyAgents } from "../agents/logic";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory, useMeId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { goBack } from "../shared/parts";
import { useConversations, useWorkingNow } from "../shared/queries";
import { newWikiPage } from "../wiki/WikiScreen";
import { askTargets, type CreateItem, chatMatches, createItems } from "./logic";
import { useOpenDm } from "./useOpenDm";

/** The sheet's detents: two thirds over the list at rest; the whole screen once the keyboard is up. */
const DETENTS_REST = [0.66, 1];
const DETENTS_TYPING = [1];

/**
 * "New", the "+" of the tabs, as the system's new message: a sheet over the list (the native form sheet: it tracks
 * the finger, a drag or a flick puts it away, the screen behind steps back), on the grouped gray, "Cancelar" in its
 * corner and the "Para:" field on top (nothing focused until the person taps). Under it, everything as rows: what
 * to start, each with its icon on a soft tile of its color (found at a glance); the agents, the one you talked to
 * last first, a tap opening your conversation ready to type; then the people, and "Invite people" at their end.
 * Typing raises the sheet to the full detent with the keyboard and filters the same agents and people (what to
 * start steps aside); cancelling puts the sheet away.
 */
export function NewScreen() {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { colors } = useTheme();
  const { org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const list = useConversations();
  const busy = busyAgents(useWorkingNow());
  const openDm = useOpenDm();
  const field = useRef<TextInputInstance>(null);
  const [q, setQ] = useState("");
  const [typing, setTyping] = useState(false);
  const typed = q.trim();
  const recent = useMemo(() => askTargets(dir.agents, list.rows), [dir.agents, list.rows]);
  const found = useMemo(
    () => chatMatches(typed, dir.agents, dir.memberById.values(), meId),
    [typed, dir.agents, dir.memberById, meId],
  );
  // No words: the agents in the order you talk to them; words: the matches.
  const agents = typed ? found.agents : recent;
  const people = found.people;
  const ownsAgent = Boolean(meId) && dir.agents.some((a) => a.ownerUserId === meId);
  const items = createItems(org, { ownsAgent });
  const invite = !typed && items.includes("invite");

  const talkTo = (agentId: string) => void openDm({ agentId }, { compose: true, replace: true });
  const cancel = () => {
    Keyboard.dismiss();
    goBack();
  };

  // The keyboard up: the sheet rises to the whole screen (the system animates the detent change); down, it may rest
  // at two thirds again.
  useEffect(() => {
    const options: NativeStackNavigationOptions = { sheetAllowedDetents: typing ? DETENTS_TYPING : DETENTS_REST };
    navigation.setOptions(options);
  }, [navigation, typing]);

  // Android's back drops the keyboard first (as the field's blur does), not the sheet.
  useEffect(() => {
    if (!typing || !focused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      field.current?.blur();
      Keyboard.dismiss();
      return true;
    });
    return () => sub.remove();
  });

  // Groups that come and go as the person types fade, and what stays slides into place.
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);

  return (
    <SheetSurface>
      <ScrollView
        style={styles.fill}
        // The bar rides at the top of the scroll view, pinned: a form sheet tracks its first scroll view, so nothing may
        // stand before it (a bar above it was drawn under the list).
        stickyHeaderIndices={[0]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
      >
        <SheetBar>
          <Pressable
            onPress={cancel}
            accessibilityRole="button"
            hitSlop={10}
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          >
            <Text variant="body" tone="ink2">
              {t("mobile.common.cancel")}
            </Text>
          </Pressable>
          <Text variant="title" style={styles.title} accessibilityRole="header" numberOfLines={1}>
            {t("mobile.new.title")}
          </Text>
          <View style={styles.side} />
        </SheetBar>
        <Animated.View layout={layout}>
          {/* "Para:" and the words, white with a hairline on the gray, as the system's new message. */}
          <View style={styles.search}>
            <View
              style={[styles.field, { backgroundColor: colors.raised, boxShadow: `0px 0px 0px 0.5px ${colors.line2}` }]}
            >
              <Text variant="body" tone="muted">
                {t("mobile.new.to")}
              </Text>
              <TextInput
                ref={field}
                value={q}
                onChangeText={setQ}
                onFocus={() => setTyping(true)}
                onBlur={() => setTyping(false)}
                placeholder={t("mobile.new.search")}
                placeholderTextColor={colors.faint}
                accessibilityLabel={t("mobile.new.chatSearch")}
                autoCorrect={false}
                autoCapitalize="words"
                returnKeyType="search"
                selectionColor={colors.agent}
                style={[styles.input, fieldText("body"), { color: colors.ink }]}
              />
            </View>
          </View>
          <View style={styles.lists}>
            {!typed ? (
              <Animated.View {...fade} layout={layout}>
                <CreateList items={items.filter((i) => i !== "invite")} />
              </Animated.View>
            ) : null}
            {agents.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <GroupedHeader>{t("mobile.find.agents")}</GroupedHeader>
                <GroupedList>
                  {agents.map((a) => {
                    const working = busy.has(a.id);
                    // Who works shows the orbit and the word in the value's place; nobody gets a tag.
                    return (
                      <GroupedRow
                        key={a.id}
                        leading={<AgentFace agentId={a.id} size={FACE} mode={working ? "run" : "idle"} live={false} />}
                        label={a.name}
                        {...(typed ? { labelParts: markTerms(a.name, [typed]) } : {})}
                        {...(a.role?.trim() ? { sub: a.role.trim() } : {})}
                        {...(working
                          ? {
                              value: t("taskManager.state.working"),
                              valueLeading: <PixelOrbit color={agentLook(a).color} size={12} />,
                            }
                          : {})}
                        chevron
                        onPress={() => talkTo(a.id)}
                      />
                    );
                  })}
                </GroupedList>
              </Animated.View>
            ) : null}
            {people.length > 0 || invite ? (
              <Animated.View {...fade} layout={layout}>
                <GroupedHeader>{t("mobile.new.people")}</GroupedHeader>
                <GroupedList>
                  {people.map((p) => (
                    <GroupedRow
                      key={p.userId}
                      leading={<Face who={{ type: "person", id: p.userId }} size={FACE} />}
                      label={p.name}
                      {...(typed ? { labelParts: markTerms(p.name, [typed]) } : {})}
                      chevron
                      // As an agent's: the conversation opens ready to type.
                      onPress={() => void openDm({ userId: p.userId }, { compose: true, replace: true })}
                    />
                  ))}
                  {invite ? (
                    <GroupedRow
                      leading={<TintTile icon="members" color="teal" />}
                      label={t("members.inviteTitle")}
                      sub={t("mobile.new.inviteHint")}
                      chevron
                      onPress={() => router.push("/invite-people")}
                    />
                  ) : null}
                </GroupedList>
              </Animated.View>
            ) : null}
            {typed && agents.length + people.length === 0 && !dir.loading ? (
              <EmptyState size="inline" title={t("mobile.find.nothing", { q: typed })} />
            ) : null}
          </View>
        </Animated.View>
      </ScrollView>
    </SheetSurface>
  );
}

/** Each thing to start has a color of its own, so it is found without reading. */
const CREATE_LOOK: Record<Exclude<CreateItem, "invite">, { icon: IconName; color: AgentPresetColor }> = {
  agent: { icon: "agent", color: "violet" },
  channel: { icon: "hash", color: "sky" },
  task: { icon: "checkc", color: "green" },
  routine: { icon: "clock", color: "amber" },
  wiki: { icon: "file", color: "graphite" },
};

/**
 * What to start, as rows: a soft tile of its color, a short name and a hint under it. A personal workspace's channel
 * is a group conversation, and its wiki is for its person's agents (ADR 0159).
 */
function CreateList({ items }: { items: CreateItem[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // The short names reuse labels already translated in every language (a form field's or a screen's name elsewhere).
  const spec: Record<Exclude<CreateItem, "invite">, { label: string; sub: string; onPress: () => void }> = {
    agent: { label: t("missions.new.agent"), sub: t("mobile.new.agentHint"), onPress: () => router.push("/new-agent") },
    channel: {
      label: isPersonal(org) ? t("mobile.new.channelPersonal") : t("missions.new.channel"),
      sub: t(modeKey(org, "mobile.chats.newChannelHint")),
      onPress: () => router.push("/new-channel"),
    },
    task: { label: t("mobile.agent.task"), sub: t("mobile.new.taskHint"), onPress: () => router.push("/issues/new") },
    routine: {
      label: t("routines.panel.eyebrow"),
      sub: t("mobile.new.routineHint"),
      onPress: () => router.push("/routines/new"),
    },
    wiki: {
      label: t("mobile.new.wikiPage"),
      sub: t(modeKey(org, "mobile.new.wikiHint")),
      onPress: () => newWikiPage(),
    },
  };
  const create = items.filter((i): i is Exclude<CreateItem, "invite"> => i !== "invite");
  if (create.length === 0) return null;
  return (
    <>
      <GroupedHeader>{t("mobile.new.create")}</GroupedHeader>
      <GroupedList>
        {create.map((item) => (
          <GroupedRow key={item} leading={<TintTile {...CREATE_LOOK[item]} />} {...spec[item]} subLines={2} chevron />
        ))}
      </GroupedList>
    </>
  );
}

/** An icon on a soft tile of its color: the color's light tone over the row, its deep tone for the glyph. */
function TintTile({ icon, color }: { icon: IconName; color: AgentPresetColor }) {
  const { colors, scheme } = useTheme();
  const [light, deep] = gradientOf(color);
  const dark = scheme === "dark";
  return (
    <View style={[styles.tint, { backgroundColor: mixHex(colors.raised, light, dark ? 0.3 : 0.45) }]}>
      <Icon name={icon} size={16} color={dark ? light : deep} />
    </View>
  );
}

/** The faces in the rows: framed in their skies at 36 (the list's small size); the tiles match them. */
const FACE = 36;
/** The sheet's bar, on the sheet's own color so the list passes under it when pinned. */
function SheetBar({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[styles.head, { backgroundColor: colors.grouped }]}>{children}</View>;
}

const TILE = 36;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The sheet's bar: Cancelar at the left, the title centered, 50 tall, clear of the grabber (5 tall at 5 from the top).
  head: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 50, marginTop: 14, paddingHorizontal: 16 },
  cancel: { minWidth: 72, minHeight: 44, justifyContent: "center" },
  title: { flex: 1, textAlign: "center" },
  side: { minWidth: 72 },
  pressed: { opacity: 0.6 },
  search: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  field: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 14, borderRadius: 14 },
  input: { flex: 1, minWidth: 0, paddingVertical: 0 },
  lists: { paddingHorizontal: 16, paddingBottom: 24 },
  tint: {
    width: TILE,
    height: TILE,
    // Proportional, as the faces' tiles beside it.
    borderRadius: Math.round(TILE * 0.3),
    alignItems: "center",
    justifyContent: "center",
  },
});
