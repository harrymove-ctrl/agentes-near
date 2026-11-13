import type { TFunction } from "i18next";
import type {
  AgentMediaLevel,
  Gif,
  GifCategory,
  GifMedia,
  GifPage,
  GifSize,
  MediaKind,
  Message,
  MessageMedia,
  OrgSettings,
  PostMedia,
  ReplyRef,
  StickerMedia,
  StickerMood,
} from "../api/types";
import { agentGrammar } from "./grammar";
import { plainLine } from "./markdown";
import { isVoiceMeta, voiceLength, voiceWord } from "./voice";

/**
 * GIFs and stickers in chat (ADR 0091), the half the web and the phone app share: what a message's `meta.media`
 * holds, read the way the server reads it (`mediaOf` in packages/engine/src/media.ts, mirrored here: the client
 * never imports the engine), the stickers' moods and the GIF categories (the server's ids, in its order), where the
 * apps load a GIF's file from (always our server), and the word that stands for one where a message's text shows.
 */

/** The agents' stickers, one animation of the agent per mood (the server's `STICKER_MOODS`). */
export const STICKER_MOODS = [
  "celebrate",
  "love",
  "deal",
  "thinking",
  "wow",
  "dizzy",
  "wave",
] as const satisfies readonly StickerMood[];

/** The GIF picker's chips, after "Em alta" (the server's `GIF_CATEGORY_IDS`). */
export const GIF_CATEGORY_IDS = [
  "celebrate",
  "thanks",
  "ok",
  "applause",
  "wow",
  "coffee",
  "good_morning",
  "bye",
  "friday",
  "oops",
  "thinking",
] as const satisfies readonly GifCategory[];

/** GIFs per page of the picker's search. */
export const GIF_PAGE = 24;

/** The search waits this long after the last key: the server limits searches per person. */
export const GIF_SEARCH_DELAY_MS = 300;

/** The picker's tabs besides the emojis, each where it can work. */
export type MediaTab = "gifs" | "stickers";

/**
 * `meta.mediaAfter` on the sticker or GIF an agent added after its own reply (the reply's id): a silent message of
 * its own, never a reply.
 */
export const MEDIA_AFTER_KEY = "mediaAfter";
/** A sticker or GIF the agent sent with its tools while it works (ADR 0091). */
export const MEDIA_IN_RUN_KEY = "mediaInRun";

type Meta = Record<string, unknown> | null | undefined;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const isStickerMood = (v: unknown): v is StickerMood =>
  typeof v === "string" && (STICKER_MOODS as readonly string[]).includes(v);

export const isGifCategory = (v: unknown): v is GifCategory =>
  typeof v === "string" && (GIF_CATEGORY_IDS as readonly string[]).includes(v);

/** The media a message's `meta` carries, or null: anything malformed is no media, as on the server. */
export function messageMediaOf(meta: Meta): MessageMedia | null {
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
  if (m.kind === "sticker" && typeof m.agentId === "string" && isStickerMood(m.mood)) {
    return { kind: "sticker", agentId: m.agentId, mood: m.mood };
  }
  return null;
}

/**
 * True for a sticker or GIF beside an agent's reply, never the reply itself: the one added after it
 * (`meta.mediaAfter`) or sent with its tools while it works (`meta.mediaInRun`). It doesn't end the run on screen.
 */
export const isMediaAfterReply = (meta: Meta) =>
  typeof meta?.[MEDIA_AFTER_KEY] === "string" || meta?.[MEDIA_IN_RUN_KEY] === true;

/**
 * True for a GIF or a sticker with no words: it routes to nobody and starts no run (ADR 0091), so no agent is about
 * to answer it.
 */
export const isMediaAlone = (m: Pick<Message, "body" | "meta">) => !m.body.trim() && messageMediaOf(m.meta) !== null;

/**
 * What the picker offers here: GIFs where this client can search, this server has GIF search and the workspace has
 * them on; stickers where the workspace has them on and has agents. Before the settings load, or with neither: none,
 * and the apps show no way in.
 */
export function mediaTabsOf(
  settings: Pick<OrgSettings, "gifs" | "gifsAvailable" | "agentStickers"> | null | undefined,
  agents: number,
  gifSearch: boolean,
): MediaTab[] {
  if (!settings) return [];
  const tabs: MediaTab[] = [];
  if (gifSearch && settings.gifsAvailable && settings.gifs) tabs.push("gifs");
  if (settings.agentStickers && agents > 0) tabs.push("stickers");
  return tabs;
}

/**
 * What the settings show: GIFs read off where this server has no GIF search, and without what decides when, agents
 * send nothing on their own, so the level reads Nunca, whatever is stored.
 */
export const shownMediaSettings = (
  s: Pick<OrgSettings, "gifs" | "gifsAvailable" | "agentMedia" | "agentMediaAvailable">,
): { gifsOn: boolean; level: AgentMediaLevel } => ({
  gifsOn: s.gifsAvailable && s.gifs,
  level: s.agentMediaAvailable ? s.agentMedia : "never",
});

/** A search's pages as one list: a GIF a later page repeats shows once. */
export function gifsOfPages(pages: readonly GifPage[] | undefined): Gif[] {
  const seen = new Set<string>();
  return (pages ?? [])
    .flatMap((page) => page.gifs)
    .filter((g) => {
      if (seen.has(g.id)) return false;
      seen.add(g.id);
      return true;
    });
}

/**
 * Where a GIF's file loads from: our server's media route, never the provider (the viewer's address stays with us).
 * `base` is the server for the phone app (`""` on the web: the same origin).
 */
export function gifMediaUrl(orgId: string, id: string, size: GifSize, base = "") {
  const path = `/api/app/organizations/${encodeURIComponent(orgId)}/gifs/${encodeURIComponent(id)}/media`;
  return `${base.replace(/\/+$/, "")}${path}?size=${size}`;
}

/** A GIF picked in the picker as a message's media (the optimistic copy: the server writes the real one). */
export const gifMedia = (gif: Gif): GifMedia => ({
  kind: "gif",
  provider: "giphy",
  id: gif.id,
  title: gif.title,
  width: gif.width > 0 ? gif.width : 1,
  height: gif.height > 0 ? gif.height : 1,
});

/** One of an agent's stickers as a message's media. */
export const stickerMedia = (agentId: string, mood: StickerMood): StickerMedia => ({ kind: "sticker", agentId, mood });

/** What `chat.post` takes for it: the server never trusts a GIF's size or title from the app. */
export function postedMedia(media: MessageMedia): PostMedia {
  return media.kind === "gif"
    ? { kind: "gif", id: media.id }
    : { kind: "sticker", agentId: media.agentId, mood: media.mood };
}

/**
 * A media kind stored beside a text (a quote's, a last-message preview's, a notification's): `"gif"` or
 * `"sticker"`, or an object with that `kind`. Anything else is none.
 */
export function mediaKindOf(v: unknown): MediaKind | null {
  const kind = isObject(v) ? v.kind : v;
  return kind === "gif" || kind === "sticker" || kind === "voice" ? kind : null;
}

/** The word for a GIF or a sticker where a message's text would show ("GIF", "Figurinha"). */
export const mediaWord = (t: TFunction, kind: MediaKind) =>
  kind === "voice" ? voiceWord(t) : t(kind === "gif" ? "media.word.gif" : "media.word.sticker");

/**
 * A message's text where a line of it shows (a list, a quote, an inbox card), or the word for its media when it has
 * no text: `meta.media` as a message stores it, or the kind a preview's meta carries.
 */
export function textOrMedia(t: TFunction, body: string, meta: Meta): string {
  // A voice message's words are the agents': people read its name, whatever the body holds (ADR 0100).
  if (isVoiceMeta(meta)) return voiceWord(t, voiceLength(meta));
  if (body.trim()) return body;
  const kind = messageMediaOf(meta)?.kind ?? mediaKindOf(meta?.media);
  return kind ? mediaWord(t, kind) : body;
}

/**
 * A search hit's line: its words, else the word for what it was. A voice message's hit has none (people hear it, ADR
 * 0100), and a search by filters alone also lists GIFs and stickers sent with no words.
 */
export const hitText = (t: TFunction, hit: { snippet: string; mediaKind?: MediaKind }) =>
  plainLine(hit.snippet) || (hit.mediaKind ? mediaWord(t, hit.mediaKind) : "");

/**
 * A quote's line: its excerpt in plain words (one saved before excerpts lost their marks may still have them), else
 * the word for what it quotes.
 */
export function quoteText(t: TFunction, reply: Pick<ReplyRef, "excerpt" | "media">): string {
  const kind = mediaKindOf(reply.media);
  if (kind === "voice") return mediaWord(t, kind);
  const words = plainLine(reply.excerpt);
  if (words) return words;
  return kind ? mediaWord(t, kind) : t("channel.quoteNoWords");
}

/** A mood's name, as the picker and a sticker's name say it ("comemorando"). */
export const moodLabel = (t: TFunction, mood: StickerMood) => t(`media.moods.${mood}`);

/** The words the stickers tab's search goes by: each mood's name and the other words it is found by. */
export function stickerWords(t: TFunction) {
  const byMood = (word: (mood: StickerMood) => string) =>
    Object.fromEntries(STICKER_MOODS.map((mood) => [mood, word(mood)])) as Record<StickerMood, string>;
  return { moods: byMood((mood) => moodLabel(t, mood)), moodWords: byMood((mood) => t(`media.moodWords.${mood}`)) };
}

/** A sticker's name for screen readers: "Figurinha do Dev: comemorando". */
export const stickerLabel = (t: TFunction, agentName: string, mood: StickerMood) =>
  t("media.stickerOf", { ...agentGrammar(agentName), mood: moodLabel(t, mood) });

/** A GIF's name for screen readers: its title (the provider's words), or just "GIF". */
export const gifLabel = (t: TFunction, title: string) =>
  title.trim() ? t("media.gifTitled", { title: title.trim() }) : t("media.word.gif");
