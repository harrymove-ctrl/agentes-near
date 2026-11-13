import { checkGiphyKey, type GiphyKeyCheck, type KeyWrapper } from "@agenteschat/adapters";
import { type Database, type Executor, eq, schema } from "@agenteschat/db";
import { type AuditEntry, auditEveryOrg } from "./audit";
import { openSecret, sealSecret } from "./crypto";
import { ConflictError, ValidationError } from "./errors";

const { instanceSecrets } = schema;

/**
 * The installation's GIPHY key for GIFs (ADR 0091, amended 2026-10-31): `GIPHY_API_KEY`, else the one its owner adds
 * in Settings on a server that isn't agentes.chat's own, kept like the Jev key (ADR 0073): sealed, checked before it
 * is kept, never returned, its last 4 shown. Read on every call, so a saved key works without a restart.
 */

/**
 * `invalid`: a saved key that doesn't open on this server (another `AGENTES_SECRET`), or one in `GIPHY_API_KEY` that
 * can't be a key. GIPHY's answers to searches leave it as it is.
 */
export type GifKeyState = "off" | "ok" | "invalid";

export interface GifKeyView {
  source: "env" | "settings" | null;
  /** The key's last 4 characters. The key itself never leaves the server. */
  hint: string | null;
  state: GifKeyState;
}

export interface GifKey {
  /** Resolves once the saved key was read (no GIPHY call), so `key()` is right from the first request. */
  ready(): Promise<void>;
  /**
   * The key for a call now; null: none. Synchronous, for `GifProvider.available()`: once the saved key was read a
   * minute ago, it is read again behind the call, so a change made on another server shows here within a minute.
   */
  key(): string | null;
  view(): Promise<GifKeyView>;
  /** Checked with GIPHY first: a key it refuses is never stored (`gif_key_invalid`). */
  save(apiKey: string, userId: string): Promise<GifKeyView>;
  remove(userId: string): Promise<GifKeyView>;
}

const NAME = "giphy";
const AAD = `instance-secret|${NAME}`;
const REREAD_MS = 60_000;
// Printable ASCII, as the Jev key's (ADR 0073 §4): a pasted curly quote or zero-width space is no key, said before
// GIPHY is asked.
const KEY_SHAPE = /^[\x21-\x7E]+$/;

/** Deletes the saved key, with a `gif.key_removed` row in each organization. Processes drop it at their next read. */
export async function deleteGifKey(tx: Executor, actor: AuditEntry["actor"]) {
  const [gone] = await tx
    .delete(instanceSecrets)
    .where(eq(instanceSecrets.name, NAME))
    .returning({ hint: instanceSecrets.keyHint });
  if (gone) await auditEveryOrg(tx, NAME, actor, "gif.key_removed", { hint: gone.hint });
}

const envError = () =>
  new ConflictError("The GIPHY key is set in this server's settings (GIPHY_API_KEY).", "gif_key_env");
const invalidError = () => new ValidationError("GIPHY didn't accept this key.", "gif_key_invalid");

/**
 * The key in memory: the saved row is read when built, then again once a call finds it a minute old (a second
 * replica sees a change within that). No GIPHY call but the check before a save.
 */
export function createGifKey(deps: {
  db: Database;
  keyWrapper: KeyWrapper;
  keyWrappers: KeyWrapper[];
  envKey?: string;
  /** Asks GIPHY about a key before it is kept (`checkGiphyKey`; tests pass a fake). */
  check?: (apiKey: string) => Promise<GiphyKeyCheck>;
  now?: () => number;
}): GifKey {
  const now = deps.now ?? Date.now;
  const check = deps.check ?? ((apiKey: string) => checkGiphyKey(apiKey));
  const env = deps.envKey?.trim() || null;
  // An env key that can't be sent reads as invalid, and nothing calls with it.
  const envKey = env && KEY_SHAPE.test(env) ? env : null;
  /** The saved row as last read. `key` is null when it doesn't open (another `AGENTES_SECRET`). */
  let saved: { key: string | null; hint: string; at: number } | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | null = null;
  /** Saves and removals made here: a read that began before one of them is older than what it changed. */
  let changes = 0;

  async function read() {
    const before = changes;
    const [row] = await deps.db.select().from(instanceSecrets).where(eq(instanceSecrets.name, NAME));
    const at = row ? row.updatedAt.getTime() : null;
    // Opened only when the row changed: the same row keeps the key it opened to.
    let opened: string | null | undefined;
    if (row && saved?.at !== at) opened = await openSecret(deps.keyWrappers, row, AAD).catch(() => null);
    if (before !== changes) return;
    readAt = now();
    if (!row || at === null) saved = null;
    else if (opened !== undefined) saved = { key: opened, hint: row.keyHint, at };
  }
  const refresh = () => {
    if (env || now() - readAt < REREAD_MS) return Promise.resolve();
    reading ??= read().finally(() => {
      reading = null;
    });
    return reading;
  };
  const initial = refresh();
  // Awaited by `ready()`; nobody else has to.
  initial.catch(() => {});

  const snapshot = (): GifKeyView => {
    if (env) return { source: "env", hint: env.slice(-4), state: envKey ? "ok" : "invalid" };
    if (!saved) return { source: null, hint: null, state: "off" };
    return { source: "settings", hint: saved.hint, state: saved.key ? "ok" : "invalid" };
  };
  const changed = (next: typeof saved) => {
    saved = next;
    readAt = now();
    changes++;
  };

  return {
    ready: () => initial,
    key() {
      if (env) return envKey;
      // Behind the call: what another server saved or removed shows at a later one.
      refresh().catch(() => {});
      return saved?.key ?? null;
    },
    async view() {
      await refresh();
      return snapshot();
    },
    async save(apiKey, userId) {
      if (env) throw envError();
      const key = apiKey.trim();
      if (!KEY_SHAPE.test(key) || (await check(key)) === "invalid") throw invalidError();
      const values = {
        ...(await sealSecret(deps.keyWrapper, key, AAD)),
        keyHint: key.slice(-4),
        updatedBy: userId,
        updatedAt: new Date(),
      };
      await deps.db.transaction(async (tx) => {
        await tx
          .insert(instanceSecrets)
          .values({ name: NAME, ...values })
          .onConflictDoUpdate({ target: instanceSecrets.name, set: values });
        await auditEveryOrg(tx, NAME, { type: "person", id: userId }, "gif.key_saved", { hint: values.keyHint });
      });
      changed({ key, hint: values.keyHint, at: values.updatedAt.getTime() });
      return snapshot();
    },
    async remove(userId) {
      if (env) throw envError();
      await deps.db.transaction((tx) => deleteGifKey(tx, { type: "person", id: userId }));
      changed(null);
      return snapshot();
    },
  };
}
