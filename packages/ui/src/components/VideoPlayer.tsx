import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../cx";
import { Icon } from "../icons/Icon";
import { claimPlayback, releasePlayback } from "./media-playback";
import { PixelSpinner } from "./PixelSpinner";

export interface VideoPlayerLabels {
  play: string;
  pause: string;
  /** It ended: plays it from the start. */
  replay: string;
  /** The timeline as a slider. */
  seek: string;
  volume: string;
  mute: string;
  unmute: string;
  /** The speed button's name, for "1.5". */
  speed: (speed: number) => string;
  fullscreen: string;
  exitFullscreen: string;
  /** The corner button on a chat tile that opens the viewer. */
  open: string;
}

export interface VideoPlayerProps {
  /** Where it plays from (a URL that answers in parts). */
  src: string;
  /** The file's name, in the big play button's name. */
  name: string;
  /** `tile` in the chat (one box, the video whole inside it; a corner button opens the viewer), `viewer` fills its box. */
  variant?: "tile" | "viewer";
  labels: VideoPlayerLabels;
  /** The tile's corner button. */
  onOpen?: () => void;
  /** Beside the corner button, in the same glass group on hover (a chat tile's Download and More actions). */
  actions?: ReactNode;
  /** It can't play here (a codec this browser lacks, the file gone): the caller shows the file instead. */
  onFailed?: () => void;
  /** Over the picture's top left (the viewer's own buttons). */
  children?: ReactNode;
  className?: string;
}

const SPEEDS = [1, 1.5, 2];
/** The controls hide this long after the pointer stops, while it plays. */
const IDLE_MS = 2000;
const STEP_S = 5;
const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
const clamp = (x: number) => Math.max(0, Math.min(1, x));

type Phase = "idle" | "playing" | "paused" | "ended";

/** A slider drawn as a rail (the timeline, the volume): pointer drag, arrows, a hover time when `tip` is given. */
function Rail({
  value,
  buffered,
  label,
  valueText,
  max,
  now,
  onChange,
  onStep,
  tip,
  className,
}: {
  value: number;
  buffered?: number;
  label: string;
  valueText: string;
  max: number;
  now: number;
  onChange: (value: number, final: boolean) => void;
  onStep: (direction: 1 | -1) => void;
  tip?: (at: number) => string;
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const at = (el: HTMLElement, x: number) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 ? clamp((x - r.left) / r.width) : 0;
  };
  const grab = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.focus({ preventScroll: true });
    setDrag(true);
    onChange(at(el, e.clientX), false);
    const move = (ev: globalThis.PointerEvent) => {
      const v = at(el, ev.clientX);
      setHover(v);
      onChange(v, false);
    };
    const up = (ev: globalThis.PointerEvent) => {
      onChange(at(el, ev.clientX), true);
      setDrag(false);
      setHover(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const up = e.key === "ArrowRight" || e.key === "ArrowUp";
    const down = e.key === "ArrowLeft" || e.key === "ArrowDown";
    const step = up ? 1 : down ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    onStep(step);
  };
  const shown = hover ?? null;
  return (
    <div
      className={cx("ac-video__rail", className)}
      data-drag={drag || undefined}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(now)}
      aria-valuetext={valueText}
      onPointerDown={grab}
      onPointerMove={(e) => !drag && e.pointerType === "mouse" && setHover(at(e.currentTarget, e.clientX))}
      onPointerLeave={() => !drag && setHover(null)}
      onKeyDown={keys}
    >
      <span className="ac-video__line">
        {buffered !== undefined && <span className="ac-video__buffered" style={{ width: `${buffered * 100}%` }} />}
        <span className="ac-video__filled" style={{ width: `${value * 100}%` }} />
        <span className="ac-video__knob" style={{ left: `${value * 100}%` }} />
      </span>
      {tip && shown !== null && (
        <span className="ac-video__tip" style={{ left: `${shown * 100}%` }} aria-hidden="true">
          {tip(shown)}
        </span>
      )}
    </div>
  );
}

/**
 * A video with our own controls: stopped, its first frame with a play key in the middle and its length in a small
 * badge at its foot (no name over the picture, as a picture's tile has none); playing, a glass bar over its foot (play, timeline, time, speed, sound, full
 * screen) that hides when the pointer rests. A click on the picture plays or pauses it (a touch shows the bar first);
 * Space or K, ← →, M and F from the keyboard. One thing plays at a time, voice messages included.
 */
export function VideoPlayer({
  src,
  name,
  variant = "tile",
  labels,
  onOpen,
  actions,
  onFailed,
  children,
  className,
}: VideoPlayerProps) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTouch = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [waiting, setWaiting] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [full, setFull] = useState(false);

  const pause = useCallback(() => video.current?.pause(), []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(hideTimer.current);
      video.current?.pause();
      releasePlayback(pause);
    },
    [pause],
  );
  useEffect(() => {
    const changed = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  /** Shows the bar; while it plays, hides it again after the pointer rests. */
  const wake = useCallback(() => {
    setHidden(false);
    clearTimeout(hideTimer.current);
    const v = video.current;
    if (v && !v.paused) {
      hideTimer.current = setTimeout(() => {
        if (!root.current?.querySelector("[data-drag]")) setHidden(true);
      }, IDLE_MS);
    }
  }, []);

  const tick = useCallback(() => {
    const v = video.current;
    if (!v) return;
    setTime(v.currentTime);
    frame.current = requestAnimationFrame(tick);
  }, []);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused || v.ended) {
      v.play().catch(() => undefined);
    } else v.pause();
  };
  const seekTo = (seconds: number) => {
    const v = video.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, seconds));
    setTime(v.currentTime);
    if (phase === "idle" || phase === "ended") setPhase("paused");
  };
  const toggleFull = () => {
    const el = root.current;
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
    // iPhone Safari has full screen only on the video itself (its own controls there).
    else v?.webkitEnterFullscreen?.();
  };
  const toggleMute = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 1;
  };

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest(".ac-video__rail")) return;
    const k = e.key.toLowerCase();
    if (k === " " || k === "k") {
      // Space on a button presses that button.
      if (k === " " && (e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      toggle();
    } else if (k === "arrowright" || k === "arrowleft") {
      e.preventDefault();
      seekTo((video.current?.currentTime ?? 0) + (k === "arrowright" ? STEP_S : -STEP_S));
    } else if (k === "m") toggleMute();
    else if (k === "f") toggleFull();
    else return;
    wake();
  };

  const onPicture = () => {
    // A touch on a playing video with its bar hidden shows the bar; the next one pauses.
    if (lastTouch.current && phase === "playing" && hidden) {
      wake();
      return;
    }
    toggle();
  };

  const tile = variant === "tile";
  const playLabel = phase === "ended" ? labels.replay : phase === "playing" ? labels.pause : labels.play;
  const lengthText = duration > 0 ? clock(duration) : "";
  const progress = duration > 0 ? clamp(time / duration) : 0;
  const silent = muted || volume === 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys belong to the player's focusable controls inside it
    <div
      ref={root}
      className={cx("ac-video", `ac-video--${variant}`, className)}
      data-phase={phase}
      data-hide={(hidden && phase === "playing") || undefined}
      data-full={full || undefined}
      tabIndex={-1}
      onKeyDown={keys}
      onClick={(e) => {
        if (e.target === video.current) onPicture();
      }}
      onPointerMove={(e) => e.pointerType === "mouse" && wake()}
      onPointerDown={(e) => {
        lastTouch.current = e.pointerType !== "mouse";
      }}
      onPointerLeave={() => {
        if (phase === "playing") setHidden(true);
      }}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: people's own uploads carry no captions track */}
      <video
        ref={video}
        className="ac-video__media"
        // `#t`: the first frame shows before it plays (Safari shows nothing otherwise).
        src={`${src}${src.includes("#") ? "" : "#t=0.001"}`}
        preload="metadata"
        playsInline
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onPlay={() => {
          claimPlayback(pause);
          setPhase("playing");
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(tick);
          wake();
        }}
        onPause={(e) => {
          cancelAnimationFrame(frame.current);
          releasePlayback(pause);
          setTime(e.currentTarget.currentTime);
          setPhase(e.currentTarget.ended ? "ended" : "paused");
          setHidden(false);
        }}
        onEnded={() => {
          setPhase("ended");
          setHidden(false);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
        onProgress={(e) => {
          const v = e.currentTarget;
          let end = 0;
          for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
          }
          if (Number.isFinite(v.duration) && v.duration > 0) setBuffered(clamp(end / v.duration));
        }}
        onVolumeChange={(e) => {
          setMuted(e.currentTarget.muted);
          setVolume(e.currentTarget.volume);
        }}
        onError={() => onFailed?.()}
      />

      {phase === "idle" && (
        <button
          type="button"
          className="ac-video__big"
          aria-label={`${labels.play}: ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          <Icon name="play" />
        </button>
      )}

      {waiting && phase === "playing" && (
        <span className="ac-video__waiting" aria-hidden="true">
          <PixelSpinner size={16} />
        </span>
      )}

      {tile && phase === "idle" && lengthText && (
        <span className="ac-video__length tabular" aria-hidden="true">
          {lengthText}
        </span>
      )}

      {tile && (onOpen || actions) && (
        // biome-ignore lint/a11y/noStaticElementInteractions: only keeps a click on its buttons off the picture
        <span className="ac-video__acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {onOpen && (
            <button
              type="button"
              className="ac-video__open"
              aria-label={labels.open}
              title={labels.open}
              onClick={() => {
                video.current?.pause();
                onOpen();
              }}
            >
              <Icon name="expand" size={16} />
            </button>
          )}
          {actions}
        </span>
      )}

      {children}

      {/* `inert` while hidden: the keys stay on the player, the bar's buttons leave the tab order. */}
      <div className="ac-video__bar" inert={phase === "idle" || undefined}>
        <button
          type="button"
          className="ac-video__btn ac-video__play"
          data-ended={phase === "ended" || undefined}
          aria-label={playLabel}
          title={playLabel}
          onClick={toggle}
        >
          <Icon name={phase === "ended" ? "replay" : phase === "playing" ? "pause" : "play"} size={18} />
        </button>
        <Rail
          className="ac-video__seek"
          value={progress}
          buffered={buffered}
          label={labels.seek}
          valueText={clock(time)}
          max={duration}
          now={time}
          onChange={(v) => seekTo(v * duration)}
          onStep={(d) => seekTo(time + d * STEP_S)}
          tip={(at) => clock(at * duration)}
        />
        <span className="ac-video__time tabular">
          {clock(time)}
          <span className="ac-video__total"> / {clock(duration)}</span>
        </span>
        <button
          type="button"
          className="ac-video__speed tabular"
          aria-label={labels.speed(speed)}
          title={labels.speed(speed)}
          onClick={() => {
            const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
            setSpeed(next);
            if (video.current) video.current.playbackRate = next;
          }}
        >
          {speed}×
        </button>
        <span className="ac-video__sound">
          <button
            type="button"
            className="ac-video__btn"
            aria-label={silent ? labels.unmute : labels.mute}
            title={silent ? labels.unmute : labels.mute}
            onClick={toggleMute}
          >
            <Icon name={silent ? "mute" : "volume"} size={18} />
          </button>
          <span className="ac-video__volume">
            <Rail
              value={silent ? 0 : volume}
              label={labels.volume}
              valueText={`${Math.round((silent ? 0 : volume) * 100)}%`}
              max={100}
              now={Math.round((silent ? 0 : volume) * 100)}
              onChange={(v) => {
                const el = video.current;
                if (!el) return;
                el.volume = v;
                el.muted = v === 0;
              }}
              onStep={(d) => {
                const el = video.current;
                if (!el) return;
                el.volume = clamp(Math.round((el.volume + d * 0.1) * 10) / 10);
                el.muted = el.volume === 0;
              }}
            />
          </span>
        </span>
        <button
          type="button"
          className="ac-video__btn"
          aria-label={full ? labels.exitFullscreen : labels.fullscreen}
          title={full ? labels.exitFullscreen : labels.fullscreen}
          onClick={toggleFull}
        >
          <Icon name={full ? "fullscreenExit" : "fullscreen"} size={18} />
        </button>
      </div>
    </div>
  );
}
