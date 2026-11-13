import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stopVoicePlayback } from "./VoicePlayer";
import { drawVoiceWave, useWaveRepaint } from "./voice-wave";

/** A finished recording. */
export interface VoiceTake {
  blob: Blob;
  contentType: string;
  durationMs: number;
  peaks: number[];
}

/** What the app says in its own words when a recording doesn't go. */
export type VoiceNotice = "tooShort" | "silent" | "blocked" | "noMic" | "failed" | "deleted" | "noPlayback";

export type VoicePhase = "idle" | "starting" | "rec" | "paused";

/** Longest recording; the server takes this much. */
const MAX_MS = 5 * 60_000;
const MIN_MS = 700;
/** Pressing the microphone longer than this is holding it. */
const HOLD_MS = 350;
const PEAKS = 48;
/** Below this the whole recording was silence. */
const SILENCE = 0.05;
const LEVEL_MS = 45;
/** Prefers what also plays on an iPhone. */
const TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];

export const voiceRecordingSupported = () =>
  typeof window !== "undefined" &&
  typeof window.MediaRecorder === "function" &&
  typeof navigator.mediaDevices?.getUserMedia === "function" &&
  typeof window.AudioContext === "function";

const bestType = () => TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";

/** About `PEAKS` bars from every level heard: each the loudest of its stretch, scaled to the loudest of all. */
export function peaksOf(levels: readonly number[], n = PEAKS): number[] {
  if (levels.length === 0) return [];
  const count = Math.min(n, levels.length);
  const top = Math.max(...levels, 0.01);
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * levels.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count));
    const peak = Math.max(...levels.slice(from, to));
    return Math.round((peak / top) * 1000) / 1000;
  });
}

/** One recording: the microphone, what it heard, and listening back while paused. */
class Recording {
  readonly levels: number[] = [];
  paused = false;
  /** Paused: where listening is, from 0 to 1. */
  pos = 0;
  listening = false;
  private readonly chunks: Blob[] = [];
  private readonly buf: Float32Array<ArrayBuffer>;
  private t0 = 0;
  private pausedAt = 0;
  private pausedMs = 0;
  private lastLevel = 0;
  private smooth = 0;
  private node: AudioBufferSourceNode | null = null;
  private decoded: { buffer: AudioBuffer; chunks: number } | null = null;
  private startedAt = 0;
  private from = 0;

  private constructor(
    private readonly stream: MediaStream,
    private readonly ac: AudioContext,
    private readonly analyser: AnalyserNode,
    private readonly recorder: MediaRecorder,
  ) {
    this.buf = new Float32Array(analyser.fftSize);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.start(1000);
    this.t0 = performance.now();
  }

  static async open() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ac = new AudioContext();
    await ac.resume().catch(() => undefined);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(analyser);
    const mimeType = bestType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    return new Recording(stream, ac, analyser, recorder);
  }

  elapsed() {
    return (this.paused ? this.pausedAt : performance.now()) - this.t0 - this.pausedMs;
  }

  /** Reads the microphone's level, on a steady beat. */
  listen(now: number) {
    if (this.paused || now - this.lastLevel < LEVEL_MS) return;
    this.lastLevel = now;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const s of this.buf) sum += s * s;
    const level = Math.min(1, Math.sqrt(sum / this.buf.length) * 7);
    this.smooth = this.smooth * 0.45 + level * 0.55;
    this.levels.push(this.smooth);
  }

  pause() {
    if (this.paused) return;
    this.pausedAt = performance.now();
    this.paused = true;
    this.pos = 0;
    if (this.recorder.state === "recording") {
      // What was recorded so far is needed to listen back.
      this.recorder.requestData();
      this.recorder.pause();
    }
  }

  resume() {
    if (!this.paused) return;
    this.hush();
    this.pausedMs += performance.now() - this.pausedAt;
    this.paused = false;
    if (this.recorder.state === "paused") this.recorder.resume();
  }

  hush() {
    if (this.node) {
      this.node.onended = null;
      this.node.stop();
      this.node = null;
    }
    this.listening = false;
  }

  /** The recording so far as sound; it decodes whole, which also makes every point of it reachable. */
  private async decode() {
    if (this.decoded?.chunks === this.chunks.length) return this.decoded.buffer;
    const bytes = await new Blob(this.chunks, { type: this.recorder.mimeType }).arrayBuffer();
    const buffer = await this.ac.decodeAudioData(bytes);
    this.decoded = { buffer, chunks: this.chunks.length };
    return buffer;
  }

  private playFrom(buffer: AudioBuffer, at: number, onEnd: () => void) {
    if (this.node) {
      this.node.onended = null;
      this.node.stop();
    }
    const node = this.ac.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ac.destination);
    node.onended = () => {
      this.node = null;
      this.listening = false;
      this.pos = 0;
      onEnd();
    };
    this.from = at;
    this.startedAt = this.ac.currentTime;
    node.start(0, at * buffer.duration);
    this.node = node;
    this.listening = true;
  }

  /** Plays or stops what was recorded, from where it is. False when this browser can't. */
  async toggleListening(onEnd: () => void) {
    if (this.listening) {
      this.hush();
      return true;
    }
    stopVoicePlayback();
    try {
      const buffer = await this.decode();
      this.playFrom(buffer, this.pos >= 0.999 ? 0 : this.pos, onEnd);
      return true;
    } catch {
      return false;
    }
  }

  /** Moves through what was recorded, playing or not. */
  scrub(pos: number, onEnd: () => void) {
    this.pos = Math.max(0, Math.min(0.999, pos));
    if (this.listening && this.decoded) this.playFrom(this.decoded.buffer, this.pos, onEnd);
  }

  /** Where listening is now, kept in `pos`. */
  position() {
    if (this.listening && this.decoded) {
      this.pos = Math.min(0.999, this.from + (this.ac.currentTime - this.startedAt) / this.decoded.buffer.duration);
    }
    return this.pos;
  }

  async finish(): Promise<VoiceTake> {
    this.hush();
    const durationMs = this.elapsed();
    const contentType = this.recorder.mimeType.split(";")[0] || "audio/mp4";
    if (this.recorder.state !== "inactive") {
      await new Promise<void>((done) => {
        this.recorder.onstop = () => done();
        this.recorder.stop();
      });
    }
    this.release();
    return {
      blob: new Blob(this.chunks, { type: contentType }),
      contentType,
      durationMs,
      peaks: peaksOf(this.levels),
    };
  }

  cancel() {
    this.hush();
    if (this.recorder.state !== "inactive") this.recorder.stop();
    this.release();
  }

  private release() {
    for (const track of this.stream.getTracks()) track.stop();
    void this.ac.close().catch(() => undefined);
  }
}

export interface VoiceRecorderOptions {
  /** Asked before the microphone opens: false stops there (the app says why). */
  allowed?: () => Promise<boolean>;
  onTake: (take: VoiceTake) => void;
  onNotice: (notice: VoiceNotice) => void;
}

/** The microphone's whole life in the composer: recording, pausing, listening back, sending, deleting. */
export function useVoiceRecorder(options: VoiceRecorderOptions | undefined, wave: RefObject<HTMLCanvasElement | null>) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [hold, setHold] = useState(false);
  const [listening, setListening] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const current = useRef<Recording | null>(null);
  const opening = useRef(false);
  const released = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const timer = useRef<HTMLSpanElement | null>(null);

  const idle = useCallback(() => {
    current.current = null;
    setPhase("idle");
    setHold(false);
    setListening(false);
    setSeconds(0);
  }, []);

  const send = useCallback(async () => {
    const rec = current.current;
    if (!rec) return;
    current.current = null;
    const silent = Math.max(0, ...rec.levels) < SILENCE;
    const take = await rec.finish();
    idle();
    if (take.durationMs < MIN_MS) latest.current?.onNotice("tooShort");
    else if (silent) latest.current?.onNotice("silent");
    else latest.current?.onTake(take);
  }, [idle]);

  const discard = useCallback(
    (say: boolean) => {
      const rec = current.current;
      if (!rec) return;
      rec.cancel();
      idle();
      if (say) latest.current?.onNotice("deleted");
    },
    [idle],
  );

  const start = useCallback(
    async (holding: boolean) => {
      if (current.current || opening.current) return;
      opening.current = true;
      released.current = false;
      setPhase("starting");
      setHold(holding);
      try {
        if (latest.current?.allowed && !(await latest.current.allowed())) {
          idle();
          return;
        }
        stopVoicePlayback();
        const rec = await Recording.open();
        // Let go while the browser asked for the microphone: nothing to record.
        if (holding && released.current) {
          rec.cancel();
          idle();
          return;
        }
        current.current = rec;
        setPhase("rec");
      } catch (error) {
        idle();
        const name = error instanceof Error ? error.name : "";
        latest.current?.onNotice(
          name === "NotAllowedError" || name === "SecurityError"
            ? "blocked"
            : name === "NotFoundError"
              ? "noMic"
              : "failed",
        );
      } finally {
        opening.current = false;
      }
    },
    [idle],
  );

  const togglePause = useCallback(() => {
    const rec = current.current;
    if (!rec) return;
    if (rec.paused) {
      rec.resume();
      setListening(false);
      setPhase("rec");
    } else {
      rec.pause();
      setPhase("paused");
    }
  }, []);

  const ended = useCallback(() => setListening(false), []);
  const toggleListening = useCallback(async () => {
    const rec = current.current;
    if (!rec?.paused) return;
    if (await rec.toggleListening(ended)) setListening(rec.listening);
    else latest.current?.onNotice("noPlayback");
  }, [ended]);

  const paint = useCallback(() => {
    const rec = current.current;
    if (!rec) return;
    if (rec.paused) drawVoiceWave(wave.current, rec.levels, { progress: rec.position(), handle: true });
    else drawVoiceWave(wave.current, rec.levels, { live: true });
  }, [wave]);
  useWaveRepaint(wave, paint);

  // Levels, the wave and the clock, while there is a recording. The clock's digits go straight to the page.
  const active = phase === "rec" || phase === "paused";
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const tick = (now: number) => {
      const rec = current.current;
      if (!rec) return;
      rec.listen(now);
      paint();
      const elapsed = rec.elapsed();
      const shown = rec.listening || rec.pos > 0 ? rec.pos * elapsed : elapsed;
      const whole = Math.round(shown / 1000);
      if (timer.current) timer.current.textContent = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
      setSeconds((was) => (was === Math.ceil(elapsed / 1000) ? was : Math.ceil(elapsed / 1000)));
      // The limit stops it and sends it: nothing recorded is lost.
      if (elapsed >= MAX_MS) {
        void send();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, paint, send]);

  // Enter sends, Esc deletes, Space listens: ahead of the page's own keys (Esc also stops an agent there).
  const held = hold;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const rec = current.current;
      if (!rec) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        discard(true);
      } else if (e.key === "Enter" && !held) {
        e.preventDefault();
        e.stopPropagation();
        void send();
      } else if (e.key === " " && rec.paused && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void toggleListening();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, held, discard, send, toggleListening]);

  useEffect(
    () => () => {
      current.current?.cancel();
      current.current = null;
    },
    [],
  );

  /** A click or a drag on the wave while paused. */
  const onWavePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rec = current.current;
      if (!rec?.paused) return;
      e.preventDefault();
      const el = e.currentTarget;
      const at = (x: number) => {
        const r = el.getBoundingClientRect();
        rec.scrub((x - r.left) / r.width, ended);
      };
      at(e.clientX);
      const move = (ev: PointerEvent) => at(ev.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [ended],
  );

  // The microphone button: a click stays recording and pauses after that; held, letting go sends.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUp = useRef(0);
  const micProps = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0 || current.current || opening.current) return;
        let holding = false;
        pressTimer.current = setTimeout(() => {
          holding = true;
          void start(true);
        }, HOLD_MS);
        const up = () => {
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          if (pressTimer.current) clearTimeout(pressTimer.current);
          lastUp.current = performance.now();
          if (!holding) void start(false);
          else if (current.current) void send();
          else released.current = true;
        };
        const cancel = () => {
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          if (pressTimer.current) clearTimeout(pressTimer.current);
          if (holding) {
            released.current = true;
            discard(false);
          }
        };
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
      },
      onClick: (e: React.MouseEvent) => {
        // The press already did its part; this is the click after it.
        if (performance.now() - lastUp.current < 400) return;
        if (current.current) togglePause();
        else if (e.detail === 0) void start(false);
      },
    }),
    [start, send, discard, togglePause],
  );

  return {
    phase,
    hold,
    listening,
    seconds,
    active,
    timer,
    micProps,
    send,
    discard,
    togglePause,
    toggleListening,
    onWavePointerDown,
  };
}
