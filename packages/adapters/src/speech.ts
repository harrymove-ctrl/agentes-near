/**
 * Speech to text behind one interface (ADR 0100): a provider is a small adapter that turns a stored recording into
 * words, so swapping one or chaining several touches nothing else. `file` works on the finished recording; an engine
 * for live audio would add its own method next to it.
 */
export interface SpeechFileInput {
  audio: Uint8Array;
  contentType: string;
  /**
   * The app's language (`pt`, `en`), not always the one spoken: only an engine that takes it as a hint gets it
   * (Soniox). The others detect the spoken language from the audio, and would take this as an order (Whisper does).
   */
  language: string | null;
  /** Names that must come out right: agents, people, channels. */
  terms: string[];
  /** The workspace it comes from: only a server of one's own is told, to route or count by it. */
  orgId?: string;
  /** How long the recording is: a server of the OpenAI format gets a time limit from it. */
  durationMs?: number;
}

export interface SpeechEngine {
  /** Provider id (`SPEECH_PROVIDERS`). */
  readonly id: SpeechProviderId;
  readonly model: string;
  /** What an hour of audio costs, in nano-USD. Zero on one's own server. */
  readonly nanoUsdPerHour: number;
  /** Seconds a provider bills at least, per request. */
  readonly minBilledSeconds: number;
  file(input: SpeechFileInput): Promise<{ text: string }>;
  /**
   * Tells a server of one's own that someone started recording in `orgId`, so its model loads while they speak. Only
   * where asked for (`warm`); never throws.
   */
  warm?(orgId: string): void;
}

/** `auth`: the key was refused, and retrying can't help. `busy`: try again or use the next engine. */
export class SpeechError extends Error {
  constructor(
    readonly reason: "auth" | "busy" | "refused",
    message: string,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

export type SpeechFetch = typeof fetch;

export const SPEECH_PROVIDERS = ["assemblyai", "elevenlabs", "soniox", "groq", "openai", "local", "deepinfra"] as const;
export type SpeechProviderId = (typeof SPEECH_PROVIDERS)[number];

export interface SpeechCredentials {
  /** Optional only for `local`, whose server may take none. */
  apiKey?: string;
  /** `local`: the address of a server speaking the OpenAI format, like the speech profile's `http://speech:8000/v1`. */
  baseUrl?: string;
  /** `local`: the model that server loads. */
  model?: string;
  /** `local`: whether the server is told when someone starts recording (`POST <baseUrl>/warm`). */
  warm?: boolean;
}

interface SpeechOptions {
  fetch?: SpeechFetch;
  /** Tests skip the wait between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a provider that works in the background may take. */
  timeoutMs?: number;
}

const USD = 1e9;
const POLL_MS = 700;
const TIMEOUT_MS = 5 * 60_000;
/** Terms sent at most: enough for a workspace's names, and below ElevenLabs' 100 where its minimum billing starts. */
const MAX_TERMS = 100;
/** Whisper's prompt holds about 224 tokens. */
const MAX_PROMPT_TERMS = 40;

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** A failed answer as an error that says whether another try can work. Never carries the key. */
async function refuse(res: Response, name: string): Promise<SpeechError> {
  const detail = (await res.text().catch(() => "")).slice(0, 200);
  const text = `${name} answered ${res.status}: ${detail}`;
  if (res.status === 401 || res.status === 403) return new SpeechError("auth", text);
  if (res.status === 402 || res.status === 429 || res.status >= 500) return new SpeechError("busy", text);
  return new SpeechError("refused", text);
}

/** Up to `max` distinct terms of at most `words` words, without the characters providers refuse. */
export function cleanTerms(terms: string[], max: number, words: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw
      .replace(/[<>{}[\]\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const key = term.toLowerCase();
    if (term.length < 2 || term.length >= 50 || term.split(" ").length > words || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === max) break;
  }
  return out;
}

const extensionOf = (contentType: string) => {
  const type = contentType.split(";")[0]?.trim() ?? "";
  if (type === "audio/webm") return "webm";
  if (type === "audio/wav" || type === "audio/x-wav") return "wav";
  if (type === "audio/mpeg") return "mp3";
  return "m4a";
};

const fileOf = (input: SpeechFileInput) =>
  new File([input.audio as Uint8Array<ArrayBuffer>], `voice.${extensionOf(input.contentType)}`, {
    type: input.contentType,
  });

/** Waits for a job a provider runs in the background; `read` answers null while it isn't done. */
async function poll<T>(read: () => Promise<T | null>, options: SpeechOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  for (;;) {
    const done = await read();
    if (done !== null) return done;
    if (Date.now() > deadline) throw new SpeechError("busy", "the provider took too long");
    await sleep(POLL_MS);
  }
}

function assemblyAi(apiKey: string, options: SpeechOptions): SpeechEngine {
  const http = options.fetch ?? fetch;
  const base = "https://api.assemblyai.com/v2";
  const headers = { authorization: apiKey };
  return {
    id: "assemblyai",
    model: "universal-3-5-pro",
    // $0.21 an hour, plus $0.05 with key terms, which every call sends.
    nanoUsdPerHour: 0.26 * USD,
    minBilledSeconds: 0,
    async file(input) {
      const upload = await http(`${base}/upload`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/octet-stream" },
        body: input.audio as Uint8Array<ArrayBuffer>,
      });
      if (!upload.ok) throw await refuse(upload, "AssemblyAI");
      const { upload_url: audioUrl } = (await upload.json()) as { upload_url: string };
      const terms = cleanTerms(input.terms, MAX_TERMS, 6);
      const created = await http(`${base}/transcript`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          audio_url: audioUrl,
          speech_models: ["universal-3-5-pro", "universal-2"],
          ...(terms.length > 0 ? { keyterms_prompt: terms } : {}),
        }),
      });
      if (!created.ok) throw await refuse(created, "AssemblyAI");
      const { id } = (await created.json()) as { id: string };
      return poll(async () => {
        const res = await http(`${base}/transcript/${id}`, { headers });
        if (!res.ok) throw await refuse(res, "AssemblyAI");
        const job = (await res.json()) as { status: string; text?: string | null; error?: string };
        if (job.status === "error") {
          // Nothing said at all is an answer, not a failure.
          if (/no spoken audio/i.test(job.error ?? "")) return { text: "" };
          throw new SpeechError("refused", `AssemblyAI: ${job.error ?? "failed"}`);
        }
        return job.status === "completed" ? { text: job.text ?? "" } : null;
      }, options);
    },
  };
}

function elevenLabs(apiKey: string, options: SpeechOptions): SpeechEngine {
  const http = options.fetch ?? fetch;
  return {
    id: "elevenlabs",
    model: "scribe_v2",
    // $0.22 an hour, plus the 20% key terms add.
    nanoUsdPerHour: 0.264 * USD,
    minBilledSeconds: 0,
    async file(input) {
      const form = new FormData();
      form.set("model_id", "scribe_v2");
      form.set("file", fileOf(input));
      form.set("tag_audio_events", "false");
      for (const term of cleanTerms(input.terms, MAX_TERMS, 5)) form.append("keyterms", term);
      const res = await http("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
      });
      if (!res.ok) throw await refuse(res, "ElevenLabs");
      const { text } = (await res.json()) as { text?: string };
      return { text: text ?? "" };
    },
  };
}

function soniox(apiKey: string, options: SpeechOptions): SpeechEngine {
  const http = options.fetch ?? fetch;
  const base = "https://api.soniox.com/v1";
  const headers = { authorization: `Bearer ${apiKey}` };
  return {
    id: "soniox",
    model: "stt-async-v5",
    nanoUsdPerHour: 0.1 * USD,
    minBilledSeconds: 0,
    async file(input) {
      const form = new FormData();
      form.set("file", fileOf(input));
      const upload = await http(`${base}/files`, { method: "POST", headers, body: form });
      if (!upload.ok) throw await refuse(upload, "Soniox");
      const { id: fileId } = (await upload.json()) as { id: string };
      try {
        const terms = cleanTerms(input.terms, MAX_TERMS, 6);
        const created = await http(`${base}/transcriptions`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            model: "stt-async-v5",
            file_id: fileId,
            ...(input.language ? { language_hints: [input.language] } : {}),
            ...(terms.length > 0 ? { context: { terms } } : {}),
          }),
        });
        if (!created.ok) throw await refuse(created, "Soniox");
        const { id } = (await created.json()) as { id: string };
        try {
          return await poll(async () => {
            const res = await http(`${base}/transcriptions/${id}`, { headers });
            if (!res.ok) throw await refuse(res, "Soniox");
            const job = (await res.json()) as { status: string; error_message?: string | null };
            if (job.status === "error") throw new SpeechError("refused", `Soniox: ${job.error_message ?? "failed"}`);
            if (job.status !== "completed") return null;
            const words = await http(`${base}/transcriptions/${id}/transcript`, { headers });
            if (!words.ok) throw await refuse(words, "Soniox");
            const { text } = (await words.json()) as { text?: string };
            return { text: text ?? "" };
          }, options);
        } finally {
          await http(`${base}/transcriptions/${id}`, { method: "DELETE", headers }).catch(() => undefined);
        }
      } finally {
        // People's voices don't stay at the provider longer than the answer takes.
        await http(`${base}/files/${fileId}`, { method: "DELETE", headers }).catch(() => undefined);
      }
    },
  };
}

/** The OpenAI format: OpenAI itself, Groq, DeepInfra, and a server of one's own (Speaches, a local Whisper or Parakeet). */
function openAiFormat(
  config: {
    id: SpeechProviderId;
    label: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    nanoUsdPerHour: number;
    minBilledSeconds: number;
    /** A server of one's own: told the workspace (`X-Agentes-Org`), never a provider. */
    ownServer?: boolean;
    warm?: boolean;
  },
  options: SpeechOptions,
): SpeechEngine {
  const http = options.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, "");
  const headers = (orgId: string | undefined): Record<string, string> => ({
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...(config.ownServer && orgId ? { "x-agentes-org": orgId } : {}),
  });
  return {
    id: config.id,
    model: config.model,
    nanoUsdPerHour: config.nanoUsdPerHour,
    minBilledSeconds: config.minBilledSeconds,
    async file(input) {
      const form = new FormData();
      form.set("model", config.model);
      form.set("file", fileOf(input));
      form.set("response_format", "json");
      const terms = cleanTerms(input.terms, MAX_PROMPT_TERMS, 6);
      if (terms.length > 0) form.set("prompt", terms.join(", "));
      // Twice the recording on top of half a minute: a server that takes longer is stuck, and the next engine tries.
      const limitMs = options.timeoutMs ?? 30_000 + 2 * (input.durationMs ?? TIMEOUT_MS);
      let res: Response;
      try {
        res = await http(`${base}/audio/transcriptions`, {
          method: "POST",
          headers: headers(input.orgId),
          body: form,
          signal: AbortSignal.timeout(limitMs),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new SpeechError("busy", `${config.label} gave no answer within ${Math.round(limitMs / 1000)} s`);
        }
        throw error;
      }
      if (!res.ok) throw await refuse(res, config.label);
      const { text } = (await res.json()) as { text?: string };
      return { text: text ?? "" };
    },
    ...(config.warm
      ? {
          warm(orgId: string) {
            void http(`${base}/warm`, {
              method: "POST",
              headers: headers(orgId),
              signal: AbortSignal.timeout(3000),
            }).catch(() => {});
          },
        }
      : {}),
  };
}

/** The adapter of one provider; null when what it needs is missing. */
export function createSpeechEngine(
  provider: SpeechProviderId,
  credentials: SpeechCredentials,
  options: SpeechOptions = {},
): SpeechEngine | null {
  const { apiKey, baseUrl, model } = credentials;
  if (provider === "local") {
    if (!baseUrl) return null;
    return openAiFormat(
      {
        id: "local",
        label: "The speech server",
        baseUrl,
        apiKey,
        model: model || "whisper-1",
        nanoUsdPerHour: 0,
        minBilledSeconds: 0,
        ownServer: true,
        warm: credentials.warm === true,
      },
      options,
    );
  }
  if (!apiKey) return null;
  if (provider === "assemblyai") return assemblyAi(apiKey, options);
  if (provider === "elevenlabs") return elevenLabs(apiKey, options);
  if (provider === "soniox") return soniox(apiKey, options);
  if (provider === "groq") {
    return openAiFormat(
      {
        id: "groq",
        label: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey,
        model: "whisper-large-v3-turbo",
        nanoUsdPerHour: 0.04 * USD,
        minBilledSeconds: 10,
      },
      options,
    );
  }
  if (provider === "deepinfra") {
    return openAiFormat(
      {
        id: "deepinfra",
        label: "DeepInfra",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiKey,
        model: "openai/whisper-large-v3-turbo",
        nanoUsdPerHour: 0.012 * USD,
        minBilledSeconds: 0,
      },
      options,
    );
  }
  return openAiFormat(
    {
      id: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey,
      model: "gpt-transcribe",
      nanoUsdPerHour: 0.27 * USD,
      minBilledSeconds: 0,
    },
    options,
  );
}

/** A second of silence in WAV: what a key is tried with before it is kept. */
export function silentWav(): Uint8Array {
  const rate = 16_000;
  const samples = rate;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}
