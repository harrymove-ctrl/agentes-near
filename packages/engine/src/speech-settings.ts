import {
  createSpeechEngine,
  type KeyWrapper,
  SPEECH_PROVIDERS,
  type SpeechCredentials,
  type SpeechEngine,
  SpeechError,
  type SpeechFetch,
  type SpeechProviderId,
  silentWav,
} from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { openSecret, sealSecret } from "./crypto";
import { ValidationError } from "./errors";

const { instanceSecrets } = schema;

/**
 * Which engines turn voice into text on this server (ADR 0100). The environment sets them on agentes.chat's servers
 * and may on any other; there, the installation's owner can also pick a provider and paste its key in Settings, kept
 * like the Jev key (ADR 0073): sealed, tried before it is kept, never returned. Read again behind a call once a minute
 * old, so a second replica sees a change, as the GIF key does.
 */
export interface SpeechKeyView {
  provider: SpeechProviderId | null;
  /** The key's last 4 characters, or the server's address. The key itself never leaves the server. */
  hint: string | null;
  /** `invalid`: a saved key that doesn't open on this server (another `AGENTES_SECRET`). */
  state: "off" | "ok" | "invalid";
  /** Engines set in this server's environment; they stay behind the saved one. */
  envProviders: SpeechProviderId[];
}

export interface SpeechSettings {
  ready(): Promise<void>;
  /** The engines to try, in order. */
  chain(): SpeechEngine[];
  available(): boolean;
  view(): Promise<SpeechKeyView>;
  save(input: { provider: SpeechProviderId } & SpeechCredentials, userId: string): Promise<SpeechKeyView>;
  remove(): Promise<SpeechKeyView>;
}

const NAME = "speech";
const AAD = `instance-secret|${NAME}`;
const REREAD_MS = 60_000;

const invalid = (message: string) => new ValidationError(message, "speech_key_invalid");

/** The engines the environment sets, in the order it asks for. */
export function envSpeechEngines(
  order: string | undefined,
  credentials: Partial<Record<SpeechProviderId, SpeechCredentials>>,
  options: { fetch?: SpeechFetch } = {},
): SpeechEngine[] {
  const asked = order?.trim() ? order.split(",").map((id) => id.trim()) : [...SPEECH_PROVIDERS];
  return asked.flatMap((id) => {
    if (!(SPEECH_PROVIDERS as readonly string[]).includes(id)) return [];
    const provider = id as SpeechProviderId;
    const engine = createSpeechEngine(provider, credentials[provider] ?? {}, options);
    return engine ? [engine] : [];
  });
}

export function createSpeechSettings(deps: {
  db: Database;
  keyWrapper: KeyWrapper;
  keyWrappers: KeyWrapper[];
  envEngines: SpeechEngine[];
  /** agentes.chat's own servers read only the environment. */
  envOnly?: boolean;
  fetch?: SpeechFetch;
  now?: () => number;
}): SpeechSettings {
  const now = deps.now ?? Date.now;
  type Saved = { provider: SpeechProviderId; engine: SpeechEngine | null; hint: string; at: number };
  let saved: Saved | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | null = null;

  async function read() {
    const [row] = await deps.db.select().from(instanceSecrets).where(eq(instanceSecrets.name, NAME));
    readAt = now();
    if (!row) {
      saved = null;
      return;
    }
    const at = row.updatedAt.getTime();
    if (saved?.at === at) return;
    const stored = await openSecret(deps.keyWrappers, row, AAD)
      .then((text) => JSON.parse(text) as { provider: SpeechProviderId } & SpeechCredentials)
      .catch(() => null);
    saved = {
      provider: stored?.provider ?? "local",
      engine: stored ? createSpeechEngine(stored.provider, stored, { fetch: deps.fetch }) : null,
      hint: row.keyHint,
      at,
    };
  }
  const refresh = () => {
    if (deps.envOnly || now() - readAt < REREAD_MS) return Promise.resolve();
    reading ??= read().finally(() => {
      reading = null;
    });
    return reading;
  };
  const initial = refresh();
  initial.catch(() => {});

  const chain = () => {
    refresh().catch(() => {});
    const own = saved?.engine ?? null;
    return own ? [own, ...deps.envEngines.filter((e) => e.id !== own.id)] : deps.envEngines;
  };
  const snapshot = (): SpeechKeyView => ({
    provider: saved?.provider ?? null,
    hint: saved?.hint ?? null,
    state: !saved ? "off" : saved.engine ? "ok" : "invalid",
    envProviders: deps.envEngines.map((e) => e.id),
  });

  return {
    ready: () => initial,
    chain,
    available: () => chain().length > 0,
    async view() {
      await refresh();
      return snapshot();
    },
    async save(input, userId) {
      const { provider, apiKey, baseUrl, model } = input;
      const credentials = { apiKey: apiKey?.trim() || undefined, baseUrl: baseUrl?.trim() || undefined, model };
      const engine = createSpeechEngine(provider, credentials, { fetch: deps.fetch });
      if (!engine) throw invalid("This provider needs its key or address.");
      // A second of silence: a provider that refuses the key says so here, and it is never kept.
      try {
        await engine.file({ audio: silentWav(), contentType: "audio/wav", language: "pt", terms: [] });
      } catch (error) {
        const reason = error instanceof SpeechError ? error.reason : "busy";
        if (reason === "auth") throw invalid("The provider didn't accept this key.");
        if (provider === "local") throw invalid("Couldn't reach this server.");
      }
      const hint = provider === "local" ? (credentials.baseUrl ?? "") : (credentials.apiKey ?? "").slice(-4);
      const values = {
        ...(await sealSecret(deps.keyWrapper, JSON.stringify({ provider, ...credentials }), AAD)),
        keyHint: hint,
        updatedBy: userId,
        updatedAt: new Date(),
      };
      await deps.db
        .insert(instanceSecrets)
        .values({ name: NAME, ...values })
        .onConflictDoUpdate({ target: instanceSecrets.name, set: values });
      saved = { provider, engine, hint, at: values.updatedAt.getTime() };
      readAt = now();
      return snapshot();
    },
    async remove() {
      await deps.db.delete(instanceSecrets).where(eq(instanceSecrets.name, NAME));
      saved = null;
      readAt = now();
      return snapshot();
    },
  };
}
