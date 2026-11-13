import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryBlobStore, type SpeechEngine, SpeechError, type SpeechProviderId } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  acceptVoiceClip,
  createLocalKeyWrapper,
  createSpeechSettings,
  envSpeechEngines,
  previewMediaKind,
  previewMeta,
  readableBody,
  renderPush,
  replyExcerpt,
  storedBytes,
  sweepExpiredVoice,
  transcribeVoiceClip,
  VOICE_NO_WORDS_BODY,
  type VoiceDeps,
  type VoiceLimits,
  voiceAllowed,
  voiceClipAudio,
  voiceOf,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";

const { voiceClips, messages } = schema;

let f: Fixture;
afterEach(async () => {
  // Tests with no database of their own must not close the last one again.
  await f?.close();
  f = undefined as unknown as Fixture;
});

const DAY = 24 * 3600_000;

/** A fake engine: each call takes the next answer; an Error is thrown. */
function engine(
  ...answers: (string | Error)[]
): SpeechEngine & { terms: string[][]; sent: { orgId?: string; durationMs?: number }[] } {
  const terms: string[][] = [];
  const sent: { orgId?: string; durationMs?: number }[] = [];
  return {
    id: "groq" as SpeechProviderId,
    model: "fake",
    nanoUsdPerHour: 3_600_000_000,
    minBilledSeconds: 0,
    terms,
    sent,
    async file(input) {
      terms.push(input.terms);
      sent.push({ orgId: input.orgId, durationMs: input.durationMs });
      const next = answers.shift() ?? "";
      if (next instanceof Error) throw next;
      return { text: next };
    },
  };
}

const voiceDeps = (engines: SpeechEngine[], over: Partial<VoiceDeps> = {}): VoiceDeps => ({
  db: f.db,
  pubsub: f.pubsub,
  blobs: f.artifactDeps.blobs,
  engines: () => engines,
  limits: null,
  retentionDays: 90,
  ...over,
});

const recording = (over: Partial<Parameters<typeof acceptVoiceClip>[4]> = {}) => ({
  audio: new Uint8Array([1, 2, 3, 4]),
  contentType: "audio/mp4",
  durationMs: 3000,
  peaks: [0.1, 2, -1, "x"],
  clientId: crypto.randomUUID(),
  ...over,
});

const accept = (deps: VoiceDeps, over: Parameters<typeof recording>[0] = {}) =>
  acceptVoiceClip(deps, f.owner.id, f.org.id, f.general.id, recording(over));

const clipOf = async (id: string) => {
  const [clip] = await f.db.select().from(voiceClips).where(eq(voiceClips.id, id));
  if (!clip) throw new Error("no clip");
  return clip;
};

const age = (id: string, days: number) =>
  f.db
    .update(voiceClips)
    .set({ createdAt: new Date(Date.now() - days * DAY) })
    .where(eq(voiceClips.id, id));

const messageOf = async (clipId: string) => {
  const clip = await clipOf(clipId);
  if (!clip.messageId) return null;
  const [m] = await f.db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, f.org.id), eq(messages.id, clip.messageId)));
  return m ?? null;
};

describe("sending", () => {
  test("the recording becomes a message whose words are in its body", async () => {
    f = await setup();
    const fake = engine("Ada, puxa as vendas");
    const deps = voiceDeps([fake]);
    const { clipId } = await accept(deps);
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    const message = await messageOf(clipId);
    expect(message?.body).toBe("Ada, puxa as vendas");
    const voice = voiceOf(message?.meta);
    expect(voice).toMatchObject({ clipId, durationMs: 3000, peaks: [0.1, 1, 0, 0] });
    expect(voice?.noWords).toBeUndefined();
    expect(fake.terms[0]).toContain(f.agent.name);
    // The engine knows whose recording it is and how long: a server of one's own routes and times by them.
    expect(fake.sent[0]).toEqual({ orgId: f.org.id, durationMs: 3000 });
    expect((await clipOf(clipId)).status).toBe("sent");
    expect((await clipOf(clipId)).costNanoUsd).toBe(3_000_000);
  });

  test("a resend finds what the first send stored, and a second run posts nothing new", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")]);
    const clientId = "same";
    const first = await accept(deps, { clientId });
    expect(await accept(deps, { clientId })).toEqual(first);
    await transcribeVoiceClip(deps, first.clipId, { finalAttempt: false });
    await transcribeVoiceClip(deps, first.clipId, { finalAttempt: false });
    const rows = await f.db.select().from(messages).where(eq(messages.channelId, f.general.id));
    expect(rows.filter((m) => voiceOf(m.meta))).toHaveLength(1);
  });

  test("a recording whose workspace began being deleted before its words came is dropped, never sent", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")]);
    const { clipId } = await accept(deps);
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * DAY) })
      .where(eq(schema.organizations.id, f.org.id));
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    expect((await clipOf(clipId)).status).toBe("dropped");
    expect(await messageOf(clipId)).toBeNull();
  });

  test("only audio is taken, within its limits, and only with an engine", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")]);
    await expect(accept(deps, { contentType: "text/html" })).rejects.toMatchObject({ code: "voice.bad_type" });
    await expect(accept(deps, { durationMs: 6 * 60_000 })).rejects.toMatchObject({ code: "voice.bad_duration" });
    await expect(accept(voiceDeps([]))).rejects.toMatchObject({ code: "voice.unavailable" });
  });

  test("the next engine takes over from one that fails", async () => {
    f = await setup();
    const deps = voiceDeps([engine(new SpeechError("busy", "down")), engine("oi")]);
    const { clipId } = await accept(deps);
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    expect((await messageOf(clipId))?.body).toBe("oi");
  });

  test("a slow engine gets the next one beside it after its time alone, and the first words win", async () => {
    f = await setup();
    let late: (value: { text: string }) => void = () => {};
    const slow: SpeechEngine = {
      ...engine(),
      id: "local" as SpeechProviderId,
      file: () => new Promise((resolve) => (late = resolve)),
    };
    const fast = { ...engine("oi, tudo certo"), id: "deepinfra" as SpeechProviderId };
    const deps = voiceDeps([slow, fast], { hedgeAfterMs: () => 10 });
    const { clipId } = await accept(deps);
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    expect((await messageOf(clipId))?.body).toBe("oi, tudo certo");
    expect((await clipOf(clipId)).engine).toBe("deepinfra");
    // The slow one's answer arriving afterwards changes nothing.
    late({ text: "tarde demais" });
    await Bun.sleep(5);
    expect((await messageOf(clipId))?.body).toBe("oi, tudo certo");
  });

  test("an engine that answers in time never wakes the next one", async () => {
    f = await setup();
    const first = engine("rápido");
    const second = engine("nunca");
    const deps = voiceDeps([first, second], { hedgeAfterMs: () => 50 });
    const { clipId } = await accept(deps);
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    await Bun.sleep(80);
    expect((await messageOf(clipId))?.body).toBe("rápido");
    expect(second.sent).toHaveLength(0);
  });

  test("a server of one's own that says the language isn't for it hands over at once, with no retry", async () => {
    f = await setup();
    // The speech service answers 422 for a language Parakeet doesn't know, which the adapter reads as refused.
    const own = engine(new SpeechError("refused", "The speech server answered 422: unsupported_language"));
    const next = engine("こんにちは");
    const deps = voiceDeps([own, next]);
    const { clipId } = await accept(deps);
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    expect((await messageOf(clipId))?.body).toBe("こんにちは");
    expect([own.sent.length, next.sent.length]).toEqual([1, 1]);
  });

  test("when the next engine fails too, the recording waits for a retry as before", async () => {
    f = await setup();
    const notForMe = () => new SpeechError("refused", "The speech server answered 422: unsupported_language");
    const busy = () => new SpeechError("busy", "Groq answered 503");
    const deps = voiceDeps([engine(notForMe(), notForMe()), engine(busy(), busy())]);
    const { clipId } = await accept(deps);
    await expect(transcribeVoiceClip(deps, clipId, { finalAttempt: false })).rejects.toBeInstanceOf(SpeechError);
    expect((await clipOf(clipId)).status).toBe("pending");
    await transcribeVoiceClip(deps, clipId, { finalAttempt: true });
    expect(voiceOf((await messageOf(clipId))?.meta)?.noWords).toBe(true);
  });

  test("a refusal after a busy engine still leaves the recording for a retry, in any order", async () => {
    f = await setup();
    // SPEECH_ENGINES=groq,local: Groq busy for a moment, then our server's "not for me".
    const busy = new SpeechError("busy", "Groq answered 503");
    const notForMe = new SpeechError("refused", "The speech server answered 422: unsupported_language");
    const deps = voiceDeps([engine(busy, "oi"), engine(notForMe)]);
    const { clipId } = await accept(deps);
    await expect(transcribeVoiceClip(deps, clipId, { finalAttempt: false })).rejects.toBe(busy);
    expect((await clipOf(clipId)).status).toBe("pending");
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    expect((await messageOf(clipId))?.body).toBe("oi");
  });

  test("SPEECH_ENGINES=local,deepinfra: DeepInfra takes what our server is too busy for or doesn't know", async () => {
    f = await setup();
    for (const status of [503, 422]) {
      const urls: string[] = [];
      const fetch = (async (url: string | URL | Request) => {
        urls.push(String(url));
        return String(url).startsWith("http://speech:8000/")
          ? Response.json({ error: { message: "not now" } }, { status })
          : Response.json({ text: "Oi, tudo bem?" });
      }) as unknown as typeof globalThis.fetch;
      const engines = envSpeechEngines(
        "local,deepinfra",
        { local: { baseUrl: "http://speech:8000/v1" }, deepinfra: { apiKey: "fake-deepinfra-key" } },
        { fetch },
      );
      const deps = voiceDeps(engines);
      const { clipId } = await accept(deps);
      await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
      expect((await messageOf(clipId))?.body).toBe("Oi, tudo bem?");
      expect(urls).toEqual([
        "http://speech:8000/v1/audio/transcriptions",
        "https://api.deepinfra.com/v1/openai/audio/transcriptions",
      ]);
      // 3 s at $0.012 an hour, with no minimum.
      expect(await clipOf(clipId)).toMatchObject({ status: "sent", engine: "deepinfra", costNanoUsd: 10_000 });
    }
  });
});

describe("when there are no words", () => {
  test("nothing said drops the recording and tells its sender", async () => {
    f = await setup();
    const deps = voiceDeps([engine("  ")]);
    const { clipId } = await accept(deps);
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    const clip = await clipOf(clipId);
    expect(clip.status).toBe("dropped");
    expect(clip.audioDeletedAt).not.toBeNull();
    expect(await messageOf(clipId)).toBeNull();
  });

  test("a failing engine retries, and the last try still sends the audio, marked as having no words", async () => {
    f = await setup();
    const down = () => new SpeechError("busy", "down");
    const deps = voiceDeps([engine(down(), down())]);
    const { clipId } = await accept(deps);
    await expect(transcribeVoiceClip(deps, clipId, { finalAttempt: false })).rejects.toBeInstanceOf(SpeechError);
    expect((await clipOf(clipId)).status).toBe("pending");
    await transcribeVoiceClip(deps, clipId, { finalAttempt: true });
    const message = await messageOf(clipId);
    expect(message?.body).toBe(VOICE_NO_WORDS_BODY);
    expect(voiceOf(message?.meta)?.noWords).toBe(true);
  });
});

describe("fair use", () => {
  const limits: VoiceLimits = { personMinutesPerDay: 1, orgMinutesPerMember: 0, orgMinMinutesPerDay: 0 };

  test("stops a person over the limit, never one recording short", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")], { limits });
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(true);
    await accept(deps, { durationMs: 90_000 });
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(false);
    await expect(accept(deps)).rejects.toMatchObject({ code: "voice.limit" });
  });

  test("a day later the minutes are back, and a recording's expiry doesn't give them back early", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")], { limits });
    const { clipId } = await accept(deps, { durationMs: 90_000 });
    await f.db.update(voiceClips).set({ audioDeletedAt: new Date() }).where(eq(voiceClips.id, clipId));
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(false);
    await age(clipId, 1.1);
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(true);
  });

  test("the workspace's cap is never below its minimum", async () => {
    f = await setup();
    const cap = { personMinutesPerDay: 0, orgMinutesPerMember: 1, orgMinMinutesPerDay: 2 };
    const deps = voiceDeps([engine("oi")], { limits: cap });
    await accept(deps, { durationMs: 90_000 });
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(true);
    await accept(deps, { durationMs: 90_000 });
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(false);
  });

  test("no limits, as on any self-hosted server", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")]);
    await accept(deps, { durationMs: 300_000 });
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(true);
  });
});

describe("retention", () => {
  const sent = async (deps: VoiceDeps) => {
    const { clipId } = await accept(deps);
    await transcribeVoiceClip(deps, clipId, { finalAttempt: false });
    return clipId;
  };

  test("the message says when the recording goes; with retention off, it doesn't", async () => {
    f = await setup();
    const clipId = await sent(voiceDeps([engine("oi")]));
    const clip = await clipOf(clipId);
    const voice = voiceOf((await messageOf(clipId))?.meta);
    expect(voice?.expiresAt).toBe(new Date(clip.createdAt.getTime() + 90 * DAY).toISOString());
    const forever = await sent(voiceDeps([engine("oi")], { retentionDays: 0 }));
    expect(voiceOf((await messageOf(forever))?.meta)?.expiresAt).toBeUndefined();
  });

  test("the sweep takes the audio; the row and the words stay", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi", "tchau")]);
    const old = await sent(deps);
    const fresh = await sent(deps);
    await age(old, 91);
    expect(await sweepExpiredVoice(deps, { pageSize: 1 })).toEqual({ swept: 1, failed: 0 });
    const clip = await clipOf(old);
    expect(clip.audioDeletedAt).not.toBeNull();
    const store = await deps.blobs.forConfig(f.org.id, clip.storageConfigId);
    expect(await store.get(clip.blobKey)).toBeNull();
    expect((await messageOf(old))?.body).toBe("oi");
    expect((await clipOf(fresh)).audioDeletedAt).toBeNull();
    expect(await sweepExpiredVoice(deps)).toEqual({ swept: 0, failed: 0 });
  });

  test("goes through every page", async () => {
    f = await setup();
    const deps = voiceDeps([engine("a", "b", "c")]);
    const ids = [await sent(deps), await sent(deps), await sent(deps)];
    for (const id of ids) await age(id, 91);
    expect((await sweepExpiredVoice(deps, { pageSize: 2 })).swept).toBe(3);
  });

  test("a recording waiting for its words never expires", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")]);
    const { clipId } = await accept(deps);
    await age(clipId, 200);
    expect((await sweepExpiredVoice(deps)).swept).toBe(0);
    expect((await clipOf(clipId)).audioDeletedAt).toBeNull();
    expect(await voiceClipAudio(deps, f.owner.id, f.org.id, clipId)).not.toHaveProperty("expired");
  });

  test("retention 0 keeps everything", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")], { retentionDays: 0 });
    const clipId = await sent(deps);
    await age(clipId, 5000);
    expect((await sweepExpiredVoice(deps)).swept).toBe(0);
    expect(await voiceClipAudio(deps, f.owner.id, f.org.id, clipId)).not.toHaveProperty("expired");
  });

  test("playing answers expired once swept, and past its date before the sweep came", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi", "tchau")]);
    const swept = await sent(deps);
    await age(swept, 91);
    await sweepExpiredVoice(deps);
    expect(await voiceClipAudio(deps, f.owner.id, f.org.id, swept)).toEqual({ expired: true });
    const late = await sent(deps);
    await age(late, 91);
    expect(await voiceClipAudio(deps, f.owner.id, f.org.id, late)).toEqual({ expired: true });
  });

  test("a swept recording leaves what the workspace stores", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")]);
    const clipId = await sent(deps);
    expect((await storedBytes(f.db, f.org.id)).platformBytes).toBeGreaterThanOrEqual(4);
    const before = (await storedBytes(f.db, f.org.id)).platformBytes;
    await age(clipId, 91);
    await sweepExpiredVoice(deps);
    expect((await storedBytes(f.db, f.org.id)).platformBytes).toBe(before - 4);
  });

  test("a recording that can't be deleted stays for the next sweep", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")]);
    const clipId = await sent(deps);
    await age(clipId, 91);
    const broken = createMemoryBlobStore();
    broken.delete = async () => {
      throw new Error("down");
    };
    const failing = { ...deps, blobs: { ...deps.blobs, forConfig: async () => broken } };
    expect(await sweepExpiredVoice(failing)).toEqual({ swept: 0, failed: 1 });
    expect((await clipOf(clipId)).audioDeletedAt).toBeNull();
    expect((await sweepExpiredVoice(deps)).swept).toBe(1);
  });
});

describe("the words stay out of what lists a message", () => {
  const meta = { voice: { clipId: "c1", durationMs: 4000, peaks: [] } };

  test("previews say what it is, with no text", () => {
    expect(previewMediaKind("segredo", meta)).toBe("voice");
    expect(previewMeta(meta)?.voice).toEqual({ durationMs: 4000 });
    expect(JSON.stringify(previewMeta(meta))).not.toContain("segredo");
    expect(readableBody("segredo", meta)).toBe("");
    expect(readableBody("segredo", {})).toBe("segredo");
    expect(replyExcerpt(readableBody("segredo", meta))).toBe("");
  });

  test("push says a voice message was sent", () => {
    const out = renderPush("pt-BR", { kind: "dm", waiting: false, actorName: "Ada", media: "voice" });
    expect(out.body).toContain("mensagem de voz");
  });
});

describe("the owner's provider", () => {
  const settings = (fetch: typeof globalThis.fetch, envEngines: SpeechEngine[] = []) => {
    const keyWrapper = createLocalKeyWrapper(SECRET);
    return createSpeechSettings({ db: f.db, keyWrapper, keyWrappers: [keyWrapper], envEngines, fetch });
  };

  test("a refused key is never kept; an accepted one goes first and is never returned", async () => {
    f = await setup();
    let status = 401;
    const fetch = (async () =>
      status === 200
        ? Response.json({ text: "" })
        : new Response("no", { status })) as unknown as typeof globalThis.fetch;
    const speech = settings(fetch, [engine("oi")]);
    await speech.ready();
    await expect(speech.save({ provider: "elevenlabs", apiKey: "bad-key-123" }, f.owner.id)).rejects.toMatchObject({
      code: "speech_key_invalid",
    });
    expect((await speech.view()).state).toBe("off");
    status = 200;
    const view = await speech.save({ provider: "elevenlabs", apiKey: "good-key-1234" }, f.owner.id);
    expect(view).toMatchObject({ provider: "elevenlabs", hint: "1234", state: "ok" });
    expect(JSON.stringify(view)).not.toContain("good-key");
    expect(speech.chain().map((e) => e.id)).toEqual(["elevenlabs", "groq"]);
    expect((await speech.remove()).state).toBe("off");
    expect(speech.chain().map((e) => e.id)).toEqual(["groq"]);
  });
});
