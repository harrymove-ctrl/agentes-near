import { useArtifact } from "@agenteschat/client";
import { keepWhole } from "@agenteschat/client/lib/format";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName, PressScale, SCREEN_X, Text, ToastHost, useReducedMotion } from "@/ui";
import { useDirectory, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { savedAt, useFileActions, useSavedWhen } from "./actions";
import { decodeFileList, fileInfo, pageStep } from "./logic";
import { useRemoteFile } from "./source";
import { tellViewerPlace } from "./viewer-place";
import { ZoomableImage } from "./ZoomableImage";

/**
 * A message's pictures, full screen: black, the name, "2 de 4" and who sent it on top, pinch and double tap to
 * zoom, swipe or ‹ › on the sides between the pictures, drag down to close, and Compartilhar, Salvar em Fotos,
 * Ver no Drive at the bottom. A tap hides and shows the bars.
 */
export function ImageViewer({
  files: rawFiles,
  at,
  from,
}: {
  files: string | string[] | undefined;
  at: string | undefined;
  /** The stack it opened from, told where the person stops. */
  from?: string | undefined;
}) {
  return (
    // Toasts show inside the modal (the app's host sits under it).
    <ToastHost>
      <Viewer rawFiles={rawFiles} at={at} from={from} />
    </ToastHost>
  );
}

const WHITE = "#fff";
const DIM = "rgba(255,255,255,0.6)";
const PLATE = "rgba(255,255,255,0.14)";
/** ‹ and ›'s plate: they sit on the picture itself, and a white chevron on a light plate vanishes on a light picture. */
const SCRIM = "rgba(0,0,0,0.45)";
/** The round buttons over the picture. */
const ROUND = 44;

function Viewer({
  rawFiles,
  at,
  from,
}: {
  rawFiles: string | string[] | undefined;
  at: string | undefined;
  from: string | undefined;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const savedWhen = useSavedWhen();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const pager = useRef<ScrollViewInstance>(null);
  const files = decodeFileList(rawFiles);
  const first = Math.min(Math.max(Number(at) || 0, 0), Math.max(files.length - 1, 0));
  const [index, setIndex] = useState(first);
  const [zoomed, setZoomed] = useState(false);
  const [chrome, setChrome] = useState(true);
  const drag = useSharedValue(0);
  const current = files[index];
  const detail = useArtifact(orgId, current?.id ?? null, current?.version).data;
  const actions = useFileActions(detail);
  const close = () => goBack();
  useEffect(() => {
    if (from) tellViewerPlace(from, index);
  }, [from, index]);

  const onPage = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index && i >= 0 && i < files.length) setIndex(i);
  };
  const prev = pageStep(index, -1, files.length);
  const next = pageStep(index, 1, files.length);
  // The side buttons: the pager slides there (at once with reduced motion), as a swipe would.
  const turn = (to: number | null) => {
    if (to === null) return;
    setIndex(to);
    pager.current?.scrollTo({ x: to * width, y: 0, animated: !reduced });
  };

  const backdrop = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(Math.abs(drag.value) / (height * 0.6), 0.85),
  }));

  const info = detail ? fileInfo(detail) : null;
  const author = detail ? dir.nameOf(detail.createdBy) : "";
  const place = files.length > 1 ? t("mobile.files.place", { index: index + 1, count: files.length }) : "";
  const sub = detail
    ? [place, author, savedWhen(savedAt(detail))].filter(Boolean).map(keepWhole).join(" · ")
    : keepWhole(place);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" hidden={!chrome} animated />
      <Animated.View style={[StyleSheet.absoluteFill, styles.black, backdrop]} />
      <ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        scrollEnabled={!zoomed && files.length > 1}
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: first * width, y: 0 }}
        onMomentumScrollEnd={onPage}
        style={StyleSheet.absoluteFill}
      >
        {files.map((f, i) => (
          <Page
            key={`${f.id}@${f.version ?? ""}`}
            id={f.id}
            {...(f.version !== undefined ? { version: f.version } : {})}
            width={width}
            height={height}
            drag={drag}
            near={Math.abs(i - index) <= 1}
            onZoomChange={setZoomed}
            onTap={() => setChrome((v) => !v)}
            onDismiss={close}
          />
        ))}
      </ScrollView>

      <Chrome visible={chrome} drag={drag} style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Round icon="x" label={t("mobile.common.close")} onPress={close} />
        <View style={styles.spacer} />
        <Round icon="more" label={t("mobile.files.more")} onPress={() => actions.more(true)} disabled={!detail} />
        {/* The name and its line on a row of their own under the buttons, the screen's width: never cut beside them. */}
        <View style={styles.title}>
          <Text variant="subhead" style={[styles.bold, { color: WHITE }]} numberOfLines={3}>
            {info?.name ?? ""}
          </Text>
          <Text variant="footnote" style={{ color: DIM }}>
            {sub}
          </Text>
        </View>
      </Chrome>

      {/* Gone while zoomed, as the swipe is: the fingers move the picture then. */}
      {files.length > 1 ? (
        <Chrome visible={chrome && !zoomed} drag={drag} style={[styles.sides, { top: height / 2 - ROUND / 2 }]}>
          {prev !== null ? (
            <View style={[styles.side, { left: insets.left + 12 }]}>
              <Round icon="left" label={t("mobile.files.previous")} plate={SCRIM} onPress={() => turn(prev)} />
            </View>
          ) : null}
          {next !== null ? (
            <View style={[styles.side, { right: insets.right + 12 }]}>
              <Round icon="right" label={t("mobile.files.next")} plate={SCRIM} onPress={() => turn(next)} />
            </View>
          ) : null}
        </Chrome>
      ) : null}

      <Chrome visible={chrome} drag={drag} style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]}>
        <View style={styles.actions}>
          {detail?.inDrive !== false ? (
            <Action icon="person" label={t("share.button")} disabled={!detail} onPress={actions.shareSheet} />
          ) : null}
          <Action
            icon="share"
            label={t("mobile.files.send")}
            busy={actions.busy === "share"}
            disabled={!detail}
            onPress={actions.share}
          />
          <Action
            icon="photos"
            label={t("mobile.files.savePhotos")}
            busy={actions.busy === "photos"}
            disabled={!detail}
            onPress={actions.savePhotos}
          />
          <Action icon="drive" label={t("mobile.files.drive")} disabled={!detail} onPress={actions.drive} />
        </View>
      </Chrome>
    </View>
  );
}

function Page({
  id,
  version,
  width,
  height,
  drag,
  near,
  onZoomChange,
  onTap,
  onDismiss,
}: {
  id: string;
  version?: number;
  width: number;
  height: number;
  drag: SharedValue<number>;
  /** Only the pictures next to the one on screen load. */
  near: boolean;
  onZoomChange: (z: boolean) => void;
  onTap: () => void;
  onDismiss: () => void;
}) {
  const orgId = useOrgId();
  const link = useRemoteFile(orgId, near ? id : null, version);
  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      {link.data ? (
        <ZoomableImage
          uri={link.data.uri}
          headers={link.data.headers}
          cacheKey={`${id}@${version ?? "latest"}`}
          width={width}
          height={height}
          drag={drag}
          onZoomChange={onZoomChange}
          onTap={onTap}
          onDismiss={onDismiss}
        />
      ) : link.isError ? (
        <Icon name="image" size={30} color={DIM} />
      ) : (
        <ActivityIndicator color={WHITE} />
      )}
    </View>
  );
}

/** The bars: fade with a tap, and while the picture is dragged away. */
function Chrome({
  visible,
  drag,
  style,
  children,
}: {
  visible: boolean;
  drag: SharedValue<number>;
  style: object[];
  children: ReactNode;
}) {
  const shown = useSharedValue(1);
  useEffect(() => {
    shown.value = withTiming(visible ? 1 : 0, { duration: 180 });
  }, [visible, shown]);
  const anim = useAnimatedStyle(() => ({
    opacity: shown.value * (1 - Math.min(Math.abs(drag.value) / 80, 1)),
  }));
  return (
    <Animated.View pointerEvents={visible ? "box-none" : "none"} style={[...style, anim]}>
      {children}
    </Animated.View>
  );
}

function Round({
  icon,
  label,
  onPress,
  disabled = false,
  plate = PLATE,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  plate?: string;
}) {
  return (
    <PressScale
      to={0.9}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={[styles.round, { backgroundColor: plate }]}
      contentStyle={styles.center}
    >
      <Icon name={icon} size={20} color={WHITE} />
    </PressScale>
  );
}

function Action({
  icon,
  label,
  onPress,
  busy = false,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <PressScale
      to={0.92}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled }}
      style={styles.action}
      contentStyle={styles.actionIn}
    >
      <View style={[styles.circle, { backgroundColor: PLATE }]}>
        {busy ? <ActivityIndicator color={WHITE} /> : <Icon name={icon} size={20} color={WHITE} />}
      </View>
      <Text variant="caption" style={[styles.bold, { color: WHITE }]} numberOfLines={1}>
        {label}
      </Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  black: { backgroundColor: "#000" },
  top: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  spacer: { flex: 1 },
  title: { flexBasis: "100%", gap: 2 },
  bold: { fontWeight: "600" },
  round: { width: ROUND, height: ROUND, borderRadius: ROUND / 2 },
  center: { alignItems: "center", justifyContent: "center" },
  sides: { position: "absolute", left: 0, right: 0, height: ROUND },
  side: { position: "absolute", top: 0 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 6 },
  actions: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: SCREEN_X, paddingTop: 10 },
  action: { minWidth: 88 },
  actionIn: { alignItems: "center", gap: 6 },
  circle: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
});
