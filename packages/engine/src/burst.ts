import { type PubSub, typingTopic } from "@agenteschat/adapters";
import { and, type Database, eq, gte, isNull, schema, sql } from "@agenteschat/db";
import type { Message } from "./messages";

const { messages } = schema;

/** However long a person keeps writing, a run started on their message waits at most this many quiet windows. */
export const BURST_MAX_WINDOWS = 4;

/**
 * Without a sign of more coming (a `user.typing` from the person here, or another message of theirs), the wait ends
 * this long after their message instead of the whole window (token-trim B11). The apps send a typing frame the
 * moment a new message starts, so "oi" then "preciso de uma coisa" is still read as one (ADR 0112).
 */
export const TYPING_GRACE_MS = 1200;

type TypingWhere = { channelId: string; threadId: string | null; userId: string };

/** When each person last typed in each conversation, as this process heard it (`user.typing` on `typingTopic`). */
export interface TypingLog {
  /** The last typing frame's time on this process's clock, or null when none was heard. */
  lastTyped(where: TypingWhere): number | null;
}

const typingKey = (w: TypingWhere) => `${w.channelId}:${w.threadId ?? ""}:${w.userId}`;
const TYPING_KEEP_MS = 60_000;
const logs = new WeakMap<PubSub, TypingLog>();

/**
 * The typing log of a pub/sub, listening from the first call on: called when the handlers are made, so a frame sent
 * while a run reads its context (before its wait starts) still counts.
 */
export function typingLogFor(pubsub: PubSub): TypingLog {
  const known = logs.get(pubsub);
  if (known) return known;
  const last = new Map<string, number>();
  pubsub.subscribe(typingTopic, (e) => {
    if (e.type !== "user.typing" || typeof e.channelId !== "string" || typeof e.userId !== "string") return;
    const now = Date.now();
    if (last.size > 10_000) for (const [k, at] of last) if (at < now - TYPING_KEEP_MS) last.delete(k);
    const threadId = typeof e.threadId === "string" ? e.threadId : null;
    last.set(typingKey({ channelId: e.channelId, threadId, userId: e.userId }), now);
  });
  const log: TypingLog = { lastTyped: (w) => last.get(typingKey(w)) ?? null };
  logs.set(pubsub, log);
  return log;
}

/**
 * Whether a message's author can send typing frames: one posted from the web, desktop or phone apps, not through a
 * connected AI app (`meta.via`, ADR 0119), whose next message comes with no typing first.
 */
export const typesInApp = (m: Pick<Message, "meta">) => !m.meta?.via;

/**
 * People split one request over a few messages ("oi" / "preciso de uma coisa" / "olha o relatório de ontem"):
 * before its first model call, a run started on a person's message waits until that person has been quiet for
 * `quietMs` in the conversation (capped at `BURST_MAX_WINDOWS` windows from the trigger), so the messages that
 * joined its inbox meanwhile are read with the first one (ADR 0112). Measured from the messages' own times: a
 * run that starts late (a busy worker, the router's own wait) waits only what is left, usually nothing.
 */
export async function waitForBurst(
  db: Database,
  trigger: Pick<Message, "orgId" | "channelId" | "threadId" | "authorUserId" | "createdAt" | "meta">,
  quietMs: number,
  signal?: AbortSignal,
  /** With it, the wait ends after `TYPING_GRACE_MS` when the person hasn't typed since their message (`typingLogFor`). */
  typing?: TypingLog,
): Promise<void> {
  const author = trigger.authorUserId;
  if (!author || quietMs <= 0) return;
  const where = { channelId: trigger.channelId, threadId: trigger.threadId ?? null, userId: author };
  const typed =
    typing && typesInApp(trigger)
      ? (offset: number) =>
          (typing.lastTyped(where) ?? Number.NEGATIVE_INFINITY) + offset >= trigger.createdAt.getTime()
      : null;
  await waitQuiet(db, { ...trigger, authorUserId: author }, quietMs, signal, typed);
}

async function waitQuiet(
  db: Database,
  trigger: Pick<Message, "orgId" | "channelId" | "threadId" | "createdAt"> & { authorUserId: string },
  quietMs: number,
  signal: AbortSignal | undefined,
  /** Whether the person typed after their message, given the database clock minus this process's. */
  typed: ((offset: number) => boolean) | null,
): Promise<void> {
  const author = trigger.authorUserId;
  // Parar or a shutdown drain ends the wait at once: the run frees its slot instead of sitting out the window.
  const aborted = signal
    ? new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    : null;
  const from = trigger.createdAt.getTime();
  const cap = from + quietMs * BURST_MAX_WINDOWS;
  for (;;) {
    if (signal?.aborted) return;
    // Message times come from the database's clock: the wait is measured on it too, never the app's.
    const [row] = await db
      .select({
        latest: sql<number>`extract(epoch from max(${messages.createdAt})) * 1000`.mapWith(Number),
        now: sql<number>`extract(epoch from clock_timestamp()) * 1000`.mapWith(Number),
      })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, trigger.orgId),
          eq(messages.channelId, trigger.channelId),
          trigger.threadId ? eq(messages.threadId, trigger.threadId) : isNull(messages.threadId),
          eq(messages.authorUserId, author),
          isNull(messages.deletedAt),
          gte(messages.createdAt, trigger.createdAt),
        ),
      );
    if (!row) return;
    const last = Math.max(from, row.latest || 0);
    // Nothing more on its way (no typing, no second message): only the grace, not the whole window.
    const quiet = typed && !typed(row.now - Date.now()) && last - from < 1;
    const wait = Math.min(quiet ? from + Math.min(TYPING_GRACE_MS, quietMs) : last + quietMs, cap) - row.now;
    if (wait <= 0) return;
    const nap = Bun.sleep(Math.min(wait, quietMs));
    await (aborted ? Promise.race([nap, aborted]) : nap);
  }
}
