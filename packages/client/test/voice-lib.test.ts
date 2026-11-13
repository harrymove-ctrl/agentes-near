import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Message } from "../src/api/types";
import { quoteText, textOrMedia } from "../src/lib/media";
import { previewBody } from "../src/lib/message-body";
import { localMeta } from "../src/lib/reply";
import { voiceAudioGone, voiceClock, voiceExpired, voiceOf } from "../src/lib/voice";

const t = ((key: string, params?: { time?: string }) =>
  key === "voice.wordTime" ? `Voz · ${params?.time}` : key === "voice.word" ? "Voz" : key) as unknown as TFunction;
const voice = { clipId: "c1", durationMs: 12_000, peaks: [0.2, 0.5] };

describe("voice messages' helpers (ADR 0100)", () => {
  test("voiceOf reads what the server writes and refuses anything else", () => {
    expect(voiceOf({ voice: { ...voice, noWords: true, expiresAt: "2030-01-01T00:00:00Z" } })).toEqual({
      ...voice,
      noWords: true,
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(voiceOf({ voice: { clipId: 1 } })).toBeNull();
    expect(voiceOf({})).toBeNull();
    expect(voiceOf(null)).toBeNull();
  });

  test("expires by its date, and a recording with no date doesn't", () => {
    expect(voiceExpired({ expiresAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z"))).toBe(true);
    expect(voiceExpired({ expiresAt: "2026-01-03T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z"))).toBe(false);
    expect(voiceExpired({})).toBe(false);
  });

  test("the words never reach a line: lists, quotes and previews name the audio", () => {
    expect(textOrMedia(t, "the secret words", { voice })).toBe("Voz · 0:12");
    expect(previewBody(t, "the secret words", { voice: { durationMs: 12_000 } })).toBe("Voz · 0:12");
    expect(previewBody(t, "", null, "voice")).toBe("Voz");
    expect(quoteText(t, { excerpt: "the secret words", media: "voice" })).toBe("Voz");
  });

  test("quoting a voice message carries no words", () => {
    const quote = { id: "m1", threadId: null, author: { type: "person", id: "u" }, body: "words", meta: { voice } };
    const meta = localMeta(quote as unknown as Message, "Ana", []);
    expect(meta.replyTo).toMatchObject({ excerpt: "", media: "voice" });
  });

  test("the clock", () => {
    expect(voiceClock(0)).toBe("0:00");
    expect(voiceClock(65_400)).toBe("1:05");
  });

  test("only a 410 reads as gone: a redirect or no connection doesn't", async () => {
    const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(await voiceAudioGone("/a", answer(410))).toBe(true);
    expect(await voiceAudioGone("/a", answer(200))).toBe(false);
    const offline = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await voiceAudioGone("/a", offline)).toBe(false);
  });
});
