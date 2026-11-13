import type { Message } from "@agenteschat/client";
import { voiceAudioGone, voiceAudioUrl, voiceClock, voiceExpired, voiceOf } from "@agenteschat/client/lib/voice";
import { Skia } from "@shopify/react-native-skia";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { appHeaders, authedFetch, lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { Icon, PressScale, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { hasWords, nextSpeed } from "./logic";
import { playingId, seekPlayback, setPlaybackSpeed, startPlayback, stopPlayback, subscribePlayback } from "./playback";
import { PixelWave, wavePaths } from "./VoiceBars";

/** Six rows of the sky's cells. */
const WAVE = 24;
/** Past this many characters the first line is cut, so "Ver tudo" is offered without measuring the text. */
const ONE_LINE = 40;
/** The list recycles rows: what a message had open or where it stopped lives outside them. */
const opened = new Set<string>();
const positions = new Map<string, number>();
const expired = new Set<string>();
let speed = 1;

/**
 * A voice message: the audio is the message, with one line of its words under the wave, in the same card, and nowhere
 * else; a tap opens the rest there. A recording the server no longer keeps stays as a dimmed wave with its words.
 */
export const VoiceMessage = memo(function VoiceMessage({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const voice = voiceOf(message.meta);
  const clipId = voice?.clipId ?? "";
  const durationMs = voice?.durationMs ?? 0;
  const sending = Boolean(message.local);
  const playing = useSyncExternalStore(subscribePlayback, playingId) === clipId;
  const progress = useSharedValue(positions.get(clipId) ?? 0);
  const inner = useSharedValue(Skia.Path.Make());
  const edge = useSharedValue(Skia.Path.Make());
  const [width, setWidth] = useState(0);
  const [time, setTime] = useState(durationMs);
  const [rate, setRate] = useState(speed);
  const [gone, setGone] = useState(() => expired.has(clipId) || Boolean(voice && voiceExpired(voice)));
  const [open, setOpen] = useState(() => opened.has(message.id));
  const lastSecond = useRef(-1);

  // A recycled row takes on another message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the row shows another recording
  useEffect(() => {
    progress.value = positions.get(clipId) ?? 0;
    setTime(durationMs);
    setGone(expired.has(clipId) || Boolean(voice && voiceExpired(voice)));
    setOpen(opened.has(message.id));
  }, [clipId, message.id]);
  useEffect(() => {
    if (width <= 0 || !voice) return;
    const wave = wavePaths(voice.peaks, width, WAVE);
    inner.value = wave.inner;
    edge.value = wave.edge;
  }, [width, voice, inner, edge]);

  const report = (at: number) => {
    progress.value = at;
    positions.set(clipId, at);
    const second = Math.floor((at * durationMs) / 1000);
    if (second === lastSecond.current) return;
    lastSecond.current = second;
    setTime(at * durationMs);
  };
  const ended = () => {
    positions.delete(clipId);
    progress.value = 0;
    setTime(durationMs);
  };
  const lose = () => {
    expired.add(clipId);
    setGone(true);
    ended();
  };
  const toggle = async () => {
    if (playing) {
      stopPlayback();
      return;
    }
    // A player says nothing of why a file failed: the server is asked first.
    const url = voiceAudioUrl(orgId, clipId, serverUrl());
    if (await voiceAudioGone(url, authedFetch as typeof fetch)) {
      lose();
      return;
    }
    await startPlayback({
      id: clipId,
      source: { uri: url, headers: appHeaders(lastCookie()) },
      durationMs,
      from: positions.get(clipId) ?? 0,
      speed,
      onProgress: report,
      onEnd: ended,
    });
  };
  const seek = (at: number) => {
    report(at);
    seekPlayback(clipId, at);
  };
  const cycle = () => {
    speed = nextSpeed(speed);
    setRate(speed);
    setPlaybackSpeed(clipId, speed);
  };
  const flip = () => {
    if (open) opened.delete(message.id);
    else opened.add(message.id);
    setOpen(!open);
  };

  const canPlay = !sending && !gone;
  const pan = usePanGesture({
    enabled: canPlay,
    activeOffsetX: [-4, 4],
    failOffsetY: [-12, 12],
    onUpdate: (e) => {
      "worklet";
      if (width > 0) progress.value = Math.max(0, Math.min(0.999, e.x / width));
    },
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(seek, progress.value);
    },
  });
  const tap = useTapGesture({
    enabled: canPlay,
    onDeactivate: (e) => {
      "worklet";
      if (width > 0) scheduleOnRN(seek, Math.max(0, Math.min(0.999, e.x / width)));
    },
  });
  const scrub = useExclusiveGestures(pan, tap);

  const words = useMemo(() => hasWords(message), [message]);
  // The speed as the language writes it ("1,5×" in Portuguese).
  const speedFormat = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }),
    [i18n.language],
  );
  const more = words && !open && (message.body.length > ONE_LINE || message.body.includes("\n"));
  if (!voice) return null;
  return (
    <View style={styles.box}>
      <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line }]}>
        <View style={styles.player}>
          {gone ? null : (
            <PressScale
              to={0.92}
              disabled={!canPlay}
              onPress={() => void toggle()}
              accessibilityRole="button"
              accessibilityLabel={playing ? t("voice.stop") : t("voice.play")}
              hitSlop={8}
              style={[styles.play, { backgroundColor: canPlay ? c.ink : c.sunken }]}
            >
              <View style={styles.center}>
                <Icon name={playing ? "pause" : "play"} size={14} color={canPlay ? c.bg : c.muted} />
              </View>
            </PressScale>
          )}
          <GestureDetector gesture={scrub}>
            <View style={[styles.wave, gone && styles.dim]} accessible={false}>
              <PixelWave
                inner={inner}
                edge={edge}
                progress={progress}
                tones={[c.ink, c.ink]}
                off={gone ? c.line2 : c.faint}
                onWidth={setWidth}
                height={WAVE}
                handle={!gone}
              />
            </View>
          </GestureDetector>
          {gone ? (
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {t("voice.expired")}
            </Text>
          ) : (
            <Text variant="caption" tone="muted" style={styles.time}>
              {voiceClock(time)}
            </Text>
          )}
          {canPlay ? (
            <Pressable
              onPress={cycle}
              accessibilityRole="button"
              accessibilityLabel={t("voice.speed")}
              hitSlop={10}
              style={({ pressed }) => [styles.speed, { backgroundColor: c.sunken }, pressed && styles.pressed]}
            >
              <Text variant="caption" tone="muted" style={styles.speedText}>
                {`${speedFormat.format(rate)}×`}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {words ? (
          <Pressable
            onPress={flip}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={open ? t("voice.hideText") : t("voice.showText")}
            hitSlop={8}
            style={styles.words}
          >
            <Text variant="small" tone="muted" numberOfLines={open ? undefined : 1} selectable={open}>
              {message.body}
            </Text>
            {more ? (
              <Text variant="footnote" tone="faint" numberOfLines={1}>
                {t("mobile.voice.seeAll")}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  box: { gap: 6, maxWidth: 320 },
  // The chat's card (files, tools, media): 14 round, the corner cut at the bottom left.
  card: {
    gap: 4,
    padding: 8,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  player: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 28 },
  play: { width: 28, height: 28, borderRadius: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  wave: { flex: 1, minWidth: 0, height: WAVE, flexDirection: "row" },
  dim: { opacity: 0.5, marginLeft: 6 },
  time: { minWidth: 30, textAlign: "right", fontVariant: ["tabular-nums"] },
  // A count chip: the number on a sunken pill.
  speed: {
    height: 22,
    minWidth: 32,
    paddingHorizontal: 7,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  speedText: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  pressed: { opacity: 0.6 },
  // Under the wave, past the play button; "Ver tudo" on its own line below the words.
  words: { paddingLeft: 38, paddingBottom: 2, gap: 2 },
});
