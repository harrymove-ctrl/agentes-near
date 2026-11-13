/**
 * GIF search (ADR 0091). Optional: the server has it only with a GIPHY key, `GIPHY_API_KEY` or, on a server that
 * isn't agentes.chat's own, the one the installation's owner adds in Settings (`createKeyedGifs`); without one the
 * app shows no GIF tab and agents send only their own stickers. The key never leaves the server, and neither does
 * the provider's address: the app loads every GIF through the server (`media`), so a viewer's browser never talks
 * to it.
 */
export type GifRating = "g" | "pg";

/** Which file of a GIF: a small one for the picker, the one shown in a message, or a still frame. */
export type GifSize = "preview" | "full" | "still";

export const GIF_SIZES = ["preview", "full", "still"] as const satisfies readonly GifSize[];

/** A GIF id as the server accepts it (GIPHY's are letters and digits): anything else is no GIF. */
export const GIF_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface Gif {
  id: string;
  /** The provider's title (outside text). */
  title: string;
  /** Of the `full` file, in pixels. */
  width: number;
  height: number;
}

export interface GifPage {
  gifs: Gif[];
  /** The offset of the next page; null = no more. */
  next: number | null;
}

export interface GifMediaFile {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  contentType: string;
}

export interface GifProvider {
  readonly name: string;
  /**
   * Whether it can search now. Always for GIPHY with its key and the fake; the keyed provider only while the
   * installation has a key. Synchronous: the routes and the settings ask on every request.
   */
  available(): boolean;
  /** `lang`: the person's language (two letters), to match words in it. */
  search(input: { query: string; rating: GifRating; lang?: string; limit: number; offset: number }): Promise<GifPage>;
  trending(input: { rating: GifRating; limit: number; offset: number }): Promise<GifPage>;
  /** One GIF by id; null when it doesn't exist or is rated above `rating`. */
  get(id: string, rating: GifRating): Promise<Gif | null>;
  /** One file of a GIF, for the server's media route; null when it doesn't exist or is rated above `rating`. */
  media(id: string, size: GifSize, rating: GifRating): Promise<GifMediaFile | null>;
}

/** The provider didn't answer as it should (no answer in time, a refused key, a limit, an outage). */
export class GifProviderError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "GifProviderError";
  }
}

/** Most GIFs one page asks for (GIPHY's limit for a beta key). */
export const GIF_PAGE_MAX = 50;
/** Longest search GIPHY takes, in characters. */
const QUERY_MAX = 50;
/** GIPHY's last offsets: search and trending. */
const SEARCH_OFFSET_MAX = 4999;
const TRENDING_OFFSET_MAX = 499;
/** Largest file the media route sends (GIPHY's `downsized` is under 2 MB). */
export const GIF_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** The only files served: never a page or a script on our origin. */
const IMAGE_TYPES = new Set(["image/gif", "image/webp", "image/png", "image/jpeg"]);
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
/** Ids whose files were looked up: most images are served without an API call. */
const GIF_CACHE_SIZE = 2_000;
const GIF_CACHE_MS = 12 * 3600_000;
/** Pages of results: trending and the picker's categories are the same for everyone. */
const PAGE_CACHE_SIZE = 300;
const PAGE_CACHE_MS = 10 * 60_000;

/** Ratings from the mildest; one not listed is never shown. `y` is GIPHY's older rating for the youngest. */
const RATING_LEVEL: Record<string, number> = { y: 0, g: 0, pg: 1, "pg-13": 2, r: 3 };
const MAX_LEVEL: Record<GifRating, number> = { g: 0, pg: 1 };

/** Whether a GIF rated `rating` may be shown where `max` is the most allowed (g < pg < pg-13 < r). */
export function gifRatingAllowed(rating: string | null | undefined, max: GifRating): boolean {
  const level = RATING_LEVEL[(rating ?? "").trim().toLowerCase()];
  return level !== undefined && level <= MAX_LEVEL[max];
}

/**
 * GIPHY's renditions for each size, the first one found wins; every one is a GIF file. `preview`: about 200 px
 * wide, for the picker's grid. `full`: under 2 MB, good for about 300 px in a message. `still`: one frame, for
 * reduced motion.
 */
const RENDITIONS: Record<GifSize, string[]> = {
  preview: ["fixed_width", "fixed_width_downsampled", "fixed_height_small", "preview_gif"],
  full: ["downsized", "fixed_height", "fixed_width", "downsized_medium"],
  still: ["downsized_still", "fixed_width_still", "fixed_height_still", "original_still"],
};

interface GiphyRendition {
  url?: unknown;
  width?: unknown;
  height?: unknown;
}

interface GiphyGif {
  id?: unknown;
  title?: unknown;
  rating?: unknown;
  images?: Record<string, GiphyRendition | undefined> | null;
}

interface GiphyAnswer {
  data?: GiphyGif | GiphyGif[] | null;
  pagination?: { total_count?: unknown; count?: unknown; offset?: unknown };
  meta?: { status?: unknown; msg?: unknown };
}

/** What the server keeps of one GIF: what the app sees, its rating and where each of its files is. */
interface GifEntry {
  gif: Gif;
  rating: string;
  urls: Partial<Record<GifSize, string>>;
}

/** An address the server fetches files from: GIPHY's own hosts over https, nothing else. */
function giphyUrl(raw: string, base?: string): URL | null {
  try {
    const url = new URL(raw, base);
    const ok =
      url.protocol === "https:" &&
      url.hostname.endsWith(".giphy.com") &&
      (url.port === "" || url.port === "443") &&
      !url.username &&
      !url.password;
    return ok ? url : null;
  } catch {
    return null;
  }
}

const dimension = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** A title as people see it: one line, at most 140 characters. */
const cleanTitle = (v: unknown) => {
  const line = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
};

/** One GIF of GIPHY's answer, or null when it has no id we accept or no file to show in a message. */
function entryOf(raw: GiphyGif | null | undefined): GifEntry | null {
  if (!raw || typeof raw.id !== "string" || !GIF_ID_PATTERN.test(raw.id)) return null;
  const images = raw.images && typeof raw.images === "object" ? raw.images : {};
  const urls: Partial<Record<GifSize, string>> = {};
  let full: GiphyRendition | undefined;
  for (const size of Object.keys(RENDITIONS) as GifSize[]) {
    for (const name of RENDITIONS[size]) {
      const rendition = images[name];
      const href = rendition?.url;
      const url = typeof href === "string" ? giphyUrl(href) : null;
      if (!url) continue;
      urls[size] = url.href;
      if (size === "full") full = rendition;
      break;
    }
  }
  if (!urls.full) return null;
  return {
    gif: {
      id: raw.id,
      title: cleanTitle(raw.title),
      width: dimension(full?.width) || 1,
      height: dimension(full?.height) || 1,
    },
    rating: typeof raw.rating === "string" ? raw.rating : "",
    urls,
  };
}

/** A small map that forgets the least recently used entry, and any entry older than `ttlMs`. */
function lru<V>(max: number, ttlMs: number, now: () => number) {
  const entries = new Map<string, { value: V; at: number }>();
  return {
    get(key: string): V | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (now() - entry.at > ttlMs) return undefined;
      entries.set(key, entry);
      return entry.value;
    },
    set(key: string, value: V) {
      entries.delete(key);
      entries.set(key, { value, at: now() });
      if (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    delete(key: string) {
      entries.delete(key);
    },
  };
}

/** The body, or null past `max` bytes (the read stops there). */
async function readCapped(res: Response, max: number): Promise<ArrayBuffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const body = new ArrayBuffer(total);
  const out = new Uint8Array(body);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** How the server reaches GIPHY (tests pass a fake `fetch`). */
export interface GiphyOptions {
  fetch?: typeof fetch;
  /** GIPHY's API, `https://api.giphy.com` by default. */
  baseURL?: string;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * GIPHY's API v1 (`/v1/gifs/search`, `/trending`, `/{id}`), our own calls with a fake `fetch` in tests. Every
 * answer is filtered by rating again here, so a GIF above the workspace's rating never reaches it whatever GIPHY
 * returns. Files come only from GIPHY's hosts over https, at most `GIF_FILE_MAX_BYTES`, and only as images.
 */
export function createGiphyGifs(options: GiphyOptions & { apiKey: string }): GifProvider {
  const http = options.fetch ?? fetch;
  const base = (options.baseURL ?? "https://api.giphy.com").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const known = lru<GifEntry>(GIF_CACHE_SIZE, GIF_CACHE_MS, now);
  const pages = lru<{ entries: GifEntry[]; next: number | null }>(PAGE_CACHE_SIZE, PAGE_CACHE_MS, now);

  /** One API call; `null` when GIPHY says the GIF isn't there (400 or 404), else its answer. Anything else throws. */
  async function api(path: string, params: Record<string, string | number | undefined>): Promise<GiphyAnswer | null> {
    const url = new URL(`${base}/v1/gifs${path}`);
    url.searchParams.set("api_key", options.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    let res: Response;
    try {
      res = await http(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new GifProviderError(`GIPHY didn't answer: ${error instanceof Error ? error.name : String(error)}`);
    }
    const answer = (await res.json().catch(() => null)) as GiphyAnswer | null;
    const said = answer?.meta?.status;
    const status = typeof said === "number" ? said : res.status;
    if (res.status === 404 || res.status === 400 || status === 404 || status === 400) return null;
    // A refusal said only in the answer's `meta` (a 200 that says 403) still reads as one (`checkGiphyKey`).
    const code = res.ok ? status : res.status;
    if (!res.ok || status >= 300 || !answer) throw new GifProviderError(`GIPHY answered ${code}`, code);
    return answer;
  }

  /** A page of results, filtered by rating; each GIF's files remembered for the media route. */
  async function page(
    key: string,
    path: string,
    params: Record<string, string | number | undefined>,
    input: { rating: GifRating; limit: number; offset: number; maxOffset: number },
  ): Promise<GifPage> {
    const limit = Math.min(Math.max(1, Math.floor(input.limit)), GIF_PAGE_MAX);
    const offset = Math.max(0, Math.floor(input.offset));
    if (offset > input.maxOffset) return { gifs: [], next: null };
    const cacheKey = `${key}|${input.rating}|${limit}|${offset}`;
    let found = pages.get(cacheKey);
    if (!found) {
      const answer = await api(path, { ...params, rating: input.rating, limit, offset });
      const raw = answer?.data;
      const data = Array.isArray(raw) ? raw : [];
      const entries = data.flatMap((raw) => entryOf(raw) ?? []);
      const count = data.length;
      const total = Number(answer?.pagination?.total_count);
      const after = offset + count;
      const more =
        count > 0 && after <= input.maxOffset && (Number.isFinite(total) && total > 0 ? after < total : count >= limit);
      found = { entries, next: more ? after : null };
      pages.set(cacheKey, found);
    }
    for (const entry of found.entries) known.set(entry.gif.id, entry);
    return {
      gifs: found.entries.filter((e) => gifRatingAllowed(e.rating, input.rating)).map((e) => e.gif),
      next: found.next,
    };
  }

  /** What the server knows of a GIF: from a page or a lookup made lately, else GIPHY's answer (null: none). */
  async function lookup(id: string): Promise<GifEntry | null> {
    if (!GIF_ID_PATTERN.test(id)) return null;
    const cached = known.get(id);
    if (cached) return cached;
    const data = (await api(`/${encodeURIComponent(id)}`, {}))?.data;
    const entry = Array.isArray(data) ? null : entryOf(data);
    if (!entry || entry.gif.id !== id) return null;
    known.set(id, entry);
    return entry;
  }

  /** A file from GIPHY's hosts (redirects too), an image at most `GIF_FILE_MAX_BYTES`; null otherwise. */
  async function file(raw: string): Promise<GifMediaFile | null> {
    let target = giphyUrl(raw);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      for (let hop = 0; target && hop <= MAX_REDIRECTS; hop++) {
        const res = await http(target, { redirect: "manual", signal });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          await res.body?.cancel().catch(() => undefined);
          target = location ? giphyUrl(location, target.href) : null;
          continue;
        }
        const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (!res.ok || !IMAGE_TYPES.has(type) || declared > GIF_FILE_MAX_BYTES) {
          await res.body?.cancel().catch(() => undefined);
          return null;
        }
        const body = await readCapped(res, GIF_FILE_MAX_BYTES);
        return body ? { body, contentType: type } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  const trending = (input: { rating: GifRating; limit: number; offset: number }) =>
    page("trending", "/trending", {}, { ...input, maxOffset: TRENDING_OFFSET_MAX });

  return {
    name: "giphy",
    available: () => true,
    async search(input) {
      const query = input.query.replace(/\s+/g, " ").trim().slice(0, QUERY_MAX);
      if (!query) return trending(input);
      const lang = input.lang && /^[a-z]{2}$/i.test(input.lang) ? input.lang.toLowerCase() : undefined;
      return page(
        `search|${query.toLowerCase()}|${lang ?? ""}`,
        "/search",
        { q: query, lang },
        { ...input, maxOffset: SEARCH_OFFSET_MAX },
      );
    },
    trending,
    async get(id, rating) {
      const entry = await lookup(id);
      return entry && gifRatingAllowed(entry.rating, rating) ? entry.gif : null;
    },
    async media(id, size, rating) {
      const entry = await lookup(id).catch(() => null);
      const url = entry?.urls[size];
      // Above the workspace's rating it isn't there, as in a search.
      if (!entry || !url || !gifRatingAllowed(entry.rating, rating)) return null;
      const found = await file(url);
      // A file GIPHY no longer has: its id is looked up again next time.
      if (!found) known.delete(id);
      return found;
    },
  };
}

/** How long a key's check waits for GIPHY before the key is kept unchecked. */
const CHECK_TIMEOUT_MS = 5_000;

/**
 * GIPHY with the installation's key as it is now (ADR 0091, amended 2026-10-31): `key` is read on every call, so a
 * key the owner saves or removes in Settings works without a restart. One client for the current key, made on first
 * use and dropped, with its pages and lookups, when the key changes. Without a key it isn't `available`: a search
 * throws and a file is missing, as when GIPHY doesn't answer.
 */
export function createKeyedGifs(options: GiphyOptions & { key: () => string | null }): GifProvider {
  const { key, ...giphy } = options;
  let client: { apiKey: string; gifs: GifProvider } | null = null;
  /** The client for the key now; null without one. */
  const current = () => {
    const apiKey = key();
    if (!apiKey) {
      client = null;
      return null;
    }
    if (client?.apiKey !== apiKey) client = { apiKey, gifs: createGiphyGifs({ ...giphy, apiKey }) };
    return client.gifs;
  };
  const keyed = () => {
    const gifs = current();
    if (!gifs) throw new GifProviderError("This server has no GIPHY key");
    return gifs;
  };
  return {
    name: "giphy",
    available: () => key() !== null,
    search: async (input) => keyed().search(input),
    trending: async (input) => keyed().trending(input),
    get: async (id, rating) => keyed().get(id, rating),
    media: async (id, size, rating) => (await current()?.media(id, size, rating)) ?? null,
  };
}

/** What GIPHY says of a key: it answers, it refuses the key (401, 403), or nothing either way (no answer, a limit). */
export type GiphyKeyCheck = "ok" | "invalid" | "unknown";

/**
 * One cheap call with `apiKey` (one trending GIF, 5 s at most) before a key is kept (ADR 0091, amended 2026-10-31).
 * Only a refusal says the key is wrong.
 */
export async function checkGiphyKey(apiKey: string, options: GiphyOptions = {}): Promise<GiphyKeyCheck> {
  const gifs = createGiphyGifs({ timeoutMs: CHECK_TIMEOUT_MS, ...options, apiKey });
  try {
    await gifs.trending({ rating: "g", limit: 1, offset: 0 });
    return "ok";
  } catch (error) {
    const refused = error instanceof GifProviderError && (error.status === 401 || error.status === 403);
    return refused ? "invalid" : "unknown";
  }
}

/** The smallest GIF there is (1×1, transparent): what the fake serves for every file. */
const TINY_GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export interface FakeGif extends Gif {
  rating: string;
}

/** What the fake answers by default: a GIF per picker category, and three rated above `g` (`pg`, `pg-13`, `r`). */
export const FAKE_GIFS: FakeGif[] = [
  { id: "fakeCelebration1", title: "Celebration dance", width: 480, height: 270, rating: "g" },
  { id: "fakeCelebration2", title: "Office celebration", width: 400, height: 400, rating: "g" },
  { id: "fakeThanks1", title: "Thank you so much", width: 480, height: 360, rating: "g" },
  { id: "fakeOk1", title: "Ok deal handshake", width: 480, height: 270, rating: "g" },
  { id: "fakeApplause1", title: "Applause standing ovation", width: 480, height: 270, rating: "g" },
  { id: "fakeWow1", title: "Wow mind blown", width: 360, height: 360, rating: "g" },
  { id: "fakeCoffee1", title: "Coffee time", width: 480, height: 480, rating: "g" },
  { id: "fakeMorning1", title: "Good morning sunshine", width: 480, height: 270, rating: "g" },
  { id: "fakeBye1", title: "See you tomorrow wave", width: 480, height: 270, rating: "g" },
  { id: "fakeFriday1", title: "Friday dance party", width: 480, height: 270, rating: "g" },
  { id: "fakeOops1", title: "Oops spilled", width: 480, height: 270, rating: "g" },
  { id: "fakeThinking1", title: "Thinking hmm", width: 480, height: 270, rating: "g" },
  { id: "fakeParty1", title: "Wild celebration party", width: 480, height: 270, rating: "pg" },
  { id: "fakeParty2", title: "Party all night", width: 480, height: 270, rating: "pg-13" },
  { id: "fakeWild1", title: "Too wild", width: 480, height: 270, rating: "r" },
];

/**
 * A GIF provider for tests: deterministic answers from `gifs` (a search matches any of its words in a title),
 * a tiny real GIF for every file, and every call recorded.
 */
export function createFakeGifs(options: { gifs?: FakeGif[] } = {}) {
  const all = options.gifs ?? FAKE_GIFS;
  const calls = {
    search: [] as { query: string; rating: GifRating; lang?: string; limit: number; offset: number }[],
    trending: [] as { rating: GifRating; limit: number; offset: number }[],
    get: [] as { id: string; rating: GifRating }[],
    media: [] as { id: string; size: GifSize; rating: GifRating }[],
  };
  const view = ({ rating: _, ...gif }: FakeGif): Gif => gif;
  const paged = (list: FakeGif[], input: { rating: GifRating; limit: number; offset: number }): GifPage => {
    const allowed = list.filter((g) => gifRatingAllowed(g.rating, input.rating));
    const slice = allowed.slice(input.offset, input.offset + input.limit);
    const after = input.offset + slice.length;
    return { gifs: slice.map(view), next: slice.length > 0 && after < allowed.length ? after : null };
  };
  const provider: GifProvider & { calls: typeof calls } = {
    name: "fake",
    calls,
    available: () => true,
    async search(input) {
      calls.search.push(input);
      const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      return paged(
        all.filter((g) => words.some((w) => g.title.toLowerCase().includes(w))),
        input,
      );
    },
    async trending(input) {
      calls.trending.push(input);
      return paged(all, input);
    },
    async get(id, rating) {
      calls.get.push({ id, rating });
      const found = all.find((g) => g.id === id);
      return found && gifRatingAllowed(found.rating, rating) ? view(found) : null;
    },
    async media(id, size, rating) {
      calls.media.push({ id, size, rating });
      const found = all.find((g) => g.id === id);
      if (!found || !gifRatingAllowed(found.rating, rating)) return null;
      return { body: tinyGif(), contentType: "image/gif" };
    },
  };
  return provider;
}

/** `TINY_GIF`'s bytes. */
export function tinyGif(): ArrayBuffer {
  const raw = atob(TINY_GIF);
  const body = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(body);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return body;
}
