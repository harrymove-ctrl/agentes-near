import { describe, expect, test } from "bun:test";
import { cleanTerms, createSpeechEngine, SpeechError, type SpeechFetch, silentWav } from "../src/speech";

type Call = { url: string; init?: RequestInit };

/** A fake provider: each call takes the next answer, and is recorded. */
function fake(...answers: Response[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answers.shift() ?? Response.json({});
  }) as unknown as SpeechFetch;
  return { fetch, calls };
}

const options = (f: { fetch: SpeechFetch }) => ({ fetch: f.fetch, sleep: async () => {} });
const input = { audio: silentWav(), contentType: "audio/mp4", language: "pt", terms: ["Ada", "Theo"] };
const form = (call: Call | undefined) => call?.init?.body as FormData;
const json = (call: Call | undefined) => JSON.parse(String(call?.init?.body));

describe("providers", () => {
  test("AssemblyAI uploads, asks and polls until it is done", async () => {
    const f = fake(
      Response.json({ upload_url: "https://cdn.example/a" }),
      Response.json({ id: "t1" }),
      Response.json({ status: "processing" }),
      Response.json({ status: "completed", text: "Ada, oi" }),
    );
    const engine = createSpeechEngine("assemblyai", { apiKey: "key" }, options(f));
    expect(await engine?.file(input)).toEqual({ text: "Ada, oi" });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.assemblyai.com/v2/upload",
      "https://api.assemblyai.com/v2/transcript",
      "https://api.assemblyai.com/v2/transcript/t1",
      "https://api.assemblyai.com/v2/transcript/t1",
    ]);
    expect(json(f.calls[1])).toMatchObject({ keyterms_prompt: ["Ada", "Theo"] });
  });

  test("AssemblyAI reads no speech as an empty answer", async () => {
    const f = fake(
      Response.json({ upload_url: "u" }),
      Response.json({ id: "t1" }),
      Response.json({ status: "error", error: "language_detection cannot be performed: no spoken audio" }),
    );
    expect(await createSpeechEngine("assemblyai", { apiKey: "key" }, options(f))?.file(input)).toEqual({ text: "" });
  });

  test("ElevenLabs sends the terms one by one", async () => {
    const f = fake(Response.json({ text: "oi" }));
    expect(await createSpeechEngine("elevenlabs", { apiKey: "key" }, options(f))?.file(input)).toEqual({ text: "oi" });
    expect(f.calls[0]?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(form(f.calls[0]).getAll("keyterms")).toEqual(["Ada", "Theo"]);
    expect(form(f.calls[0]).get("model_id")).toBe("scribe_v2");
  });

  test("Soniox leaves nothing behind at the provider", async () => {
    const f = fake(
      Response.json({ id: "f1" }),
      Response.json({ id: "t1" }),
      Response.json({ status: "completed" }),
      Response.json({ text: "oi" }),
    );
    expect(await createSpeechEngine("soniox", { apiKey: "key" }, options(f))?.file(input)).toEqual({ text: "oi" });
    const deleted = f.calls.filter((c) => c.init?.method === "DELETE").map((c) => c.url);
    expect(deleted).toEqual(["https://api.soniox.com/v1/transcriptions/t1", "https://api.soniox.com/v1/files/f1"]);
  });

  test("Groq, OpenAI, DeepInfra and a local server speak the same format", async () => {
    for (const [provider, credentials, url] of [
      ["groq", { apiKey: "key" }, "https://api.groq.com/openai/v1/audio/transcriptions"],
      ["openai", { apiKey: "key" }, "https://api.openai.com/v1/audio/transcriptions"],
      ["deepinfra", { apiKey: "key" }, "https://api.deepinfra.com/v1/openai/audio/transcriptions"],
      ["local", { baseUrl: "http://whisper:8000/v1/" }, "http://whisper:8000/v1/audio/transcriptions"],
    ] as const) {
      const f = fake(Response.json({ text: "oi" }));
      expect(await createSpeechEngine(provider, credentials, options(f))?.file(input)).toEqual({ text: "oi" });
      expect(f.calls[0]?.url).toBe(url);
      expect(form(f.calls[0]).get("prompt")).toBe("Ada, Theo");
    }
  });

  test("DeepInfra gets Whisper large v3 turbo and its key, never the app's language or the workspace", async () => {
    const f = fake(Response.json({ text: "Oi, tudo bem?" }));
    const engine = createSpeechEngine("deepinfra", { apiKey: "fake-deepinfra-key" }, options(f));
    expect(await engine?.file({ ...input, orgId: "org-1" })).toEqual({ text: "Oi, tudo bem?" });
    const [call] = f.calls;
    expect(call?.url).toBe("https://api.deepinfra.com/v1/openai/audio/transcriptions");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers).toEqual({ authorization: "Bearer fake-deepinfra-key" });
    expect(form(call).get("model")).toBe("openai/whisper-large-v3-turbo");
    expect(form(call).get("file")).toBeInstanceOf(File);
    expect(form(call).get("language")).toBeNull();
  });

  test("the app's language goes only where it is a hint: every other engine hears the language in the audio", async () => {
    // Someone with the app in English may speak Portuguese, and Whisper takes `language` as an order.
    for (const [provider, credentials, field] of [
      ["groq", { apiKey: "key" }, "language"],
      ["openai", { apiKey: "key" }, "language"],
      ["local", { baseUrl: "http://speech/v1" }, "language"],
      ["elevenlabs", { apiKey: "key" }, "language_code"],
    ] as const) {
      const f = fake(Response.json({ text: "oi" }));
      await createSpeechEngine(provider, credentials, options(f))?.file(input);
      expect(form(f.calls[0]).get(field)).toBeNull();
    }
    const assembly = fake(
      Response.json({ upload_url: "u" }),
      Response.json({ id: "t1" }),
      Response.json({ status: "completed" }),
    );
    await createSpeechEngine("assemblyai", { apiKey: "key" }, options(assembly))?.file(input);
    expect(json(assembly.calls[1]).language_code).toBeUndefined();
    const soniox = fake(
      Response.json({ id: "f1" }),
      Response.json({ id: "t1" }),
      Response.json({ status: "completed" }),
    );
    await createSpeechEngine("soniox", { apiKey: "key" }, options(soniox))?.file(input);
    expect(json(soniox.calls[1]).language_hints).toEqual(["pt"]);
  });

  test("a server of one's own that says a language isn't for it is refused at once, so the next engine tries", async () => {
    const notForMe = Response.json(
      { error: { message: "Parakeet doesn't know this language (it heard ja)", code: "unsupported_language" } },
      { status: 422 },
    );
    const f = fake(notForMe);
    const error = await createSpeechEngine("local", { baseUrl: "http://speech/v1" }, options(f))
      ?.file(input)
      .catch((e: unknown) => e);
    expect((error as SpeechError).reason).toBe("refused");
    expect(f.calls).toHaveLength(1);
  });

  test("a server of one's own is told the workspace and its key; a provider is never told the workspace", async () => {
    const local = fake(Response.json({ text: "oi" }));
    await createSpeechEngine("local", { baseUrl: "http://speech/v1", apiKey: "own-key" }, options(local))?.file({
      ...input,
      orgId: "org-1",
    });
    expect(local.calls[0]?.init?.headers).toEqual({ authorization: "Bearer own-key", "x-agentes-org": "org-1" });
    for (const provider of ["groq", "openai"] as const) {
      const f = fake(Response.json({ text: "oi" }));
      await createSpeechEngine(provider, { apiKey: "key" }, options(f))?.file({ ...input, orgId: "org-1" });
      expect(f.calls[0]?.init?.headers).toEqual({ authorization: "Bearer key" });
    }
  });

  test("a server that gives no answer in time is busy, so the next engine tries", async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as SpeechFetch;
    const error = await createSpeechEngine("local", { baseUrl: "http://speech/v1" }, { fetch: hanging, timeoutMs: 20 })
      ?.file(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechError);
    expect((error as SpeechError).reason).toBe("busy");
  });

  test("a warm-up goes to a server of one's own only where asked for, and never throws", async () => {
    const warm = fake(new Response(null, { status: 202 }));
    const engine = createSpeechEngine("local", { baseUrl: "http://speech/v1/", warm: true }, options(warm));
    engine?.warm?.("org-1");
    await Bun.sleep(1);
    expect(warm.calls.map((call) => [call.url, call.init?.method, call.init?.headers])).toEqual([
      ["http://speech/v1/warm", "POST", { "x-agentes-org": "org-1" }],
    ]);
    expect(createSpeechEngine("local", { baseUrl: "http://speech/v1" })?.warm).toBeUndefined();
    expect(createSpeechEngine("groq", { apiKey: "key" })?.warm).toBeUndefined();
    const failing = (async () => {
      throw new Error("down");
    }) as unknown as SpeechFetch;
    expect(() =>
      createSpeechEngine("local", { baseUrl: "http://speech/v1", warm: true }, { fetch: failing })?.warm?.("org-1"),
    ).not.toThrow();
  });

  test("what a provider needs is required", () => {
    expect(createSpeechEngine("groq", {})).toBeNull();
    expect(createSpeechEngine("deepinfra", {})).toBeNull();
    expect(createSpeechEngine("local", {})).toBeNull();
  });
});

describe("errors", () => {
  test("say whether another try can work, and never carry the key", async () => {
    for (const provider of ["elevenlabs", "deepinfra"] as const) {
      for (const [status, reason] of [
        [401, "auth"],
        [429, "busy"],
        [500, "busy"],
        [503, "busy"],
        [400, "refused"],
      ] as const) {
        const f = fake(new Response("nope", { status }));
        const error = await createSpeechEngine(provider, { apiKey: "secret-key" }, options(f))
          ?.file(input)
          .catch((e) => e);
        expect(error).toBeInstanceOf(SpeechError);
        expect((error as SpeechError).reason).toBe(reason);
        expect((error as SpeechError).message).not.toContain("secret-key");
      }
    }
  });
});

test("cleanTerms drops repeats, long phrases and refused characters", () => {
  expect(cleanTerms(["Ada", "ada", "x", "a b c d e f g", "<Theo>"], 10, 6)).toEqual(["Ada", "Theo"]);
  expect(cleanTerms(["Ada", "Theo", "Lia"], 2, 6)).toEqual(["Ada", "Theo"]);
});
