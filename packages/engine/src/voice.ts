import type { BlobStoreResolver, PubSub, SpeechEngine } from "@agenteschat/adapters";
import { SpeechError } from "@agenteschat/adapters";
import { and, asc, count, type Database, desc, eq, gt, gte, isNull, lt, ne, schema, sql } from "@agenteschat/db";
import { requireChannelAccess } from "./channels";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import type { Judge } from "./judge";
import type { MessageVoice } from "./message-preview";
import { postPersonMessage } from "./messages";
import { can } from "./organizations";
import { enqueue } from "./outbox";

const { voiceClips, agents, channels, organizationMembers, organizationSettings, users } = schema;

/**
 * Voice messages (ADR 0100). To people a voice message is its audio: the app never shows the words. To agents it is
 * those words, in `messages.body`, so routing, context and search work as for any message. The recording is stored
 * first and the message posted from a job, so what was said survives a closed app or a provider's bad minute.
 */
export const VOICE_JOB = "voice.transcribe";
export const VOICE_MAX_MS = 5 * 60_000;
/** The clock in the app and the recording's real end differ a little. */
const VOICE_DURATION_SLACK_MS = 5_000;
/** Five minutes of the apps' recordings, well under what any provider takes. */
export const VOICE_MAX_BYTES = 25 * 1024 * 1024;
export const VOICE_MIN_MS = 300;
/** Bars the player draws, at most. */
const MAX_PEAKS = 200;
const VOICE_ATTEMPTS = 4;
const DAY_MS = 24 * 3600_000;
/** What an agent reads when no engine could make out the words. */
export const VOICE_NO_WORDS_BODY = "(voice message: the words could not be made out)";

/** What the apps record, and all that is ever served back from our own address. */
/** Bun names a multipart file's type after its extension: `.webm` and `.mp4` arrive as video, and these only hold audio. */
const VOICE_ARRIVES_AS: Record<string, string> = { "video/webm": "audio/webm", "video/mp4": "audio/mp4" };
const VOICE_TYPES = [
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
];

/** Limits on agentes.chat's own servers (ADR 0100); null everywhere else. Zero turns a limit off. */
export interface VoiceLimits {
  personMinutesPerDay: number;
  orgMinutesPerMember: number;
  orgMinMinutesPerDay: number;
}

export interface VoiceDeps {
  db: Database;
  pubsub: PubSub;
  blobs: BlobStoreResolver;
  engines: () => SpeechEngine[];
  limits: VoiceLimits | null;
  /** Days a recording is kept (`VOICE_RETENTION_DAYS`); 0: forever. */
  retentionDays: number;
  judge?: Judge | null;
  /** Tests: how long an engine works alone (`hedgeAfterMs`). */
  hedgeAfterMs?: (durationMs: number) => number;
}

/** How long an engine has a recording to itself before the next one starts beside it: 19 s for 88 s of audio. */
export const hedgeAfterMs = (durationMs: number) => 8_000 + durationMs / 8;

function cleanPeaks(peaks: unknown): number[] {
  if (!Array.isArray(peaks)) return [];
  return peaks.slice(0, MAX_PEAKS).map((p) => {
    const n = Number(p);
    return Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000 : 0;
  });
}

const minutesSince = async (db: Database, where: ReturnType<typeof eq>, since: Date) => {
  const [row] = await db
    .select({ ms: sql<string>`coalesce(sum(${voiceClips.durationMs}), 0)` })
    .from(voiceClips)
    .where(and(where, gte(voiceClips.createdAt, since)));
  return Number(row?.ms ?? 0) / 60_000;
};

/**
 * Fair use (ADR 0100): whether this person may record now. Checked before a recording starts and again when it
 * arrives, never cutting one short, so at most one recording goes over. Nobody sees a counter or a price.
 */
export async function voiceAllowed(deps: Pick<VoiceDeps, "db" | "limits">, userId: string, orgId: string) {
  const { db, limits } = deps;
  if (!limits) return true;
  const since = new Date(Date.now() - DAY_MS);
  if (
    limits.personMinutesPerDay > 0 &&
    (await minutesSince(db, eq(voiceClips.userId, userId), since)) >= limits.personMinutesPerDay
  ) {
    return false;
  }
  if (limits.orgMinutesPerMember <= 0) return true;
  const [members] = await db
    .select({ n: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const cap = Math.max(limits.orgMinMinutesPerDay, (members?.n ?? 0) * limits.orgMinutesPerMember);
  return (await minutesSince(db, eq(voiceClips.orgId, orgId), since)) < cap;
}

/** Whether this workspace's people see the microphone. */
export async function voiceOn(deps: Pick<VoiceDeps, "db" | "engines">, orgId: string) {
  if (deps.engines().length === 0) return false;
  const [row] = await deps.db
    .select({ on: organizationSettings.voiceMessages })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  return row?.on ?? true;
}

/** Stores a recording and queues its words. A resend with the same `clientId` finds what the first one stored. */
export async function acceptVoiceClip(
  deps: VoiceDeps,
  userId: string,
  orgId: string,
  channelId: string,
  input: {
    audio: Uint8Array;
    contentType: string;
    durationMs: number;
    peaks: unknown;
    clientId: string;
    threadId?: string | null;
    replyTo?: string | null;
    language?: string | null;
  },
): Promise<{ clipId: string }> {
  const { membership } = await requireChannelAccess(deps.db, userId, orgId, channelId);
  if (!can(membership, "post")) throw new ForbiddenError();
  const clientId = input.clientId.trim().slice(0, 64);
  if (!clientId) throw new ValidationError("clientId is required", "voice.client_id_required");
  const [existing] = await deps.db
    .select({ id: voiceClips.id })
    .from(voiceClips)
    .where(and(eq(voiceClips.orgId, orgId), eq(voiceClips.userId, userId), eq(voiceClips.clientId, clientId)));
  if (existing) return { clipId: existing.id };
  if (!(await voiceOn(deps, orgId))) throw new ValidationError("Voice messages are off here", "voice.unavailable");
  if (input.audio.length === 0 || input.audio.length > VOICE_MAX_BYTES) {
    throw new ValidationError("The recording is too large", "voice.too_large");
  }
  if (input.durationMs < VOICE_MIN_MS || input.durationMs > VOICE_MAX_MS + VOICE_DURATION_SLACK_MS) {
    throw new ValidationError("The recording is too long or too short", "voice.bad_duration");
  }
  if (!(await voiceAllowed(deps, userId, orgId))) throw new ValidationError("Too many voice messages", "voice.limit");
  const declared = input.contentType.split(";")[0]?.trim().toLowerCase() || "audio/mp4";
  const contentType = VOICE_ARRIVES_AS[declared] ?? declared;
  if (!VOICE_TYPES.includes(contentType)) throw new ValidationError("Not a voice recording", "voice.bad_type");
  const id = crypto.randomUUID();
  const place = await deps.blobs.forOrg(orgId);
  const blobKey = `${place.prefix}voice/${id}`;
  await place.store.put(blobKey, input.audio, { contentType });
  const written = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(voiceClips)
      .values({
        id,
        orgId,
        channelId,
        threadId: input.threadId ?? null,
        userId,
        clientId,
        replyTo: input.replyTo ?? null,
        storageConfigId: place.storageConfigId,
        blobKey,
        contentType,
        size: input.audio.length,
        durationMs: Math.round(input.durationMs),
        peaks: cleanPeaks(input.peaks),
        language: input.language?.slice(0, 8) ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: voiceClips.id });
    if (row) await enqueue(tx, { orgId, kind: VOICE_JOB, payload: { clipId: id }, maxAttempts: VOICE_ATTEMPTS });
    return row ?? null;
  });
  if (written) return { clipId: written.id };
  // Two sends of the same recording raced: the other one's row stands.
  await place.store.delete(blobKey).catch(() => undefined);
  const [winner] = await deps.db
    .select({ id: voiceClips.id })
    .from(voiceClips)
    .where(and(eq(voiceClips.orgId, orgId), eq(voiceClips.userId, userId), eq(voiceClips.clientId, clientId)));
  if (!winner) throw new NotFoundError();
  return { clipId: winner.id };
}

/** Names the recording most likely says: the workspace's agents, its people and channels. */
async function namesFor(db: Database, orgId: string): Promise<string[]> {
  const [agentRows, people, rooms] = await Promise.all([
    db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.orgId, orgId))
      .orderBy(desc(agents.createdAt))
      .limit(40),
    db
      .select({ name: users.name })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, orgId))
      .limit(40),
    db
      .select({ name: channels.name })
      .from(channels)
      .where(and(eq(channels.orgId, orgId), eq(channels.kind, "channel")))
      .limit(20),
  ]);
  return [...agentRows, ...people, ...rooms].flatMap((r) => (r.name ? [r.name.replace(/[-_]+/g, " ")] : []));
}

type Clip = typeof voiceClips.$inferSelect;

/** When a recording made at `createdAt` goes; null when recordings stay. */
const expiryOf = (createdAt: Date, retentionDays: number) =>
  retentionDays > 0 ? new Date(createdAt.getTime() + retentionDays * DAY_MS) : null;

async function dropClip(deps: VoiceDeps, clip: Clip, reason: "silent" | "refused") {
  await deps.db
    .update(voiceClips)
    .set({ status: "dropped", audioDeletedAt: new Date() })
    .where(eq(voiceClips.id, clip.id));
  if (clip.userId) {
    await publishUserEvent(deps.pubsub, clip.orgId, clip.userId, {
      type: "voice.dropped",
      clientId: clip.clientId,
      channelId: clip.channelId,
      reason,
    });
  }
  const place = await deps.blobs.forConfig(clip.orgId, clip.storageConfigId);
  await place.delete(clip.blobKey).catch(() => undefined);
}

/**
 * The words of a recording, from the first engine that answers; null when none could. A failing engine hands over at
 * once, and one still working after `hedgeAfterMs` gets the next one beside it: the first words win. The other's
 * answer is dropped (a hosted engine still bills that call).
 */
async function wordsOf(
  deps: VoiceDeps,
  clip: Clip,
  audio: Uint8Array,
): Promise<{ engine: SpeechEngine; text: string } | null> {
  const terms = await namesFor(deps.db, clip.orgId);
  const input = {
    audio,
    contentType: clip.contentType,
    language: clip.language,
    terms,
    orgId: clip.orgId,
    durationMs: clip.durationMs,
  };
  const engines = deps.engines();
  const alone = (deps.hedgeAfterMs ?? hedgeAfterMs)(clip.durationMs);
  return new Promise((resolve, reject) => {
    // The last failure that a retry may get past: one engine busy is worth a retry even when the others refused.
    let last: unknown = null;
    let refused = false;
    let next = 0;
    let working = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      clearTimeout(timer);
      if (done) return;
      const engine = engines[next++];
      if (!engine) {
        if (working > 0) return;
        done = true;
        if (refused && !last) resolve(null);
        else reject(last ?? new Error("no speech engine on this server"));
        return;
      }
      working++;
      engine.file(input).then(
        ({ text }) => {
          working--;
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ engine, text: text.trim() });
        },
        (error: unknown) => {
          working--;
          if (error instanceof SpeechError && error.reason === "refused") refused = true;
          else last = error;
          start();
        },
      );
      if (next < engines.length) timer = setTimeout(start, alone);
    };
    start();
  });
}

const costOf = (engine: SpeechEngine, durationMs: number) =>
  Math.round((Math.max(durationMs / 1000, engine.minBilledSeconds) / 3600) * engine.nanoUsdPerHour);

/**
 * Job `voice.transcribe`: the recording's words, then the message, as if the person had sent it. Nothing said drops
 * the recording and tells its sender; words nobody can make out after every try still go out, as audio people can
 * hear, and the agent is told so.
 */
export async function transcribeVoiceClip(deps: VoiceDeps, clipId: string, options: { finalAttempt: boolean }) {
  const [clip] = await deps.db.select().from(voiceClips).where(eq(voiceClips.id, clipId));
  if (clip?.status !== "pending") return;
  if (!clip.userId) return dropClip(deps, clip, "refused");
  const place = await deps.blobs.forConfig(clip.orgId, clip.storageConfigId);
  const stored = await place.get(clip.blobKey);
  if (!stored) return dropClip(deps, clip, "refused");
  let words: Awaited<ReturnType<typeof wordsOf>>;
  try {
    words = await wordsOf(deps, clip, stored.body);
  } catch (error) {
    if (!options.finalAttempt) throw error;
    words = null;
  }
  if (words && !words.text) return dropClip(deps, clip, "silent");
  const expiresAt = expiryOf(clip.createdAt, deps.retentionDays);
  const voice: MessageVoice = {
    clipId: clip.id,
    durationMs: clip.durationMs,
    peaks: clip.peaks,
    ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    ...(words ? {} : { noWords: true as const }),
  };
  try {
    const message = await postPersonMessage(
      { db: deps.db, pubsub: deps.pubsub, judge: deps.judge ?? undefined },
      clip.userId,
      clip.orgId,
      clip.channelId,
      {
        body: words?.text ?? VOICE_NO_WORDS_BODY,
        threadId: clip.threadId,
        clientId: clip.clientId,
        replyTo: clip.replyTo,
        meta: { voice },
      },
    );
    await deps.db
      .update(voiceClips)
      .set({
        status: "sent",
        messageId: message.id,
        engine: words?.engine.id ?? null,
        costNanoUsd: words ? costOf(words.engine, clip.durationMs) : 0,
      })
      .where(eq(voiceClips.id, clip.id));
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError || error instanceof ValidationError) {
      return dropClip(deps, clip, "refused");
    }
    throw error;
  }
}

/** A recording to play, for who can read its channel: a signed link where the store has them, else the bytes. */
export async function voiceClipAudio(
  deps: Pick<VoiceDeps, "db" | "blobs" | "retentionDays">,
  userId: string,
  orgId: string,
  clipId: string,
): Promise<{ expired: true } | { url: string } | { body: Uint8Array; contentType: string }> {
  const [clip] = await deps.db
    .select()
    .from(voiceClips)
    .where(and(eq(voiceClips.id, clipId), eq(voiceClips.orgId, orgId)));
  if (!clip || clip.status === "dropped") throw new NotFoundError();
  await requireChannelAccess(deps.db, userId, orgId, clip.channelId);
  const expiry = expiryOf(clip.createdAt, deps.retentionDays);
  if (clip.audioDeletedAt || (clip.status !== "pending" && expiry && expiry.getTime() <= Date.now())) {
    return { expired: true };
  }
  const store = await deps.blobs.forConfig(orgId, clip.storageConfigId);
  const url = await store.signedUrl(clip.blobKey, { expiresInSeconds: 300 });
  if (url) return { url };
  const object = await store.get(clip.blobKey);
  if (!object) throw new NotFoundError();
  return { body: object.body, contentType: clip.contentType };
}

const SWEEP_PAGE = 200;

/**
 * The daily sweep: recordings past `VOICE_RETENTION_DAYS` leave storage a page at a time. The row stays for fair use,
 * and the message keeps its words for agents and search. A recording still waiting for its words is never touched;
 * one that can't be deleted now stays for the next sweep.
 */
export async function sweepExpiredVoice(
  deps: Pick<VoiceDeps, "db" | "blobs" | "retentionDays">,
  options: { pageSize?: number; now?: number } = {},
) {
  const result = { swept: 0, failed: 0 };
  if (deps.retentionDays <= 0) return result;
  const pageSize = options.pageSize ?? SWEEP_PAGE;
  const cutoff = new Date((options.now ?? Date.now()) - deps.retentionDays * DAY_MS);
  let cursor: string | null = null;
  for (;;) {
    const page: { id: string; orgId: string; storageConfigId: string | null; blobKey: string }[] = await deps.db
      .select({
        id: voiceClips.id,
        orgId: voiceClips.orgId,
        storageConfigId: voiceClips.storageConfigId,
        blobKey: voiceClips.blobKey,
      })
      .from(voiceClips)
      .where(
        and(
          isNull(voiceClips.audioDeletedAt),
          ne(voiceClips.status, "pending"),
          lt(voiceClips.createdAt, cutoff),
          cursor ? gt(voiceClips.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(voiceClips.id))
      .limit(pageSize);
    for (const clip of page) {
      try {
        await dropAudio(deps, clip);
        result.swept++;
      } catch {
        result.failed++;
      }
    }
    if (page.length < pageSize) return result;
    cursor = page[page.length - 1]?.id ?? null;
  }
}

type ClipAudio = { id: string; orgId: string; storageConfigId: string | null; blobKey: string };

/** A recording leaves storage; its row stays for fair use. */
async function dropAudio(deps: Pick<VoiceDeps, "db" | "blobs">, clip: ClipAudio) {
  const store = await deps.blobs.forConfig(clip.orgId, clip.storageConfigId);
  await store.delete(clip.blobKey);
  await deps.db.update(voiceClips).set({ audioDeletedAt: new Date() }).where(eq(voiceClips.id, clip.id));
}

/** A deleted channel's recordings leave storage now, whatever the retention (a failure throws, so its job retries). */
export async function dropChannelVoice(deps: Pick<VoiceDeps, "db" | "blobs">, orgId: string, channelId: string) {
  const clips = await deps.db
    .select({
      id: voiceClips.id,
      orgId: voiceClips.orgId,
      storageConfigId: voiceClips.storageConfigId,
      blobKey: voiceClips.blobKey,
    })
    .from(voiceClips)
    .where(and(eq(voiceClips.orgId, orgId), eq(voiceClips.channelId, channelId), isNull(voiceClips.audioDeletedAt)));
  for (const clip of clips) await dropAudio(deps, clip);
}
