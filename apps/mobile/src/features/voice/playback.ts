import { type AudioPlayer, type AudioSource, createAudioPlayer, setAudioModeAsync } from "expo-audio";

/**
 * One voice plays at a time, in the whole app: a single player that rows take turns on, so a list scrolling past
 * never holds one per message. Position goes to the row's `onProgress` on a timer, outside React.
 */
export interface PlayRequest {
  id: string;
  source: AudioSource;
  durationMs: number;
  from: number;
  speed: number;
  onProgress: (fraction: number) => void;
  onEnd: () => void;
}

const TICK_MS = 50;
let player: AudioPlayer | null = null;
let now: PlayRequest | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const say = () => {
  for (const listener of listeners) listener();
};

export const subscribePlayback = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const playingId = () => now?.id ?? null;

const fraction = (p: AudioPlayer, durationMs: number) => {
  const total = p.duration > 0 ? p.duration : durationMs / 1000;
  return total > 0 ? Math.min(1, p.currentTime / total) : 0;
};

export function stopPlayback() {
  if (timer) clearInterval(timer);
  timer = null;
  player?.pause();
  if (!now) return;
  now = null;
  say();
}

export async function startPlayback(request: PlayRequest) {
  stopPlayback();
  await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, interruptionMode: "doNotMix" });
  const p = player ?? createAudioPlayer(null, { updateInterval: 100 });
  player = p;
  p.replace(request.source);
  p.setPlaybackRate(request.speed);
  if (request.from > 0) await p.seekTo((request.from * request.durationMs) / 1000);
  p.play();
  now = request;
  say();
  timer = setInterval(() => {
    if (!now) return;
    const done = p.currentStatus.didJustFinish;
    const at = fraction(p, now.durationMs);
    if (done || at >= 0.998) {
      const { onEnd } = now;
      stopPlayback();
      onEnd();
      return;
    }
    now.onProgress(at);
  }, TICK_MS);
}

export function seekPlayback(id: string, at: number) {
  if (now?.id !== id || !player) return;
  void player.seekTo((at * now.durationMs) / 1000);
}

export function setPlaybackSpeed(id: string, speed: number) {
  if (now?.id === id) player?.setPlaybackRate(speed);
}
