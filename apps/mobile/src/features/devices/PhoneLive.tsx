import type { DesktopMode, PhoneDevice, SocketLike } from "@agenteschat/client";
import { desktopRetryMs } from "@agenteschat/client";
import {
  controlRefusalText,
  mayTakePhone,
  PHONE_TEXT_MAX,
  type PhoneScreenState,
  personInControl,
  phoneCloseState,
  phoneScreenAway,
  phoneScreenCover,
  phoneScreenUrl,
  screenGesture,
} from "@agenteschat/client/lib/devices";
import { firstName } from "@agenteschat/client/lib/format";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { createSocketFactory } from "@/lib/socket";
import { useAppActive } from "@/lib/useAppActive";
import { Button, CARD_PAD, fieldText, IconButton, SCREEN_X, Text, useToast } from "@/ui";
import { useColors, useMeId, useOrgId } from "../shared/hooks";

/** A phone's screen before its first picture: a common phone's shape. */
const PHONE_SHAPE = { width: 9, height: 19.5 };

/**
 * A phone's screen live on its page in the app, as on the web (`PhoneLive` there): watching it in place for whoever
 * may use it; Take control opens it full screen for whoever may take it, where a tap taps, a drag swipes, the field
 * types and an Android phone gets Back and Home. Closing it gives it back (an agent holding it goes on). Its pictures
 * come as base64 text frames, which the image view takes as they are.
 */
export function PhoneLive({ phone: p, host }: { phone: PhoneDevice; host: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const orgId = useOrgId();
  const meId = useMeId();
  const active = useAppActive();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<DesktopMode>("watch");
  const [view, setView] = useState<PhoneScreenState>("connecting");
  const [frame, setFrame] = useState<string | null>(null);
  const [shape, setShape] = useState(PHONE_SHAPE);
  const [round, setRound] = useState(0);
  const [text, setText] = useState("");
  const socketRef = useRef<SocketLike | null>(null);
  const attempts = useRef(0);
  const box = useRef({ width: 1, height: 1 });
  const down = useRef<{ x: number; y: number; at: number } | null>(null);
  const s = p.status;
  // A phone that can't show opens nothing (offline, or waiting on its person): the list says when that changes.
  const away = phoneScreenAway(p);
  const controller = personInControl(s);
  const mayTake = meId !== null && mayTakePhone(p, meId);
  const agent = s.kind === "in_use" && s.agentId ? (s.agentName ?? p.name) : null;
  const person = s.kind === "in_use" && s.userName ? firstName(s.userName) : null;

  // `t`, `toast` and the names only word a close: a new socket for them would drop the screen for nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!p.mayUse || away || !active) return;
    let done = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // A new stream (control taken, given back) shows nothing of its own until its first picture: an iPhone's test
    // helper starts in several seconds, and input before then would go nowhere.
    setView("connecting");
    const socket = createSocketFactory(lastCookie)(
      phoneScreenUrl(serverUrl(), { orgId, phoneId: p.id, mode, text: true }),
    );
    socketRef.current = socket;
    socket.onmessage = (ev) => {
      if (done || typeof ev.data !== "string") return;
      // A JPEG's base64 starts with "/9j/", a PNG's with "iVBOR".
      setFrame(`data:image/${ev.data.startsWith("/9j/") ? "jpeg" : "png"};base64,${ev.data}`);
      attempts.current = 0;
      setView("live");
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "ack" }));
    };
    socket.onclose = (ev) => {
      if (done) return;
      socketRef.current = null;
      const next = phoneCloseState(ev.code, (ev as { reason?: string }).reason ?? "");
      // A watcher meets these only when the phone itself can't be used: opening again at once would loop.
      if (next.control && mode === "control") {
        toast({
          title: controlRefusalText(t, next.control, { host, name: p.name, agent: agent ?? p.name }),
          icon: next.control === "lost" ? "check" : "x",
        });
        setMode("watch");
        return;
      }
      if (next.control) return setView("unavailable");
      setView(next.state);
      if (next.retry === "now") setRound((r) => r + 1);
      else if (next.retry === "later")
        retry = setTimeout(() => setRound((r) => r + 1), desktopRetryMs(attempts.current++));
    };
    return () => {
      done = true;
      clearTimeout(retry);
      socket.onclose = null;
      socket.onmessage = null;
      socket.close(1000);
      socketRef.current = null;
    };
  }, [orgId, p.id, p.mayUse, away, active, mode, round]);

  const send = (f: object) => {
    const socket = socketRef.current;
    if (mode === "control" && socket?.readyState === 1) socket.send(JSON.stringify(f));
  };
  // A picture wider than the room left for it (a phone turned sideways, a tablet) sits letterboxed in its frame.
  const point = (e: GestureResponderEvent) => {
    const { width, height } = box.current;
    const k = Math.min(width / shape.width, height / shape.height);
    const w = shape.width * k;
    const h = shape.height * k;
    return {
      x: (e.nativeEvent.locationX - (width - w) / 2) / w,
      y: (e.nativeEvent.locationY - (height - h) / 2) / h,
      at: e.nativeEvent.timestamp,
    };
  };
  const typeIt = () => {
    const words = text.slice(0, PHONE_TEXT_MAX);
    if (!words) return;
    send({ type: "text", text: words });
    setText("");
  };
  const live = view === "live" && frame !== null;
  const cover = phoneScreenCover(t, view, p, host);
  const banner = controller
    ? t("devices.screen.personControls", { name: person ?? "" })
    : agent
      ? person
        ? t("devices.screen.agentUsesFor", { agent, person })
        : t("devices.screen.agentUses", { agent })
      : null;
  const help =
    agent && !controller
      ? mayTake
        ? t("devices.screen.takeHint", { agent })
        : t("devices.screen.noTake", { agent })
      : null;

  const screen = (control: boolean) => (
    <View
      style={[
        control ? styles.frameFull : styles.frame,
        { aspectRatio: shape.width / shape.height, backgroundColor: c.sunken },
      ]}
      onLayout={(e) => {
        box.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
      }}
      accessible
      accessibilityLabel={t("devices.screen.label", { name: p.name })}
      onStartShouldSetResponder={() => control && live}
      onMoveShouldSetResponder={() => control && live}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        down.current = point(e);
      }}
      onResponderRelease={(e) => {
        const from = down.current;
        down.current = null;
        if (from) send(screenGesture(from, point(e)));
      }}
    >
      {frame ? (
        <Image
          source={{ uri: frame }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          fadeDuration={0}
          onLoad={(e) => {
            const { width, height } = e.nativeEvent.source;
            if (width > 0 && height > 0 && (width !== shape.width || height !== shape.height))
              setShape({ width, height });
          }}
        />
      ) : null}
      {cover ? (
        // The last picture stays under the cover, faded by the page's own colour.
        <View style={[styles.cover, { backgroundColor: frame ? `${c.bg}d9` : "transparent" }]}>
          {cover.spinner ? <ActivityIndicator color={c.muted} /> : null}
          <Text variant="subhead" tone="ink" style={styles.center}>
            {cover.title}
          </Text>
          {cover.text ? (
            <Text variant="footnote" tone="muted" style={styles.center}>
              {cover.text}
            </Text>
          ) : null}
          {cover.retry ? (
            <Button variant="secondary" size="sm" label={t("common.retry")} onPress={() => setRound((r) => r + 1)} />
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={styles.wrap}>
      {banner ? (
        <View style={styles.banner}>
          <Text variant="footnote" tone="ink" style={styles.center}>
            {banner}
          </Text>
          {help ? (
            <Text variant="footnote" tone="muted" style={styles.center}>
              {help}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.inline}>{mode === "watch" ? screen(false) : null}</View>
      {mayTake && !controller && live && mode === "watch" ? (
        <Button variant="secondary" wide label={t("devices.screen.take")} onPress={() => setMode("control")} />
      ) : null}
      <Modal
        visible={mode === "control"}
        animationType="slide"
        presentationStyle="fullScreen"
        supportedOrientations={["portrait", "landscape"]}
        onRequestClose={() => setMode("watch")}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={[styles.full, { backgroundColor: c.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}
        >
          <View style={styles.bar}>
            <Text variant="title" tone="ink" style={styles.grow} numberOfLines={2}>
              {t("devices.screen.yours")}
            </Text>
            <Button variant="primary" size="sm" label={t("devices.screen.give")} onPress={() => setMode("watch")} />
          </View>
          <View style={styles.stage}>{mode === "control" ? screen(true) : null}</View>
          <View style={styles.tools}>
            {p.platform === "android" ? (
              <>
                <IconButton icon="back" label={t("common.back")} onPress={() => send({ type: "key", key: "back" })} />
                <IconButton
                  icon="home"
                  label={t("devices.screen.home")}
                  onPress={() => send({ type: "key", key: "home" })}
                />
              </>
            ) : null}
            <TextInput
              value={text}
              onChangeText={setText}
              onSubmitEditing={typeIt}
              placeholder={t("devices.screen.typeLabel", { name: p.name })}
              placeholderTextColor={c.faint}
              accessibilityLabel={t("devices.screen.typeLabel", { name: p.name })}
              returnKeyType="send"
              autoCorrect={false}
              autoCapitalize="none"
              blurOnSubmit={false}
              editable={live}
              style={[fieldText("callout"), styles.input, { color: c.ink, backgroundColor: c.sunken }]}
            />
            <IconButton icon="send" label={t("mobile.app.send")} onPress={typeIt} disabled={!live || !text} />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12, paddingHorizontal: SCREEN_X },
  banner: { gap: 2, alignItems: "center" },
  inline: { alignItems: "center" },
  frame: { width: "62%", borderRadius: 20, overflow: "hidden" },
  frameFull: { height: "100%", maxWidth: "100%", borderRadius: 20, overflow: "hidden" },
  cover: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: CARD_PAD,
  },
  center: { textAlign: "center" },
  full: { flex: 1 },
  bar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: SCREEN_X, paddingVertical: 8 },
  grow: { flex: 1 },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SCREEN_X },
  tools: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: SCREEN_X, paddingVertical: 8 },
  input: { flex: 1, minWidth: 0, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
});
