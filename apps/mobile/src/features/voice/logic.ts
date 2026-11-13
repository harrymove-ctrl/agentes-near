import type { Message } from "@agenteschat/client";
import { VOICE_COUNTDOWN_MS, VOICE_MAX_MS, voiceOf } from "@agenteschat/client/lib/voice";

/**
 * Voice messages on the phone (ADR 0100), the part with no device in it: how a recording's gestures read and how
 * levels become a wave. What the web shares is in `@agenteschat/client/lib/voice`.
 */
/** How long a press is held before it records. */
export const HOLD_MS = 220;
/** How far left deletes, and how far up locks. */
export const CANCEL_X = -110;
export const LOCK_Y = -70;
export const VOICE_SPEEDS = [1, 1.5, 2] as const;

/** A level from 0 to 1 from the recorder's decibels (-160 to 0); what is below -50 is silence. */
export function levelOf(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0.04;
  return Math.min(1, Math.max(0.04, (db + 50) / 50));
}

/** `levels` in `n` bars, each the loudest of its stretch, so a short word stays visible. */
export function peaksOf(levels: readonly number[], n = 48): number[] {
  if (levels.length === 0) return [];
  if (levels.length <= n) return levels.map((l) => Math.round(l * 1000) / 1000);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * levels.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / n));
    let top = 0;
    for (let k = from; k < to; k++) top = Math.max(top, levels[k] ?? 0);
    out.push(Math.round(top * 1000) / 1000);
  }
  return out;
}

/** A finger's position during a hold: what it asks for now. */
export function slideIntent(dx: number, dy: number): "cancel" | "lock" | null {
  "worklet";
  if (dx <= CANCEL_X) return "cancel";
  if (dy <= LOCK_Y) return "lock";
  return null;
}

/** What the clock shows: seconds left near the limit, else null. */
export function secondsLeft(ms: number): number | null {
  const left = VOICE_MAX_MS - ms;
  return left <= VOICE_COUNTDOWN_MS ? Math.max(0, Math.ceil(left / 1000)) : null;
}

export const nextSpeed = (speed: number) =>
  VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(speed as (typeof VOICE_SPEEDS)[number]) + 1) % VOICE_SPEEDS.length] ?? 1;

/** Whether a message has words to open: not when no engine could make them out, nor before the server answers. */
export function hasWords(message: Pick<Message, "body" | "meta" | "local">): boolean {
  return !message.local && !voiceOf(message.meta)?.noWords && message.body.trim() !== "";
}

/** Waits between upload tries, while the phone has no way through. */
export function retryDelayMs(attempt: number): number {
  return [2_000, 5_000, 15_000, 30_000][Math.min(attempt, 3)] ?? 30_000;
}

/** An answer to an upload: done, wait and try again, or never going to work. */
export function uploadVerdict(status: number): "done" | "retry" | "refused" {
  if (status >= 200 && status < 300) return "done";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "refused";
}
