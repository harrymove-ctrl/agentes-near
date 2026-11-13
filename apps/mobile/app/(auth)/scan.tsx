import { checkServer, parseConnectLink, serverHost } from "@agenteschat/client/lib/server";
import { skyHourOf, workspaceInk } from "@agenteschat/ui/sky/workspace";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Linking, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { ALLOW_HTTP } from "@/lib/server";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { Glass } from "@/ui/Glass";
import { haptics } from "@/ui/haptics";
import { Icon } from "@/ui/Icon";
import { IconButton } from "@/ui/IconButton";
import { router } from "@/ui/navigation";
import { Text } from "@/ui/Text";
import { useReducedMotion } from "@/ui/theme";

/** The target: a square of this side, its four corners marked. */
const TARGET = 236;
/** Each corner is an L of three 4-point pixels, the app's own grid. */
const PX = 4;
/** How long the read card stays at least, so the moment reads before the confirmation comes. */
const READ_MS = 900;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const CARD_IN = FadeInDown.duration(240).easing(EASE_OUT);
const LINE_OUT = FadeOut.duration(160).easing(EASE_OUT);
const CORNERS_IN = FadeIn.duration(300).easing(EASE_OUT);
/**
 * The read locks on: the four corners close in on the code, a short settle with a hint of give (the code "caught"),
 * on the same frame as the success tap. The scale is the corners', never the camera's.
 */
const LOCKED = 0.86;
const LOCK = { duration: 380, dampingRatio: 0.78 } as const;

/**
 * Escanear QR code: the camera, a target of four pixel corners and one glass line of help. Reads QR codes only. A
 * connect link turns the corners the color of that server's sky and puts its card over the line (the agent at work,
 * the address, "Conferindo o servidor…"), then goes on to its confirmation (`/connect`): the app never changes server
 * on a read alone. Any other code says it isn't one of ours.
 */
export default function Scan() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [permission, requestPermission, readPermission] = useCameraPermissions();
  const [notOurs, setNotOurs] = useState(false);
  const [read, setRead] = useState<{ server: string; token?: string } | null>(null);
  const done = useRef(false);
  const lock = useSharedValue(1);
  const lockStyle = useAnimatedStyle(() => ({ transform: [{ scale: lock.value }] }));

  // Back from Ajustes: Android keeps the app running when the camera is allowed there, so read it again.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void readPermission();
    });
    return () => sub.remove();
  }, [readPermission]);

  // Read: the server is asked once here (the confirmation asks again), and the card stays its moment either way.
  useEffect(() => {
    if (!read) return;
    let alive = true;
    const started = Date.now();
    void checkServer(read.server)
      .catch(() => null)
      .then(() => {
        if (!alive) return;
        const wait = Math.max(0, READ_MS - (Date.now() - started));
        setTimeout(() => {
          if (alive) router.replace({ pathname: "/connect", params: read });
        }, wait);
      });
    return () => {
      alive = false;
    };
  }, [read]);

  if (!permission) return null;
  if (!permission.granted)
    return (
      <AuthScaffold
        title={t("mobile.auth.scan.cameraTitle")}
        subtitle={t("mobile.auth.scan.cameraText")}
        onBack={() => router.back()}
      >
        {permission.canAskAgain ? (
          <Button variant="primary" wide label={t("mobile.auth.scan.allow")} onPress={() => void requestPermission()} />
        ) : (
          <Button
            variant="primary"
            wide
            label={t("mobile.auth.scan.settings")}
            onPress={() => void Linking.openSettings()}
          />
        )}
      </AuthScaffold>
    );

  const host = read ? serverHost(read.server) : "";
  // The corners take the tone of that server's sky once read: dusk on a team's own, day on the Cloud.
  const tone = read ? workspaceInk(skyHourOf(host), "#000000").bright : "#ffffff";

  return (
    <View style={styles.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const link = parseConnectLink(data, { allowHttp: ALLOW_HTTP });
          if (!link) return setNotOurs(true);
          done.current = true;
          // The read is the moment: the corners lock on and take the server's color, with one success tap on that
          // frame; nothing more until the confirmation.
          if (!reduced) lock.value = withSpring(LOCKED, LOCK);
          haptics.success();
          setRead(link);
        }}
      />
      <View style={styles.center} pointerEvents="none">
        <Animated.View style={lockStyle}>
          <Animated.View
            key={read ? "read" : "aim"}
            entering={reduced ? undefined : CORNERS_IN}
            style={styles.target}
            accessibilityElementsHidden
          >
            <Corner tone={tone} at="tl" />
            <Corner tone={tone} at="tr" />
            <Corner tone={tone} at="br" />
            <Corner tone={tone} at="bl" />
          </Animated.View>
        </Animated.View>
      </View>
      <View style={[styles.back, { top: insets.top + 8 }]}>
        <IconButton icon="back" label={t("mobile.common.back")} onPress={() => router.back()} plate />
      </View>
      {read ? (
        <Animated.View
          entering={reduced ? undefined : CARD_IN}
          style={[styles.card, { bottom: insets.bottom + 24 }]}
          accessibilityLiveRegion="polite"
        >
          <Glass style={styles.cardGlass}>
            <AgentAvatar agent={{ color: "sky", eyes: "round", id: "agentes" }} size={36} mode="run" />
            <View style={styles.cardText}>
              <Text variant="body" numberOfLines={1} ellipsizeMode="middle" style={styles.bold}>
                {host}
              </Text>
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {t("mobile.auth.connect.checking")}
              </Text>
            </View>
            <Icon name="check" size={18} color={tone} />
          </Glass>
        </Animated.View>
      ) : (
        <Animated.View
          exiting={reduced ? undefined : LINE_OUT}
          style={[styles.hint, { bottom: insets.bottom + 24 }]}
          accessibilityLiveRegion="polite"
        >
          <Glass style={styles.hintGlass}>
            <Text variant="subhead" tone={notOurs ? "danger" : undefined} style={styles.hintText}>
              {notOurs ? t("mobile.auth.scan.notOurs") : t("mobile.auth.scan.hint")}
            </Text>
          </Glass>
          {/* The camera comes first (a team's computer shows the code); the address stays one tap away. */}
          <Pressable
            onPress={() => router.replace("/server")}
            accessibilityRole="button"
            hitSlop={12}
            style={({ pressed }) => [styles.type, pressed && styles.pressed]}
          >
            <Text variant="subhead" style={styles.typeText}>
              {t("mobile.auth.scan.typeAddress")}
            </Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

/** One corner of the target: an L of three pixels (two along each edge, one shared), in `tone`. */
function Corner({ tone, at }: { tone: string; at: "tl" | "tr" | "br" | "bl" }) {
  const top = at === "tl" || at === "tr";
  const left = at === "tl" || at === "bl";
  // The L sits in its corner of the target, its arms along the two edges that meet there.
  const place: ViewStyle = {
    top: top ? 0 : undefined,
    bottom: top ? undefined : 0,
    left: left ? 0 : undefined,
    right: left ? undefined : 0,
  };
  return (
    <View style={[styles.corner, place]}>
      <View style={[styles.arm, place, { width: PX * 3, height: PX, backgroundColor: tone }]} />
      <View style={[styles.arm, place, { width: PX, height: PX * 3, backgroundColor: tone }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "black" },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  target: { width: TARGET, height: TARGET },
  corner: { position: "absolute", width: PX * 3, height: PX * 3 },
  arm: { position: "absolute" },
  back: { position: "absolute", left: 16 },
  hint: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  hintGlass: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxWidth: "100%" },
  hintText: { textAlign: "center" },
  type: { marginTop: 16, minHeight: 44, justifyContent: "center" },
  typeText: { color: "white", fontWeight: "600" },
  pressed: { opacity: 0.6 },
  card: { position: "absolute", left: 16, right: 16 },
  cardGlass: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  cardText: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
