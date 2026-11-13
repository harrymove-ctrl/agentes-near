import type { KeyWrapper } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gte, schema, sql } from "@agenteschat/db";
import { type AuditEntry, auditEveryOrg } from "./audit";
import { openSecret, sealSecret } from "./crypto";
import { ConflictError, ValidationError } from "./errors";
import { monthStartUtc } from "./usage";

const { instanceSecrets, usageRecords } = schema;

/**
 * The installation's TypeSafe key for Jev (ADR 0073): `TYPESAFE_API_KEY`, else the one its owner adds in
 * Settings. Read on every call, so a saved key works without a restart. Live calls report how they went, and a
 * broken key is skipped for a while, so the next step decides at once instead of waiting on it.
 */

/** How a call with the key went. `unchecked`: a key nobody has called with yet. */
export type JevState = "off" | "unchecked" | "ok" | "invalid" | "no_credit" | "rate_limited" | "down";
/** What screens show: the two states the key's owner can fix. A limit, an outage or a slow answer reads `ok`. */
export type JevShownState = "off" | "ok" | "invalid" | "no_credit";

export interface JevKeyView {
  source: "env" | "settings" | null;
  /** The key's last 4 characters. The key itself never leaves the server. */
  hint: string | null;
  state: JevShownState;
}

export interface JevKey {
  /** Resolves once the saved key was read (no TypeSafe call), so `usable()` is right from the first call. */
  ready(): Promise<void>;
  /** The key for a call now. Null: none, or skipped for now. */
  key(): Promise<string | null>;
  /** Whether a call now would get a key. */
  usable(): boolean;
  /** How a call went. `key`: the one it was made with, so an answer for a key replaced since is dropped. */
  report(state: JevState, retryAfterMs?: number, key?: string): void;
  view(): Promise<JevKeyView>;
  /** Checked with TypeSafe first: a refused key is never stored (`jev_key_invalid`). */
  save(apiKey: string, userId: string): Promise<JevKeyView>;
  remove(userId: string): Promise<JevKeyView>;
  /** Asks TypeSafe again. An answer that says nothing about the key leaves its state as it was. */
  check(): Promise<JevKeyView>;
}

/** A fixed key (evals, tests), or the installation's. */
export type JevKeySource = string | Pick<JevKey, "key" | "report" | "usable">;

/** No Jev key to call with now: the next step decides. */
export class JevOffError extends Error {
  constructor() {
    super("Jev has no key now");
    this.name = "JevOffError";
  }
}

const NAME = "typesafe";
const AAD = `instance-secret|${NAME}`;
const BAD_KEY_SKIP_MS = 30 * 60_000;
// TypeSafe's errors page says only "retry after a short delay" when `retry-after` is absent.
const RATE_LIMIT_SKIP_MS = 10_000;
const DOWN_SKIP_MS = 60_000;
const DOWNS_TO_SKIP = 3;
const REREAD_MS = 60_000;
const CHECK_TIMEOUT_MS = 5000;
const CREDIT_WORDS = /credit|balance|billing|payment|funds/i;
// A key is printable ASCII. Anything else, like a pasted curly quote or zero-width space, fails in fetch before the
// request leaves, which would read as an outage and keep a key TypeSafe never saw.
const KEY_SHAPE = /^[\x21-\x7E]+$/;

/**
 * What a TypeSafe answer says about the key, first match first. Null: the request's own fault (400, 413, 415,
 * 422, such as an image outside 280 to 1568 px a side), which says nothing about the key. TypeSafe documents no
 * status for an account out of credit, so both 402 and credit words in the body count.
 */
export function jevStateOf(status: number, body?: unknown): JevState | null {
  if (status >= 200 && status < 300) return "ok";
  const detail = (body as { detail?: { error_type?: unknown; message?: unknown } | string } | null | undefined)?.detail;
  const words = typeof detail === "string" ? detail : `${detail?.error_type ?? ""} ${detail?.message ?? ""}`;
  if (status === 402 || CREDIT_WORDS.test(words)) return "no_credit";
  // 403 is TypeSafe's answer to a request without a key (probed 2026-10-26).
  if (status === 401 || status === 403) return "invalid";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "down";
  return null;
}

export interface JevCall {
  body: unknown;
  timeoutMs: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  baseURL?: string;
}

/** One `POST /v1/systemone`. `state` is null when our own deadline passed or the answer is the request's fault. */
async function systemOne(apiKey: string, call: JevCall) {
  const base = (call.baseURL ?? "https://api.typesafe.ai").replace(/\/$/, "");
  let res: Response;
  try {
    res = await (call.fetch ?? fetch)(`${base}/v1/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...call.headers },
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(call.timeoutMs),
    });
  } catch (error) {
    // A deadline we set says the request was slow, not that TypeSafe is down: one server calls for every workspace.
    const late = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { state: late ? null : ("down" as const), status: 0, body: null };
  }
  const body: unknown = await res.json().catch(() => null);
  const seconds = Number(res.headers.get("retry-after"));
  return {
    state: jevStateOf(res.status, body),
    status: res.status,
    body,
    retryAfterMs: seconds > 0 ? seconds * 1000 : undefined,
  };
}

/** A live call with the installation's key: its outcome reported, its answer returned. Any failure throws. */
export async function callJev<T>(source: JevKeySource, call: JevCall): Promise<T> {
  const jev = typeof source === "string" ? { key: async () => source, report: () => {} } : source;
  const apiKey = await jev.key();
  if (!apiKey) throw new JevOffError();
  const r = await systemOne(apiKey, call);
  if (r.state) jev.report(r.state, r.retryAfterMs, apiKey);
  if (r.state !== "ok" || r.body === null) {
    throw new Error(r.status ? `TypeSafe answered ${r.status}` : "TypeSafe didn't answer");
  }
  return r.body as T;
}

/** A tiny real call (about 50 tokens): only a real call can say that a key has no credit. */
export async function checkJevKey(
  apiKey: string,
  o: { fetch?: typeof fetch; baseURL?: string } = {},
): Promise<JevState> {
  const question = {
    type: "noul",
    instructions: "Is the state the word ok?",
    criteria: { true: "The state is the word ok.", false: "The state is something else." },
  };
  const r = await systemOne(apiKey, {
    ...o,
    timeoutMs: CHECK_TIMEOUT_MS,
    body: { model: "jev-latest", state: "ok", questions: { ok: question } },
  });
  return r.state ?? "unchecked";
}

/** Jev's calls this month (UTC), every workspace together: what the key's TypeSafe account pays for. */
export async function jevMonth(db: Database, now = new Date()) {
  // ponytail: scans the month's usage rows. Only a self-hosted server's owner asks (404 on the Cloud).
  const [row] = await db
    .select({ decisions: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)` })
    .from(usageRecords)
    .where(and(eq(usageRecords.provider, "typesafe"), gte(usageRecords.createdAt, monthStartUtc(now))));
  return { decisions: row?.decisions ?? 0, costNanoUsd: Number(row?.cost ?? 0) };
}

/** Deletes the saved key, with a `jev.key_removed` row in each organization. Processes drop it at their next read. */
export async function deleteJevKey(tx: Executor, actor: AuditEntry["actor"]) {
  const [gone] = await tx
    .delete(instanceSecrets)
    .where(eq(instanceSecrets.name, NAME))
    .returning({ hint: instanceSecrets.keyHint });
  if (gone) await auditEveryOrg(tx, NAME, actor, "jev.key_removed", { hint: gone.hint });
}

const envError = () =>
  new ConflictError("The Jev key is set in this server's settings (TYPESAFE_API_KEY).", "jev_key_env");
const invalidError = () => new ValidationError("TypeSafe didn't accept this key.", "jev_key_invalid");

/**
 * The key and how its calls went, in memory: the saved row is read when built and again every 60 s (a second
 * replica sees a change within that), and the state isn't stored (after a restart it is `unchecked`, shown On).
 */
export function createJevKey(deps: {
  db: Database;
  keyWrapper: KeyWrapper;
  keyWrappers: KeyWrapper[];
  envKey?: string;
  fetch?: typeof fetch;
  baseURL?: string;
  now?: () => number;
}): JevKey {
  const now = deps.now ?? Date.now;
  const env = deps.envKey?.trim() || null;
  // An env key that can't be sent reads as not accepted, and nothing calls with it.
  const envKey = env && KEY_SHAPE.test(env) ? env : null;
  const tsa = { fetch: deps.fetch, baseURL: deps.baseURL };
  /** The saved row as last read. `key` is null when it doesn't open (another `AGENTES_SECRET`). */
  let saved: { key: string | null; hint: string; at: number } | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | null = null;
  let state: JevState = env ? (envKey ? "unchecked" : "invalid") : "off";
  let skipUntil = 0;
  let downs = 0;

  const restart = (s: JevState) => {
    state = s;
    skipUntil = 0;
    downs = 0;
  };
  const current = () => (env ? envKey : (saved?.key ?? null));

  async function read() {
    const [row] = await deps.db.select().from(instanceSecrets).where(eq(instanceSecrets.name, NAME));
    readAt = now();
    if (!row) {
      if (saved) restart("off");
      saved = null;
      return;
    }
    const at = row.updatedAt.getTime();
    if (saved?.at === at) return;
    const key = await openSecret(deps.keyWrappers, row, AAD).catch(() => null);
    saved = { key, hint: row.keyHint, at };
    restart(key ? "unchecked" : "invalid");
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

  const snapshot = (): JevKeyView => ({
    source: env ? "env" : saved ? "settings" : null,
    hint: env ? env.slice(-4) : (saved?.hint ?? null),
    state: !env && !saved ? "off" : state === "invalid" || state === "no_credit" ? state : "ok",
  });

  function report(s: JevState, retryAfterMs?: number, key?: string) {
    if (key !== undefined && key !== current()) return;
    const t = now();
    if (s === "ok") restart("ok");
    else if (s === "invalid" || s === "no_credit") {
      state = s;
      skipUntil = t + BAD_KEY_SKIP_MS;
    } else if (s === "rate_limited") skipUntil = t + (retryAfterMs ?? RATE_LIMIT_SKIP_MS);
    // One bad answer never turns Jev off for everyone: only a run of them.
    else if (s === "down" && ++downs >= DOWNS_TO_SKIP) skipUntil = t + DOWN_SKIP_MS;
  }

  return {
    ready: () => initial,
    async key() {
      await refresh();
      return now() < skipUntil ? null : current();
    },
    usable: () => current() !== null && now() >= skipUntil,
    report,
    async view() {
      await refresh();
      return snapshot();
    },
    async save(apiKey, userId) {
      if (env) throw envError();
      const key = apiKey.trim();
      if (!KEY_SHAPE.test(key)) throw invalidError();
      const checked = await checkJevKey(key, tsa);
      if (checked === "invalid") throw invalidError();
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
        await auditEveryOrg(tx, NAME, { type: "person", id: userId }, "jev.key_saved", { hint: values.keyHint });
      });
      saved = { key, hint: values.keyHint, at: values.updatedAt.getTime() };
      readAt = now();
      restart("unchecked");
      if (checked === "ok" || checked === "no_credit") report(checked);
      return snapshot();
    },
    async remove(userId) {
      if (env) throw envError();
      await deps.db.transaction((tx) => deleteJevKey(tx, { type: "person", id: userId }));
      saved = null;
      readAt = now();
      restart("off");
      return snapshot();
    },
    async check() {
      await refresh();
      const key = current();
      if (key) {
        const checked = await checkJevKey(key, tsa);
        if (checked === "ok" || checked === "invalid" || checked === "no_credit") report(checked, undefined, key);
      }
      return snapshot();
    },
  };
}
