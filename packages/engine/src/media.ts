import { and, count, type Database, type Executor, eq, gte, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";

/**
 * GIFs and stickers in chat (ADR 0091): what a message carries in `meta.media`, the agents' sticker moods and
 * the GIF categories (a closed set, so a judgment can pick one and the picker can show it as a chip).
 *
 * A GIF is stored with what the app needs to draw it (id, title, size) and never with a URL: the app loads
 * its bytes through the server (`GET …/gifs/{id}/media`), so the viewer's browser never talks to the provider.
 * A sticker is an agent and a mood: every app draws it from the agent's look (`packages/ui/src/agent/engine.js`).
 */

/** The agent's own tools that send one (`media-tools.ts`, ADR 0091 addendum 2026-10-31). */
export const SEND_GIF_TOOL = "send_gif";
export const SEND_STICKER_TOOL = "send_sticker";
/** Both, by name. */
export const MEDIA_TOOLS: ReadonlySet<string> = new Set([SEND_GIF_TOOL, SEND_STICKER_TOOL]);

/** The agents' stickers: one animation of the agent per mood. */
export const STICKER_MOODS = ["celebrate", "love", "deal", "thinking", "wow", "dizzy", "wave"] as const;
export type StickerMood = (typeof STICKER_MOODS)[number];

/** The moods an agent may send on its own after a reply (the others are for people to send). */
export const AGENT_STICKER_MOODS = ["celebrate", "love", "deal", "wow"] as const satisfies readonly StickerMood[];

/**
 * GIF categories: the picker's chips and what an agent may pick. Each searches the provider with its own
 * English query (the provider matches English best); the app shows the category's translated name.
 */
export const GIF_CATEGORIES = {
  celebrate: "celebration",
  thanks: "thank you",
  ok: "ok deal",
  applause: "applause",
  wow: "wow",
  coffee: "coffee",
  good_morning: "good morning",
  bye: "see you tomorrow",
  friday: "friday dance",
  oops: "oops",
  thinking: "thinking hmm",
} as const;
export type GifCategory = keyof typeof GIF_CATEGORIES;
export const GIF_CATEGORY_IDS = Object.keys(GIF_CATEGORIES) as GifCategory[];

/** The categories an agent may send on its own after a reply. */
export const AGENT_GIF_CATEGORIES = [
  "celebrate",
  "thanks",
  "ok",
  "applause",
  "wow",
  "good_morning",
  "bye",
] as const satisfies readonly GifCategory[];

export const GIF_RATINGS = ["g", "pg"] as const;
export type GifRating = (typeof GIF_RATINGS)[number];
export const AGENT_MEDIA_LEVELS = ["never", "sometimes", "often"] as const;
export type AgentMediaLevel = (typeof AGENT_MEDIA_LEVELS)[number];

export interface GifMedia {
  kind: "gif";
  provider: "giphy";
  id: string;
  /** The provider's title (outside text: never read by a model without `untrustedBlock`). */
  title: string;
  width: number;
  height: number;
}

export interface StickerMedia {
  kind: "sticker";
  agentId: string;
  mood: StickerMood;
}

/** `meta.media` of a message. A message may have media and no text. */
export type MessageMedia = GifMedia | StickerMedia;

/**
 * `meta.mediaAfter` on a sticker or GIF an agent added after its own reply: the reply's id. Such a message is
 * silent: it starts no run, routes to nobody and notifies nobody.
 */
export const MEDIA_AFTER_KEY = "mediaAfter";

/**
 * `meta.mediaInRun` on a sticker or GIF an agent sent with its tools while it works: not its reply. Unlike
 * `meta.mediaAfter` people hear of it; the apps keep the run going under it, and its text still comes after.
 */
export const MEDIA_IN_RUN_KEY = "mediaInRun";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
export const isStickerMood = (v: unknown): v is StickerMood =>
  typeof v === "string" && (STICKER_MOODS as readonly string[]).includes(v);
const isMood = isStickerMood;

/** The media a stored `meta` carries, or null (anything malformed is no media). */
export function mediaOf(meta: Record<string, unknown> | null | undefined): MessageMedia | null {
  const m = meta?.media;
  if (!isObject(m)) return null;
  if (m.kind === "gif") {
    if (typeof m.id !== "string" || m.id === "") return null;
    return {
      kind: "gif",
      provider: "giphy",
      id: m.id,
      title: typeof m.title === "string" ? m.title : "",
      width: typeof m.width === "number" && m.width > 0 ? m.width : 1,
      height: typeof m.height === "number" && m.height > 0 ? m.height : 1,
    };
  }
  if (m.kind === "sticker" && typeof m.agentId === "string" && isMood(m.mood)) {
    return { kind: "sticker", agentId: m.agentId, mood: m.mood };
  }
  return null;
}

/** True for the silent sticker or GIF an agent added after its own reply (`meta.mediaAfter`). */
export const isMediaAfterReply = (meta: Record<string, unknown> | null | undefined) =>
  typeof meta?.[MEDIA_AFTER_KEY] === "string";

/**
 * A message of only a GIF or a sticker: no text and no files. Like a reaction it routes to nobody and starts no run
 * (ADR 0091 §1), whoever sent it.
 */
export function isMediaOnly(message: { body: string; meta: Record<string, unknown> | null | undefined }): boolean {
  const files = message.meta?.artifacts;
  return message.body.trim() === "" && !(Array.isArray(files) && files.length > 0) && mediaOf(message.meta) !== null;
}

/**
 * How many GIFs and stickers a run sent with the agent's own tools (`send_gif`, `send_sticker`, ADR 0091): the run's
 * messages that carry `meta.media`, never the silent one after its reply (`meta.mediaAfter`). Read in the run's
 * channel from its start: the messages table is partitioned by time (ADR 0009).
 */
export async function runMediaCount(
  db: Executor,
  run: { orgId: string; id: string; channelId: string; createdAt: Date },
): Promise<number> {
  const { messages } = schema;
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        gte(messages.createdAt, run.createdAt),
        eq(messages.agentRunId, run.id),
        sql`${messages.meta}->'media' is not null`,
        sql`${messages.meta}->>'mediaAfter' is null`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** The workspace's switches for GIFs and stickers (`organization_settings`, ADR 0091 §5). */
export interface MediaSettings {
  /** People may send GIFs (they also need the server's GIF provider). */
  gifs: boolean;
  /** The most a GIF may be rated. */
  gifRating: GifRating;
  /** The agents' own stickers, for people and agents. */
  agentStickers: boolean;
  /** How often agents follow a light reply with a sticker or a GIF. */
  agentMedia: AgentMediaLevel;
}

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  gifs: true,
  gifRating: "g",
  agentStickers: true,
  agentMedia: "sometimes",
};

/** A stored row's switches; a value out of its list reads as the default. */
export function mediaSettingsFrom(
  row: Partial<Record<keyof MediaSettings, unknown>> | null | undefined,
): MediaSettings {
  const d = DEFAULT_MEDIA_SETTINGS;
  return {
    gifs: typeof row?.gifs === "boolean" ? row.gifs : d.gifs,
    gifRating: (GIF_RATINGS as readonly unknown[]).includes(row?.gifRating)
      ? (row?.gifRating as GifRating)
      : d.gifRating,
    agentStickers: typeof row?.agentStickers === "boolean" ? row.agentStickers : d.agentStickers,
    agentMedia: (AGENT_MEDIA_LEVELS as readonly unknown[]).includes(row?.agentMedia)
      ? (row?.agentMedia as AgentMediaLevel)
      : d.agentMedia,
  };
}

/** The cache key of `mediaSettings` (dropped by `updateOrgSettings`). */
export const mediaSettingsCacheKey = (orgId: string) => `${orgId}:media`;

/** The workspace's GIF and sticker switches, through the per-process cache (30 s; a change here drops it at once). */
export function mediaSettings(db: Database, orgId: string): Promise<MediaSettings> {
  return caches.orgs.getOrLoad(mediaSettingsCacheKey(orgId), async () => {
    const s = schema.organizationSettings;
    const [row] = await db
      .select({ gifs: s.gifs, gifRating: s.gifRating, agentStickers: s.agentStickers, agentMedia: s.agentMedia })
      .from(s)
      .where(eq(s.orgId, orgId));
    return mediaSettingsFrom(row);
  }) as Promise<MediaSettings>;
}
