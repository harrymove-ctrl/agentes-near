import { redactCommon } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { type BlockSpec, compileBlock, type Value, viewBlock } from "@agenteschat/ui/blocks/spec";
import { type ArtifactDeps, getArtifact } from "./artifacts";
import { requireChannelAccess } from "./channels";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { can } from "./organizations";
import { neutralizeUntrusted, untrustedBlock } from "./untrusted";

const { artifacts, blockStates, users } = schema;

/**
 * One state per live block for everyone (ADR 0113): what a person sets in a block is kept here and reaches everyone
 * looking at it at once (`block.state`), so nobody sees a different result, and the agent reads the same. A random
 * pick is the server's (`drawBlock`): a page drawing on its own would give each person another answer.
 */

/** A whole state, as JSON. */
export const BLOCK_STATE_BYTES = 16_000;
/** Values set in one call. */
export const BLOCK_STATE_KEYS = 64;
/** Options a draw picks from. */
export const DRAW_OPTIONS = 100;
const KEY = /^[A-Za-z_][\w-]{0,63}$/;

/** Every text in a value, however deep. */
function textsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) textsOf(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) textsOf(v, out);
  return out;
}

/** Names a page gives a value that asks for a secret, in the languages people answer in. */
const SECRET_NAME =
  /password|passwd|senha|contrase|secret|api[_-]?key|(access|auth)[_-]?token|cvv|cvc|card[_-]?number|cart[aã]o|tarjeta/i;

/**
 * A key or a password typed into a block would be kept and shown to everyone in the conversation, and to the agent:
 * refused, whether it looks like one or the page named it as one (a page can be made to ask for it). Secrets go
 * through `request_secret`, which keeps them off the conversation.
 */
const holdsSecret = (values: Record<string, unknown>) =>
  Object.entries(values).some(
    ([name, value]) =>
      (SECRET_NAME.test(name) && textsOf(value).some((t) => t.trim() !== "")) ||
      textsOf(value).some((text) => redactCommon(text) !== text),
  );
const OPTION_CHARS = 200;

export interface BlockChange {
  /** The person who set it last. */
  by: string;
  name: string;
  at: string;
  /** Drawn by the server among this many options. */
  drawn?: number;
}

/** A block's shared state, as the apps and the agent read it. */
export interface BlockStateView {
  id: string;
  version: number;
  state: Record<string, unknown>;
  changes: Record<string, BlockChange>;
  /** Goes up on every change: the newest one wins in an app. */
  rev: number;
}

type Row = typeof blockStates.$inferSelect;

async function namesOf(db: Database, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function viewOf(db: Database, id: string, version: number, row: Row | undefined): Promise<BlockStateView> {
  if (!row) return { id, version, state: {}, changes: {}, rev: 0 };
  const names = await namesOf(db, [...new Set(Object.values(row.changes).map((c) => c.by))]);
  const changes: Record<string, BlockChange> = {};
  for (const [key, c] of Object.entries(row.changes)) changes[key] = { ...c, name: names.get(c.by) ?? "" };
  return { id, version, state: row.state, changes, rev: row.rev };
}

/** The block at `version`, for a person who can see its conversation. */
async function blockFor(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string, version: number) {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId, version);
  if (a.kind !== "block" || !a.channelId) throw new NotFoundError("Block not found");
  return { ...a, channelId: a.channelId };
}

/** A block's state now, for someone who can see its conversation. */
export async function getBlockState(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  version: number,
): Promise<BlockStateView> {
  await blockFor(deps, userId, orgId, artifactId, version);
  const [row] = await deps.db
    .select()
    .from(blockStates)
    .where(and(eq(blockStates.artifactId, artifactId), eq(blockStates.version, version), eq(blockStates.orgId, orgId)));
  return viewOf(deps.db, artifactId, version, row);
}

/** Merges `values` into the block's state as `userId`'s change, and tells everyone looking. */
async function write(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  version: number,
  values: Record<string, unknown>,
  drawn?: number,
): Promise<BlockStateView> {
  const a = await blockFor(deps, userId, orgId, artifactId, version);
  const { membership } = await requireChannelAccess(deps.db, userId, orgId, a.channelId);
  if (!can(membership, "post")) throw new ForbiddenError();
  const keys = Object.keys(values);
  if (keys.length === 0) throw new ValidationError("Nothing to set");
  if (keys.length > BLOCK_STATE_KEYS) throw new ValidationError("Too many values at once");
  if (keys.some((k) => !KEY.test(k))) throw new ValidationError("A value has an invalid name");
  if (holdsSecret(values)) {
    throw new ValidationError("That looks like a password or a key: everyone here would see it", "block.secret");
  }
  const at = new Date().toISOString();
  const row = await deps.db.transaction(async (tx) => {
    await tx
      .insert(blockStates)
      .values({ artifactId, version, orgId })
      .onConflictDoNothing({ target: [blockStates.artifactId, blockStates.version] });
    const [old] = await tx
      .select()
      .from(blockStates)
      .where(and(eq(blockStates.artifactId, artifactId), eq(blockStates.version, version)))
      .for("update");
    if (!old) throw new NotFoundError("Block not found");
    const state = { ...old.state, ...values };
    if (JSON.stringify(state).length > BLOCK_STATE_BYTES) throw new ValidationError("This block holds too much");
    const changes = { ...old.changes };
    for (const key of keys) changes[key] = { by: userId, at, ...(drawn ? { drawn } : {}) };
    const [next] = await tx
      .update(blockStates)
      .set({ state, changes, rev: old.rev + 1, updatedAt: new Date(at) })
      .where(and(eq(blockStates.artifactId, artifactId), eq(blockStates.version, version)))
      .returning();
    return next;
  });
  const block = await viewOf(deps.db, artifactId, version, row);
  await publishChannelEvent(deps.pubsub, { type: "block.state", channelId: a.channelId, block });
  return block;
}

/** What a person set in a block: the values it changed, the same for everyone. */
export function setBlockState(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  input: { version: number; values: Record<string, unknown> },
): Promise<BlockStateView> {
  return write(deps, userId, orgId, artifactId, input.version, input.values);
}

/** A uniform pick in [0, n), from the system's random source. */
export function fairIndex(n: number, random: (buf: Uint32Array) => Uint32Array = (b) => crypto.getRandomValues(b)) {
  // Values past the last whole multiple of n are drawn again, so no option comes up more often than another.
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buf = new Uint32Array(1);
  for (;;) {
    const x = random(buf)[0] ?? 0;
    if (x < limit) return x % n;
  }
}

/**
 * A random pick for a block, made once on the server: the page asks, the server draws among `options` and everyone
 * sees the same one arrive. The agent reads that it was drawn, by whom, and among how many.
 */
export async function drawBlock(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  input: { version: number; name: string; options: (string | number)[] },
): Promise<BlockStateView> {
  const { options } = input;
  if (options.length < 2 || options.length > DRAW_OPTIONS) {
    throw new ValidationError(`A draw takes 2 to ${DRAW_OPTIONS} options`);
  }
  if (options.some((o) => String(o).length > OPTION_CHARS)) throw new ValidationError("An option is too long");
  const picked = options[fairIndex(options.length)];
  return write(deps, userId, orgId, artifactId, input.version, { [input.name]: picked }, options.length);
}

/** Longest state a model reads per block. */
const STATE_FOR_MODEL = 2000;
/** Longest text of one result the agent reads. */
const SHOWN_TEXT = 200;

/** A block's parts at a version, for what it shows (`blockSpecAt`). */
export type BlockSpecReader = (orgId: string, artifactId: string, version: number) => Promise<BlockSpec | null>;

/**
 * What a block shows from its state: the values its formulas give (a margin, a total), the way everyone sees them.
 * Only plain values: lists (a chart's points) follow from the state and the block the agent wrote.
 */
export function blockShows(spec: BlockSpec, state: Record<string, unknown>): Record<string, Value> {
  const { values } = viewBlock(compileBlock(spec), state, { locale: "en", thousand: "k" });
  const out: Record<string, Value> = {};
  for (const name of Object.keys(spec.compute ?? {})) {
    const v = values[name];
    if (typeof v === "number") out[name] = Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null;
    else if (typeof v === "string") out[name] = v.slice(0, SHOWN_TEXT);
    else if (typeof v === "boolean" || v === null) out[name] = v ?? null;
  }
  return out;
}

/**
 * What people left in the blocks of a conversation, by the message that showed each (`meta.artifacts`): one line the
 * agent reads after that message. The values are what a page set, so they come as outside data.
 */
export async function blockStateNotes(
  db: Database,
  orgId: string,
  history: { id: string; meta?: Record<string, unknown> | null }[],
  zone?: string,
  specAt?: BlockSpecReader,
): Promise<Map<string, string>> {
  const shown = new Map<string, { messageId: string; version: number }[]>();
  for (const m of history) {
    const files = m.meta?.artifacts;
    if (!Array.isArray(files)) continue;
    for (const f of files as { id?: unknown; version?: unknown }[]) {
      if (typeof f?.id !== "string" || typeof f.version !== "number") continue;
      shown.set(f.id, [...(shown.get(f.id) ?? []), { messageId: m.id, version: f.version }]);
    }
  }
  const notes = new Map<string, string>();
  if (shown.size === 0) return notes;
  const rows = await db
    .select({ row: blockStates, title: artifacts.title })
    .from(blockStates)
    .innerJoin(artifacts, eq(artifacts.id, blockStates.artifactId))
    .where(
      and(
        eq(blockStates.orgId, orgId),
        inArray(blockStates.artifactId, [...shown.keys()]),
        isNull(artifacts.deletedAt),
      ),
    );
  const names = await namesOf(db, [...new Set(rows.flatMap((r) => Object.values(r.row.changes).map((c) => c.by)))]);
  for (const { row, title } of rows) {
    if (row.rev === 0) continue;
    const where = shown.get(row.artifactId)?.find((s) => s.version === row.version);
    if (!where) continue;
    const view: BlockStateView = {
      id: row.artifactId,
      version: row.version,
      state: row.state,
      changes: Object.fromEntries(
        Object.entries(row.changes).map(([k, c]) => [k, { ...c, name: names.get(c.by) ?? "someone" }]),
      ),
      rev: row.rev,
    };
    const spec = specAt ? await specAt(orgId, row.artifactId, row.version).catch(() => null) : null;
    const text = blockStateText(title, view, zone, spec ? blockShows(spec, row.state) : undefined);
    notes.set(where.messageId, notes.has(where.messageId) ? `${notes.get(where.messageId)}\n${text}` : text);
  }
  return notes;
}

/**
 * How the agent reads a block's state. Everything people could have written (values, their names, who set them) sits
 * inside the outside-data envelope; only our own words and the block's title, which the agent wrote, are outside it.
 */
export function blockStateText(
  title: string,
  block: BlockStateView,
  zone?: string,
  shows?: Record<string, Value>,
): string {
  const time = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", { timeZone: zone, dateStyle: "short", timeStyle: "short" });
  const set = Object.fromEntries(
    Object.entries(block.changes).map(([key, c]) => [
      key,
      { by: c.name || "someone", at: time(c.at), ...(c.drawn ? { drawnAmong: c.drawn } : {}) },
    ]),
  );
  const computed = shows && Object.keys(shows).length > 0;
  return `[Block "${neutralizeUntrusted(title)}" (block ${block.id}) as it is now, the same for everyone who opens it. "values" is what it holds; ${computed ? '"shows" is what your formulas give from them, as everyone sees it; ' : ""}"set" is who set each value last, and "drawnAmong" marks a value the app drew at random on the server among that many options: fair, and the same for everyone.]\n${untrustedBlock(
    `block ${title}`,
    JSON.stringify(computed ? { values: block.state, shows, set } : { values: block.state, set }),
    STATE_FOR_MODEL,
  )}`;
}
