import { useEventListener } from "expo";
import { type VideoPlayer as Player, useVideoPlayer, VideoView } from "expo-video";
import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  Text as RNText,
  StyleSheet,
  View,
} from "react-native";
import { Glass, Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { videoClock, videoHeight } from "./logic";

/** The bar hides this long after the last touch, while it plays. */
const IDLE_MS = 2500;

/** Only one video plays at a time: starting one pauses the one before. */
let current: Player | null = null;
function claim(player: Player) {
  if (current && current !== player) {
    try {
      current.pause();
    } catch {
      // That player was already released with its screen.
    }
  }
  current = player;
}

export interface VideoPlayerProps {
  /** Where it plays from, with the session when the link is ours. */
  source: { uri: string; headers?: Record<string, string> };
  name: string;
  /** `inline` in a message (at `width`, one shape, the video whole in it); `screen` fills the file screen. */
  variant?: "inline" | "screen";
  width?: number;
  /** The corner button of an inline video: opens the file screen. */
  onOpen?: () => void;
  /** It can't play on this device (a format it lacks): the caller shows the file's card instead. */
  onFailed?: () => void;
}

/**
 * A video with the design system's controls (the web's `VideoPlayer`): stopped, its first frame with a play key and
 * its length in a small badge (no name over the picture, as a picture has none); playing, a glass bar over its foot (play, timeline, time, sound, full screen) that a tap
 * on the picture shows or hides. The volume is the phone's own buttons.
 */
export function VideoPlayer({ source, name, variant = "inline", width = 300, onOpen, onFailed }: VideoPlayerProps) {
  const { t } = useTranslation();
  const c = useColors();
  const view = useRef<VideoView>(null);
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.loop = false;
  });
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [shown, setShown] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const wake = useCallback(() => {
    setShown(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (player.playing) setShown(false);
    }, IDLE_MS);
  }, [player]);
  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      if (current === player) current = null;
    },
    [player],
  );

  useEventListener(player, "playingChange", ({ isPlaying }) => {
    setPlaying(isPlaying);
    if (isPlaying) {
      claim(player);
      setStarted(true);
      setEnded(false);
      wake();
    } else setShown(true);
  });
  useEventListener(player, "statusChange", ({ status }) => {
    setLoading(status === "loading");
    if (status === "error") onFailed?.();
  });
  useEventListener(player, "timeUpdate", ({ currentTime }) => setTime(currentTime));
  useEventListener(player, "mutedChange", ({ muted: m }) => setMuted(m));
  useEventListener(player, "playToEnd", () => {
    setEnded(true);
    setShown(true);
  });
  useEventListener(player, "sourceLoad", ({ duration: d }) => setDuration(d));

  const toggle = () => {
    tapHaptic();
    if (ended) {
      player.replay();
      player.play();
    } else if (player.playing) player.pause();
    else player.play();
  };
  const onPicture = () => {
    if (!started) toggle();
    else if (shown) setShown(false);
    else wake();
  };
  const seekTo = (fraction: number) => {
    if (duration <= 0) return;
    player.currentTime = Math.max(0, Math.min(duration, fraction * duration));
    setTime(player.currentTime);
    setEnded(false);
    wake();
  };

  const inline = variant === "inline";
  const height = inline ? videoHeight(width) : undefined;
  const length = duration > 0 ? videoClock(duration) : "";
  const playLabel = ended
    ? t("mobile.files.video.replay")
    : playing
      ? t("mobile.files.video.pause")
      : t("mobile.files.video.play");

  return (
    <View style={[styles.box, inline ? [styles.inline, { width, height, borderColor: c.line2 }] : styles.screen]}>
      <VideoView
        ref={view}
        player={player}
        nativeControls={false}
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture={false}
        style={StyleSheet.absoluteFill}
      />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onPicture}
        accessibilityRole="button"
        accessibilityLabel={started ? playLabel : `${t("mobile.files.video.play")}: ${name}`}
      />

      {!started ? (
        <View style={styles.center} pointerEvents="box-none">
          <Pressable
            onPress={toggle}
            accessibilityRole="button"
            accessibilityLabel={`${t("mobile.files.video.play")}: ${name}`}
            style={({ pressed }) => [styles.big, { backgroundColor: c.raised }, pressed && styles.pressed]}
          >
            <Icon name="play" size={24} color={c.ink} />
          </Pressable>
        </View>
      ) : null}

      {loading && started ? (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}

      {inline && !started && length ? (
        <View style={styles.length} pointerEvents="none">
          <RNText style={styles.lengthText}>{length}</RNText>
        </View>
      ) : null}

      {inline && onOpen ? (
        <Pressable
          onPress={() => {
            player.pause();
            onOpen();
          }}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.files.video.open")}
          hitSlop={6}
          style={({ pressed }) => [styles.open, { backgroundColor: c.glassSolid }, pressed && styles.pressed]}
        >
          <Icon name="expand" size={16} color={c.ink} />
        </Pressable>
      ) : null}

      {started && shown ? (
        <Glass style={[styles.bar, inline ? styles.barInline : null]}>
          <BarButton icon={ended ? "replay" : playing ? "pause" : "play"} label={playLabel} onPress={toggle} />
          <Track
            value={duration > 0 ? time / duration : 0}
            label={t("mobile.files.video.seek")}
            onSeek={seekTo}
            onTouch={wake}
          />
          <Text variant="footnote" tone="muted" style={styles.time}>
            {videoClock(time)}
          </Text>
          <BarButton
            icon={muted ? "mute" : "sound"}
            label={muted ? t("mobile.files.video.unmute") : t("mobile.files.video.mute")}
            onPress={() => {
              player.muted = !player.muted;
              wake();
            }}
          />
          <BarButton
            icon="fullscreen"
            label={t("mobile.files.video.fullscreen")}
            onPress={() => void view.current?.enterFullscreen()}
          />
        </Glass>
      ) : null}
    </View>
  );
}

function BarButton({
  icon,
  label,
  onPress,
}: {
  icon: "play" | "pause" | "replay" | "sound" | "mute" | "fullscreen";
  label: string;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // 34 pt with 5 around: the 44 pt a finger needs.
      hitSlop={5}
      style={({ pressed }) => [styles.btn, pressed && { backgroundColor: c.plate }]}
    >
      <Icon name={icon} size={20} color={c.ink} />
    </Pressable>
  );
}

/** The timeline: a touch or a drag moves through it (it keeps the touch from the list's scroll). */
function Track({
  value,
  label,
  onSeek,
  onTouch,
}: {
  value: number;
  label: string;
  onSeek: (fraction: number) => void;
  onTouch: () => void;
}) {
  const c = useColors();
  const box = useRef<ComponentRef<typeof View>>(null);
  const frame = useRef({ x: 0, width: 0 });
  const [drag, setDrag] = useState<number | null>(null);
  const at = (e: GestureResponderEvent) => {
    const { x, width } = frame.current;
    return width > 0 ? Math.max(0, Math.min(1, (e.nativeEvent.pageX - x) / width)) : 0;
  };
  const shown = Math.max(0, Math.min(1, drag ?? value));
  return (
    <View
      ref={box}
      style={styles.track}
      onLayout={() => box.current?.measureInWindow((x, _y, width) => (frame.current = { x, width }))}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        box.current?.measureInWindow((x, _y, width) => (frame.current = { x, width }));
        setDrag(at(e));
        onTouch();
      }}
      onResponderMove={(e) => setDrag(at(e))}
      onResponderRelease={(e) => {
        onSeek(at(e));
        setDrag(null);
      }}
      onResponderTerminate={() => setDrag(null)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) =>
        onSeek(Math.max(0, Math.min(1, value + (e.nativeEvent.actionName === "increment" ? 0.05 : -0.05))))
      }
    >
      <View style={[styles.line, { backgroundColor: c.plate }]}>
        <View style={[styles.filled, { width: `${shown * 100}%`, backgroundColor: c.ink }]} />
      </View>
      <View style={[styles.knob, { left: `${shown * 100}%`, backgroundColor: c.ink, borderColor: c.raised }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: "hidden", backgroundColor: "#000" },
  // An attachment's shape (as the tiles beside it): rounded, the bottom left corner cut, a hairline.
  inline: { borderRadius: 16, borderBottomLeftRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  screen: { flex: 1 },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  big: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 3,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.94 }] },
  length: {
    position: "absolute",
    left: 8,
    bottom: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 7,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
  },
  lengthText: { color: "#fff", fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  open: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  bar: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 10,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 6,
    borderRadius: 14,
  },
  barInline: { left: 8, right: 8, bottom: 8, height: 40 },
  btn: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  time: { paddingHorizontal: 4, fontVariant: ["tabular-nums"] },
  track: { flex: 1, height: 34, justifyContent: "center", marginHorizontal: 6 },
  line: { height: 4, borderRadius: 999, overflow: "hidden" },
  filled: { height: 4 },
  knob: {
    position: "absolute",
    top: 11,
    width: 12,
    height: 12,
    marginLeft: -6,
    borderRadius: 6,
    borderWidth: 2,
  },
});
