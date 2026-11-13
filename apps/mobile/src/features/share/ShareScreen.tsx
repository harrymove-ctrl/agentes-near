import { keys, useApi } from "@agenteschat/client";
import { makesAgents } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { type NativeStackNavigationOptions, useNavigation } from "expo-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  fieldText,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  haptics,
  Icon,
  PixelOrbit,
  SheetSurface,
  Text,
  useReducedMotion,
  useTheme,
} from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { askTargets } from "../new/logic";
import { AgentFace } from "../shared/Face";
import { useDirectory, useErrorToast, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { useConversations } from "../shared/queries";
import { handShare } from "./handoff";
import { clearShare, SHARE_MAX_FILES, type Shared, type SharedFile, shareMessage, useShared } from "./inbox";

/** The sheet at rest shows what came and the first agents; typing the line takes the whole screen. */
const DETENTS_REST = [0.72, 1];
const DETENTS_TYPING = [1];
const FACE = 36;
const THUMB = 64;
/** Thumbnails shown; past them, "+N" on the last one. */
const THUMBS = 4;
/** How long the agent's face takes to catch what was sent before its conversation opens. */
const CATCH_MS = 280;
/** Shared, nothing arrived from the system after this long: say there's nothing to send. */
const WAIT_MS = 3000;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * "Compartilhar com…": what another app shared through the system's share sheet (photos, a video, documents, a link,
 * some text), sent to one agent. On top, what came (thumbnails, file names, the text), then an optional line of your
 * own, then the agents, the one you talk to most recently first, faces at 36; one tap picks, "Enviar para Dora" sends.
 * Sending, the agent's face catches it (a short pop, its "thinking" look, one light tap) and its conversation opens,
 * where the photos and the words go out through the conversation's own sending, so the agent starts reading at once.
 */
export function ShareScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const reduced = useReducedMotion();
  const { colors } = useTheme();
  const api = useApi();
  const orgId = useOrgId();
  const creates = makesAgents(useOrg().org);
  const qc = useQueryClient();
  const failed = useErrorToast();
  const dir = useDirectory();
  const list = useConversations();
  const shared = useShared();
  const agents = useMemo(() => askTargets(dir.agents, list.rows), [dir.agents, list.rows]);
  const [to, setTo] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [typing, setTyping] = useState(false);
  const [sending, setSending] = useState(false);
  // The system hands the share over a moment after the app opens: wait for it, then say there's nothing.
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (shared) return;
    const timer = setTimeout(() => setGaveUp(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, [shared]);

  useEffect(() => {
    const options: NativeStackNavigationOptions = { sheetAllowedDetents: typing ? DETENTS_TYPING : DETENTS_REST };
    navigation.setOptions(options);
  }, [navigation, typing]);

  // What came moves toward the agent as the face catches it: one gesture, the preview leading into the face.
  const sent = useSharedValue(0);
  const previewStyle = useAnimatedStyle(() => ({
    opacity: 1 - sent.get() * 0.6,
    transform: [{ translateY: sent.get() * 12 }, { scale: 1 - sent.get() * 0.04 }],
  }));

  const picked = agents.find((a) => a.id === to) ?? null;
  const cancel = () => {
    Keyboard.dismiss();
    clearShare();
    goBack();
  };
  const send = async () => {
    if (!shared || !picked || sending) return;
    Keyboard.dismiss();
    setSending(true);
    haptics.light();
    const started = Date.now();
    sent.set(reduced ? 1 : withTiming(1, { duration: CATCH_MS - 60, easing: EASE_OUT }));
    try {
      const { channelId } = await api.dms.open(orgId, { agentId: picked.id });
      void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
      handShare({ channelId, files: shared.files.slice(0, SHARE_MAX_FILES), text: shareMessage(line, shared) });
      clearShare();
      // The catch plays out (it started with the tap), then the conversation: no wait added past a slow network.
      const rest = reduced ? 0 : Math.max(0, CATCH_MS - (Date.now() - started));
      setTimeout(() => router.replace(chatHref(channelId)), rest);
    } catch (e) {
      sent.set(withTiming(0, { duration: 160, easing: EASE_OUT }));
      setSending(false);
      failed(e);
    }
  };

  return (
    <SheetSurface>
      <View style={styles.fill}>
        <ScrollView
          style={styles.fill}
          // The bar rides pinned at the top of this scroll view: a form sheet tracks its first scroll view, so nothing
          // may stand before it (a bar above it is drawn under the list).
          stickyHeaderIndices={[0]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.scroll}
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
              {t("mobile.share.title")}
            </Text>
            <View style={styles.side} />
          </SheetBar>
          <View style={styles.content}>
            {!shared ? (
              gaveUp ? (
                <EmptyState size="inline" title={t("mobile.share.nothing")} subtitle={t("mobile.share.nothingHint")} />
              ) : (
                <View style={styles.waiting}>
                  <PixelOrbit color="sky" size={16} />
                  <Text variant="subhead" tone="muted">
                    {t("mobile.share.waiting")}
                  </Text>
                </View>
              )
            ) : (
              <>
                <Animated.View style={previewStyle}>
                  <Preview shared={shared} />
                </Animated.View>
                <View
                  style={[
                    styles.field,
                    { backgroundColor: colors.raised, boxShadow: `0px 0px 0px 0.5px ${colors.line2}` },
                  ]}
                >
                  <TextInput
                    value={line}
                    onChangeText={setLine}
                    placeholder={t("mobile.share.line")}
                    placeholderTextColor={colors.faint}
                    onFocus={() => setTyping(true)}
                    onBlur={() => setTyping(false)}
                    returnKeyType="done"
                    submitBehavior="blurAndSubmit"
                    multiline={false}
                    editable={!sending}
                    style={[styles.input, fieldText("body"), { color: colors.ink }]}
                  />
                </View>
                {agents.length > 0 ? (
                  <>
                    <GroupedHeader>{t("mobile.share.to")}</GroupedHeader>
                    <GroupedList>
                      {agents.map((a) => (
                        <GroupedRow
                          key={a.id}
                          leading={<CatchingFace agentId={a.id} catching={sending && a.id === to} />}
                          label={a.name}
                          {...(a.role?.trim() ? { sub: a.role.trim() } : {})}
                          checked={a.id === to}
                          disabled={sending}
                          onPress={() => {
                            haptics.selection();
                            setTo(a.id);
                          }}
                        />
                      ))}
                    </GroupedList>
                  </>
                ) : !dir.loading ? (
                  <EmptyState
                    size="inline"
                    title={t("mobile.share.noAgents")}
                    subtitle={t("mobile.share.noAgentsHint")}
                    action={
                      creates ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          label={t("mobile.share.createAgent")}
                          onPress={() => router.replace("/new-agent")}
                        />
                      ) : undefined
                    }
                  />
                ) : null}
              </>
            )}
          </View>
        </ScrollView>
        {shared ? (
          <View style={[styles.bar, { paddingBottom: 12 + insets.bottom, backgroundColor: colors.grouped }]}>
            <Button
              variant="primary"
              wide
              label={picked ? t("mobile.share.send", { name: picked.name }) : t("mobile.share.pick")}
              disabled={!picked || sending}
              loading={sending}
              onPress={() => void send()}
            />
          </View>
        ) : null}
      </View>
    </SheetSurface>
  );
}

/** The sheet's bar, on the sheet's own color so the list passes under it when pinned. */
function SheetBar({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[styles.head, { backgroundColor: colors.grouped }]}>{children}</View>;
}

/**
 * The agent's face in its row. Catching what was sent: it pops a little (in fast, settling on a soft spring) and takes
 * its "thinking" look, already reading. Under reduced motion only the look changes.
 */
function CatchingFace({ agentId, catching }: { agentId: string; catching: boolean }) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  useEffect(() => {
    if (!catching || reduced) return;
    scale.set(
      withSequence(
        withTiming(1.14, { duration: 140, easing: EASE_OUT }),
        withSpring(1, { duration: 360, dampingRatio: 0.55 }),
      ),
    );
  }, [catching, reduced, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <Animated.View style={style}>
      <AgentFace agentId={agentId} size={FACE} mode={catching ? "think" : "idle"} live={catching} />
    </Animated.View>
  );
}

/** What came: up to four thumbnails ("+N" on the last), the other files as named lines, then the text. */
function Preview({ shared }: { shared: Shared }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const files = shared.files.slice(0, SHARE_MAX_FILES);
  const pictures = files.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
  const others = files.filter((f) => !pictures.includes(f));
  const shown = pictures.slice(0, THUMBS);
  const extra = pictures.length - shown.length;
  return (
    <View style={[styles.preview, { backgroundColor: colors.raised }]}>
      {shown.length > 0 ? (
        <View style={styles.thumbs}>
          {shown.map((f, i) => (
            <Thumb key={f.uri} file={f} more={i === shown.length - 1 && extra > 0 ? extra : 0} />
          ))}
        </View>
      ) : null}
      {others.map((f) => (
        <View key={f.uri} style={styles.fileLine}>
          <Icon name="file" size={17} color={colors.muted} />
          <Text variant="body" numberOfLines={1} ellipsizeMode="middle" style={styles.grow}>
            {f.name}
          </Text>
        </View>
      ))}
      {shared.text ? (
        <Text variant="subhead" tone="muted" numberOfLines={3}>
          {shared.text}
        </Text>
      ) : null}
      {shared.files.length > SHARE_MAX_FILES ? (
        <Text variant="footnote" tone="faint">
          {t("mobile.share.firstTen", { count: SHARE_MAX_FILES })}
        </Text>
      ) : null}
    </View>
  );
}

function Thumb({ file, more }: { file: SharedFile; more: number }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[styles.thumb, { backgroundColor: colors.sunken }]}>
      <Image source={{ uri: file.uri }} contentFit="cover" transition={0} style={StyleSheet.absoluteFill} />
      {file.type.startsWith("video/") ? (
        <View style={styles.play}>
          <Icon name="play" size={14} color="#fff" />
        </View>
      ) : null}
      {more > 0 ? (
        <View style={styles.more}>
          <Text variant="title" style={styles.moreText} maxFontSizeMultiplier={1.3}>
            {t("mobile.share.more", { count: more })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  // The sheet's bar as "Novo"'s: Cancelar at the left, the title centered, clear of the grabber.
  head: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 50, marginTop: 14, paddingHorizontal: 16 },
  cancel: { minWidth: 72, minHeight: 44, justifyContent: "center" },
  title: { flex: 1, textAlign: "center" },
  side: { minWidth: 72 },
  pressed: { opacity: 0.6 },
  waiting: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 32 },
  // 16 from the edges; the preview and the line 12 apart, the list's own header bringing its room above it.
  scroll: { paddingBottom: 24 },
  content: { paddingHorizontal: 16, paddingTop: 8 },
  // What came, on a white card on the sheet's gray: thumbnails, names and text 8 apart.
  preview: { borderRadius: 20, borderBottomLeftRadius: 6, padding: 12, gap: 8, marginBottom: 12 },
  thumbs: { flexDirection: "row", gap: 8 },
  // Concentric with the card: its 20 corner less the 12 inside.
  thumb: { width: THUMB, height: THUMB, borderRadius: 8, overflow: "hidden" },
  play: {
    position: "absolute",
    right: 4,
    bottom: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  more: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  moreText: { color: "#fff", fontVariant: ["tabular-nums"] },
  fileLine: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 },
  field: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: 14, borderRadius: 14 },
  input: { flex: 1, minWidth: 0, paddingVertical: 0 },
  bar: { paddingHorizontal: 16, paddingTop: 12 },
});
