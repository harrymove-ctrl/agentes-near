import { newClientId } from "@agenteschat/client";
import { VOICE_MAX_MS, VOICE_MIN_MS } from "@agenteschat/client/lib/voice";
import { Skia } from "@shopify/react-native-skia";
import { useQueryClient } from "@tanstack/react-query";
import {
  getRecordingPermissionsAsync,
  type RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AppState, Linking } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { haptics, useToast } from "@/ui";
import { levelOf, peaksOf } from "./logic";
import { joinM4a } from "./m4a";
import { flushVoice, queueVoice, type VoiceRefusal } from "./outbox";
import { playingId, seekPlayback, startPlayback, stopPlayback } from "./playback";
import { emptyWave, type WavePaths, wavePaths } from "./VoiceBars";

/** Small files of speech: one channel, enough for a voice. Levels on, for the wave. */
const RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 22_050,
  numberOfChannels: 1,
  bitRate: 48_000,
  isMeteringEnabled: true,
};
const TICK_MS = 50;
const REVIEW_ID = "voice-take";
/** How much of the wave's height is drawn while recording. */
export const LIVE_WAVE = 24;

/** `hold`: the finger is down. `locked`: hands free. `paused`: stopped, can listen, go on, send or delete. */
export type VoicePhase = "idle" | "hold" | "locked" | "paused";

interface Stretch {
  uri: string;
  ms: number;
}

export interface VoiceTarget {
  orgId: string;
  channelId: string;
  threadId: string | null;
  /** The message this take answers (`meta.replyTo`). */
  replyTo?: string | null;
  authorId: string;
  /** Whether this person may record now (`/voice/allowed`); null while unknown. */
  allowed: boolean | null;
  afterSend: () => void;
}

const removeFile = (uri: string) => {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {}
};

/**
 * One recording, from the press to the send. A wave and a clock tick twenty times a second on a timer: the wave goes
 * straight to Skia through a shared value, and only a new second renders.
 *
 * Pausing stops the recorder, because a file can only be played once it is finished: that is what lets a paused
 * recording be heard. Going on starts a new stretch, and `joinM4a` makes them one file. A stretch that can't be
 * joined still goes, as a message of its own: nothing said is lost.
 */
export function useVoiceTake(target: VoiceTarget) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const recorder = useAudioRecorder(RECORDING);
  const [phase, setPhaseState] = useState<VoicePhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [listening, setListening] = useState(false);
  /** Whole seconds of everything recorded, for the "0:05 / 0:12" of a paused take. */
  const [total, setTotal] = useState(0);
  const inner = useSharedValue(Skia.Path.Make());
  const edge = useSharedValue(Skia.Path.Make());
  const progress = useSharedValue(1);

  const phaseRef = useRef<VoicePhase>("idle");
  const levels = useRef<number[]>([]);
  const stretches = useRef<Stretch[]>([]);
  /** What the finished stretches add up to. */
  const doneMs = useRef(0);
  const liveMs = useRef(0);
  const width = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The finger left before the recorder started. */
  const starting = useRef(false);
  const released = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const setWave = useCallback(
    (wave: WavePaths) => {
      inner.value = wave.inner;
      edge.value = wave.edge;
    },
    [inner, edge],
  );
  /** The whole take over the width it has now (a paused take's field is laid out differently from a live one's). */
  const wholeWave = useCallback(
    () => setWave(wavePaths(peaksOf(levels.current, 96), width.current, LIVE_WAVE)),
    [setWave],
  );

  const refused = useCallback(
    (reason: VoiceRefusal) => {
      haptics.warning();
      toast({ title: t(reason === "limit" ? "voice.limit" : "voice.notSent"), icon: "x" });
    },
    [t, toast],
  );

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  /** Ends the stretch in progress, if any, and keeps its file. */
  const finishStretch = useCallback(async () => {
    stopTimer();
    if (!recorder.getStatus().isRecording && liveMs.current === 0) return;
    const ms = liveMs.current;
    await recorder.stop();
    if (recorder.uri && ms > 0) stretches.current.push({ uri: recorder.uri, ms });
    doneMs.current += ms;
    liveMs.current = 0;
  }, [recorder, stopTimer]);

  const reset = useCallback(() => {
    stopTimer();
    levels.current = [];
    stretches.current = [];
    doneMs.current = 0;
    liveMs.current = 0;
    released.current = false;
    setWave(emptyWave());
    progress.value = 1;
    setSeconds(0);
    setTotal(0);
    setListening(false);
    setPhase("idle");
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  }, [setWave, progress, setPhase, stopTimer]);

  /** One file from every stretch; what can't be joined stays as a file of its own. */
  const joined = useCallback(async () => {
    const out: Stretch[] = [];
    for (const stretch of stretches.current) {
      const last = out[out.length - 1];
      if (!last) {
        out.push({ ...stretch });
        continue;
      }
      try {
        const bytes = joinM4a(await new File(last.uri).bytes(), await new File(stretch.uri).bytes());
        const file = new File(Paths.cache, `voice-${newClientId()}.m4a`);
        file.write(bytes);
        removeFile(last.uri);
        removeFile(stretch.uri);
        last.uri = file.uri;
        last.ms += stretch.ms;
      } catch {
        out.push({ ...stretch });
      }
    }
    stretches.current = out;
    return out;
  }, []);

  const pause = useCallback(async () => {
    if (phaseRef.current === "idle" || phaseRef.current === "paused") return;
    await finishStretch();
    setPhase("paused");
    await joined();
    wholeWave();
    progress.value = 0;
    const whole = Math.floor(doneMs.current / 1000);
    setSeconds(whole);
    setTotal(whole);
  }, [finishStretch, joined, wholeWave, progress, setPhase]);

  const send = useCallback(async () => {
    const { orgId, channelId, threadId, replyTo = null, authorId, afterSend } = targetRef.current;
    stopPlayback();
    await finishStretch();
    const total = doneMs.current;
    if (total < VOICE_MIN_MS) {
      for (const s of stretches.current) removeFile(s.uri);
      toast({ title: t("voice.tooShort"), icon: "mic" });
      reset();
      return;
    }
    const files = await joined();
    const all = levels.current;
    let from = 0;
    for (const file of files) {
      const to = from + Math.round((file.ms / total) * all.length);
      queueVoice(
        qc,
        file.uri,
        {
          clientId: newClientId(),
          orgId,
          channelId,
          threadId,
          replyTo,
          authorId,
          durationMs: Math.round(file.ms),
          peaks: peaksOf(all.slice(from, to)),
          language: i18n.language?.slice(0, 2) ?? null,
        },
        refused,
      );
      from = to;
    }
    haptics.light();
    reset();
    afterSend();
  }, [finishStretch, i18n.language, joined, qc, refused, reset, t, toast]);

  const cancel = useCallback(
    async (notice = true) => {
      stopPlayback();
      released.current = true;
      await finishStretch().catch(() => undefined);
      for (const s of stretches.current) removeFile(s.uri);
      if (notice) {
        haptics.warning();
        toast({ title: t("voice.deleted"), icon: "x" });
      }
      reset();
    },
    [finishStretch, reset, t, toast],
  );

  const tick = useCallback(() => {
    const status = recorder.getStatus();
    const phaseNow = phaseRef.current;
    // A call or Siri took the microphone: what was said is kept, paused, also from under a finger.
    if (!status.isRecording && status.durationMillis > 0 && (phaseNow === "hold" || phaseNow === "locked")) {
      haptics.warning();
      void pause();
      return;
    }
    liveMs.current = status.durationMillis;
    const ms = doneMs.current + liveMs.current;
    levels.current.push(levelOf(status.metering));
    if (width.current > 0) setWave(wavePaths(levels.current, width.current, LIVE_WAVE, true));
    const whole = Math.floor(ms / 1000);
    setSeconds((s) => (s === whole ? s : whole));
    if (ms < VOICE_MAX_MS) return;
    if (phaseNow === "hold") void send();
    else void pause();
  }, [pause, setWave, recorder, send]);

  const record = useCallback(async () => {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: "doNotMix" });
    await recorder.prepareToRecordAsync();
    recorder.record();
    progress.value = 1;
    timer.current = setInterval(tick, TICK_MS);
  }, [progress, recorder, tick]);

  /** The hold reached its time. A first use only asks: the next hold records. */
  const start = useCallback(async () => {
    if (phaseRef.current !== "idle" || starting.current) return;
    if (targetRef.current.allowed === false) {
      haptics.warning();
      toast({ title: t("voice.limit"), icon: "x" });
      return;
    }
    starting.current = true;
    released.current = false;
    try {
      const known = await getRecordingPermissionsAsync();
      if (!known.granted) {
        const asked = known.canAskAgain ? await requestRecordingPermissionsAsync() : known;
        if (!asked.granted && !asked.canAskAgain) {
          Alert.alert(t("voice.micBlocked"), t("voice.micBlockedHint"), [
            { text: t("voice.notNow"), style: "cancel" },
            { text: t("voice.openSettings"), onPress: () => void Linking.openSettings() },
          ]);
        }
        return;
      }
      stopPlayback();
      haptics.medium();
      setPhase("hold");
      await record();
      if (released.current) await send();
    } catch {
      toast({ title: t("voice.notSent"), icon: "x" });
      reset();
    } finally {
      starting.current = false;
    }
  }, [record, reset, send, setPhase, t, toast]);

  /** The finger came up: a hold sends; a lock already took over. */
  const release = useCallback(() => {
    if (starting.current) {
      released.current = true;
      return;
    }
    if (phaseRef.current === "hold") void send();
  }, [send]);

  /** Hands free. The haptic is the gesture's, on the frame the finger crosses the line, so none here. */
  const lock = useCallback(() => {
    if (phaseRef.current !== "hold") return;
    setPhase("locked");
  }, [setPhase]);

  const resume = useCallback(async () => {
    if (phaseRef.current !== "paused") return;
    stopPlayback();
    setListening(false);
    setWave(wavePaths(levels.current, width.current, LIVE_WAVE, true));
    setPhase("locked");
    await record().catch(() => setPhase("paused"));
  }, [setWave, record, setPhase]);

  const listen = useCallback(async () => {
    if (playingId() === REVIEW_ID) {
      stopPlayback();
      setListening(false);
      return;
    }
    const file = stretches.current[stretches.current.length - 1];
    if (!file) return;
    setListening(true);
    await startPlayback({
      id: REVIEW_ID,
      source: { uri: file.uri },
      durationMs: file.ms,
      from: progress.value < 0.999 ? progress.value : 0,
      speed: 1,
      onProgress: (at) => {
        progress.value = at;
        setSeconds(Math.floor((at * file.ms) / 1000));
      },
      onEnd: () => {
        progress.value = 0;
        setListening(false);
        setSeconds(Math.floor(doneMs.current / 1000));
      },
    });
  }, [progress]);

  const scrub = useCallback(
    (at: number) => {
      const file = stretches.current[stretches.current.length - 1];
      progress.value = at;
      if (file) setSeconds(Math.floor((at * file.ms) / 1000));
      seekPlayback(REVIEW_ID, at);
    },
    [progress],
  );

  /** The wave's width now; a paused take is redrawn to fit it (its field has other things around the wave). */
  const setWidth = useCallback(
    (w: number) => {
      if (width.current === w) return;
      width.current = w;
      if (phaseRef.current === "paused" && w > 0) wholeWave();
    },
    [wholeWave],
  );

  // Sent to the background mid-recording: the recording waits, paused.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") void pause();
    });
    return () => sub.remove();
  }, [pause]);

  // Leaving the conversation: a recording nobody finished is kept nowhere.
  useEffect(
    () => () => {
      stopTimer();
      if (phaseRef.current !== "idle") {
        void recorder.stop().catch(() => undefined);
        for (const s of stretches.current) removeFile(s.uri);
      }
    },
    [recorder, stopTimer],
  );

  return {
    phase,
    seconds,
    total,
    listening,
    inner,
    edge,
    progress,
    start,
    release,
    lock,
    pause,
    resume,
    send,
    cancel,
    listen,
    scrub,
    setWidth,
    flush: () => flushVoice(qc, refused),
  };
}
