import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cx } from "../cx";
import { Icon } from "../icons/Icon";
import { claimPlayback, releasePlayback, stopPlayback } from "./media-playback";
import { drawVoiceWave, useWaveRepaint } from "./voice-wave";

export interface VoicePlayerLabels {
  play: string;
  pause: string;
  /** The wave as a slider. */
  seek: string;
  /** The speed button's name, for "1.5". */
  speed: (speed: number) => string;
  expired: string;
  showText: string;
  hideText: string;
}

export interface VoicePlayerProps {
  /** Where it plays from. */
  src: string;
  /** The wave, from 0 to 1. */
  peaks: readonly number[];
  durationMs: number;
  labels: VoicePlayerLabels;
  /** Its date passed: nothing plays, and the words can still be opened. */
  expired?: boolean;
  /** Asked when it fails to play: true when the recording is gone. */
  isGone?: () => Promise<boolean>;
  /** Its words, opened on demand; null or empty: there are none to open. */
  words?: string | null;
  /** Under the player ("Vai assim que a conexão voltar"). */
  note?: ReactNode;
  className?: string;
}

const SPEEDS = [1, 1.5, 2];
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Called by anything else about to make sound (listening back to a recording): stops a voice message or a video. */
export const stopVoicePlayback = stopPlayback;

/**
 * A voice message: play, wave, time and speed, a click or a drag on the wave moves through it. The words stay closed on
 * every load and open only from the small button at its end. An expired one shows its wave dimmed, and doesn't play.
 */
export function VoicePlayer({
  src,
  peaks,
  durationMs,
  labels,
  expired,
  isGone,
  words,
  note,
  className,
}: VoicePlayerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const frame = useRef(0);
  const pos = useRef(0);
  const [on, setOn] = useState(false);
  const [gone, setGone] = useState(false);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [open, setOpen] = useState(false);
  const wordsId = useId();
  const dead = Boolean(expired) || gone;

  const paint = useCallback(
    () => drawVoiceWave(canvas.current, peaks, { progress: pos.current, handle: !dead }),
    [peaks, dead],
  );
  useWaveRepaint(canvas, paint);

  const halt = useCallback(() => {
    cancelAnimationFrame(frame.current);
    audio.current?.pause();
    setOn(false);
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      audio.current?.pause();
      audio.current = null;
      releasePlayback(halt);
    },
    [halt],
  );
  const to = useCallback(
    (next: number) => {
      pos.current = next;
      setTime(next * durationMs);
      paint();
    },
    [durationMs, paint],
  );
  const failed = useCallback(() => {
    halt();
    void isGone?.().then((yes) => {
      if (yes) setGone(true);
    });
  }, [halt, isGone]);

  const play = () => {
    if (dead) return;
    if (on) {
      halt();
      return;
    }
    if (!audio.current) {
      const a = new Audio(src);
      a.onerror = failed;
      a.onended = () => {
        halt();
        to(0);
      };
      audio.current = a;
    }
    const a = audio.current;
    claimPlayback(halt);
    a.playbackRate = speed;
    if (pos.current > 0) a.currentTime = (pos.current * durationMs) / 1000;
    a.play().catch(failed);
    setOn(true);
    const tick = () => {
      if (!audio.current) return;
      to(Math.min(1, (audio.current.currentTime * 1000) / durationMs));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  const seek = (next: number) => {
    const clamped = Math.max(0, Math.min(0.999, next));
    to(clamped);
    if (audio.current) audio.current.currentTime = (clamped * durationMs) / 1000;
  };
  const grab = (e: PointerEvent<HTMLCanvasElement>) => {
    if (dead) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = (x: number) => {
      const r = el.getBoundingClientRect();
      seek((x - r.left) / r.width);
    };
    at(e.clientX);
    const move = (ev: globalThis.PointerEvent) => at(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const keys = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    seek(pos.current + (step * 5000) / durationMs);
  };

  const hasWords = Boolean(words?.trim());
  return (
    <div className={cx("ac-voice", className)} data-expired={dead || undefined} data-open={open || undefined}>
      <div className="ac-voice__card">
        <div className="ac-voice__bar">
          {dead ? (
            <span className="ac-voice__play" aria-hidden="true">
              <Icon name="play" size={14} />
            </span>
          ) : (
            <button
              type="button"
              className="ac-voice__play"
              aria-label={on ? labels.pause : labels.play}
              onClick={play}
            >
              <Icon name={on ? "pause" : "play"} size={14} />
            </button>
          )}
          <canvas
            ref={canvas}
            className="ac-voice__wave"
            {...(dead
              ? { "aria-hidden": true }
              : {
                  role: "slider",
                  tabIndex: 0,
                  "aria-label": labels.seek,
                  "aria-valuemin": 0,
                  "aria-valuemax": Math.round(durationMs / 1000),
                  "aria-valuenow": Math.round(time / 1000),
                  "aria-valuetext": clock(time),
                  onPointerDown: grab,
                  onKeyDown: keys,
                })}
          />
          {dead ? (
            <span className="ac-voice__expired">{labels.expired}</span>
          ) : (
            <>
              <span className="ac-voice__time">{clock(on || time > 0 ? time : durationMs)}</span>
              <button
                type="button"
                className="ac-voice__speed"
                aria-label={labels.speed(speed)}
                onClick={() => {
                  const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
                  setSpeed(next);
                  if (audio.current) audio.current.playbackRate = next;
                }}
              >
                {speed}×
              </button>
            </>
          )}
        </div>
        {hasWords &&
          (open ? (
            <div className="ac-voice__words" id={wordsId}>
              <p>{words}</p>
              <button type="button" className="ac-voice__words-close" aria-expanded onClick={() => setOpen(false)}>
                {labels.hideText}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="ac-voice__preview"
              aria-label={labels.showText}
              aria-expanded={false}
              title={labels.showText}
              onClick={() => setOpen(true)}
            >
              {words}
            </button>
          ))}
      </div>
      {note && <span className="ac-voice__note">{note}</span>}
    </div>
  );
}
