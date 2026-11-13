import type { TFunction } from "i18next";
import type { MessageVoice } from "../api/types";

/**
 * Voice messages (ADR 0100), the half the web and the phone app share. To people a voice message is its audio: a list,
 * a quote or a notification names it, and its words open only on demand, in the player.
 */

type Meta = Record<string, unknown> | null | undefined;

/** The longest recording, as the server takes it. */
export const VOICE_MAX_MS = 5 * 60_000;
/** The clock counts down over the last seconds. */
export const VOICE_COUNTDOWN_MS = 15_000;
/** Below this a recording is a slip of the finger. */
export const VOICE_MIN_MS = 700;
/** Bars of the wave sent with a recording. */
export const VOICE_PEAKS = 48;

/** A message's voice recording, read the way the server writes it; null for any other message. */
export function voiceOf(meta: Meta): MessageVoice | null {
  const v = meta?.voice;
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.clipId !== "string" || typeof o.durationMs !== "number") return null;
  return {
    clipId: o.clipId,
    durationMs: o.durationMs,
    peaks: Array.isArray(o.peaks) ? o.peaks.filter((p): p is number => typeof p === "number") : [],
    ...(typeof o.expiresAt === "string" ? { expiresAt: o.expiresAt } : {}),
    ...(o.noWords === true ? { noWords: true } : {}),
  };
}

/** Whether its date passed. The server may also answer 410 before that (`voiceAudioGone`). */
export function voiceExpired(voice: Pick<MessageVoice, "expiresAt">, now = Date.now()) {
  if (!voice.expiresAt) return false;
  const at = Date.parse(voice.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/** "0:12". */
export function voiceClock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What stands for a voice message where its text would show: "Mensagem de voz · 0:12". */
export function voiceWord(t: TFunction, durationMs?: number | null) {
  return typeof durationMs === "number" && durationMs > 0
    ? t("voice.wordTime", { time: voiceClock(durationMs) })
    : t("voice.word");
}

/** A voice message's length in a message's `meta` or a list's preview `meta`; undefined for any other. */
export function voiceLength(meta: Meta): number | undefined {
  const v = meta?.voice;
  if (typeof v !== "object" || v === null) return undefined;
  const ms = (v as { durationMs?: unknown }).durationMs;
  return typeof ms === "number" ? ms : undefined;
}

/** Whether a message's `meta` or a preview's says it is a voice message. */
export const isVoiceMeta = (meta: Meta) => voiceLength(meta) !== undefined;

/** Where a recording plays from. `base` is the server for the phone app (`""` on the web: the same origin). */
export function voiceAudioUrl(orgId: string, clipId: string, base = "") {
  const path = `/api/app/organizations/${encodeURIComponent(orgId)}/voice/${encodeURIComponent(clipId)}/audio`;
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * Asks whether a recording is gone (410), without downloading it: a redirect to the store isn't followed, and a
 * recording the server sends itself is cut off once its headers are in. No answer counts as not gone, so a bad
 * connection never reads as expired.
 */
export async function voiceAudioGone(url: string, request: typeof fetch = fetch) {
  const stop = new AbortController();
  try {
    const res = await request(url, { credentials: "include", redirect: "manual", signal: stop.signal });
    return res.status === 410;
  } catch {
    return false;
  } finally {
    stop.abort();
  }
}
