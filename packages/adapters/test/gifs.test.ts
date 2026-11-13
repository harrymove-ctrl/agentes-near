import { describe, expect, test } from "bun:test";
import {
  checkGiphyKey,
  createFakeGifs,
  createGiphyGifs,
  createKeyedGifs,
  GIF_FILE_MAX_BYTES,
  GifProviderError,
  gifRatingAllowed,
  tinyGif,
} from "../src/gifs";

/** A rendition as GIPHY's API v1 writes it (sizes as strings). */
const rendition = (id: string, name: string, width: number, height: number) => ({
  url: `https://media0.giphy.com/media/${id}/${name}.gif?cid=abc123&rid=${name}.gif&ct=g`,
  width: String(width),
  height: String(height),
  size: "51234",
});

const giphyGif = (id: string, title: string, rating = "g") => ({
  type: "gif",
  id,
  title,
  rating,
  images: {
    fixed_width: rendition(id, "200w", 200, 113),
    fixed_width_still: rendition(id, "200w_s", 200, 113),
    downsized: rendition(id, "giphy-downsized", 480, 270),
    downsized_still: rendition(id, "giphy-downsized_s", 480, 270),
  },
});

const DANCE = giphyGif("aaa111", "Happy  dance\nGIF");
const PARTY = giphyGif("bbb222", "Party", "pg");
const TOO_MUCH = giphyGif("ddd444", "Too much", "r");
/** Its files aren't on GIPHY's hosts: it is no GIF here. */
const ELSEWHERE = { ...giphyGif("ccc333", "Elsewhere"), images: { downsized: { url: "https://evil.example/x.gif" } } };

/** A fake GIPHY: the API at api.giphy.com and the files on media0.giphy.com (or what `files` says for an address). */
function fakeGiphy(options: { status?: number; down?: boolean; files?: Record<string, () => Response> } = {}) {
  const calls: URL[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url);
    if (url.hostname === "api.giphy.com") {
      if (options.down) throw new TypeError("fetch failed");
      if (options.status) {
        return Response.json({ meta: { status: options.status, msg: "Unauthorized" } }, { status: options.status });
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (url.pathname === "/v1/gifs/search" || url.pathname === "/v1/gifs/trending") {
        const data = [DANCE, PARTY, ELSEWHERE, TOO_MUCH];
        // Trending says no total: a full page means there may be more.
        const total = url.pathname.endsWith("search") ? { total_count: 30 } : {};
        return Response.json({ data, pagination: { ...total, count: data.length, offset }, meta: { status: 200 } });
      }
      const found = [DANCE, PARTY, TOO_MUCH].find((g) => url.pathname === `/v1/gifs/${g.id}`);
      if (found) return Response.json({ data: found, meta: { status: 200, msg: "OK" } });
      return Response.json({ data: [], meta: { status: 404, msg: "Not Found" } }, { status: 404 });
    }
    const file = options.files?.[url.href];
    if (file) return file();
    if (url.hostname.endsWith(".giphy.com"))
      return new Response(tinyGif(), { headers: { "content-type": "image/gif" } });
    throw new Error(`unexpected fetch ${url.href}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls, api: () => calls.filter((u) => u.hostname === "api.giphy.com") };
}

const text = (body: ArrayBuffer | ReadableStream<Uint8Array>) =>
  new Response(body).arrayBuffer().then((b) => new TextDecoder().decode(new Uint8Array(b).slice(0, 6)));

describe("GIPHY", () => {
  test("a search: the key, the rating and the language go to GIPHY; only GIFs at the rating on its hosts come back", async () => {
    const giphy = fakeGiphy();
    const gifs = createGiphyGifs({ apiKey: "test-key", fetch: giphy.fetch });
    const page = await gifs.search({ query: "  happy   dance ", rating: "g", lang: "pt", limit: 4, offset: 0 });
    expect(page).toEqual({ gifs: [{ id: "aaa111", title: "Happy dance GIF", width: 480, height: 270 }], next: 4 });
    const [call] = giphy.api();
    expect(call?.pathname).toBe("/v1/gifs/search");
    expect(Object.fromEntries(call?.searchParams ?? [])).toEqual({
      api_key: "test-key",
      q: "happy dance",
      lang: "pt",
      rating: "g",
      limit: "4",
      offset: "0",
    });
    // Up to `pg` the rated one comes too, never the one rated `r`.
    const pg = await gifs.search({ query: "happy dance", rating: "pg", limit: 4, offset: 0 });
    expect(pg.gifs.map((g) => g.id)).toEqual(["aaa111", "bbb222"]);
  });

  test("pages: GIPHY's total when it says one, else a full page; the same page again costs no call", async () => {
    const giphy = fakeGiphy();
    const gifs = createGiphyGifs({ apiKey: "k", fetch: giphy.fetch });
    expect((await gifs.search({ query: "dance", rating: "g", limit: 4, offset: 24 })).next).toBe(28);
    expect((await gifs.trending({ rating: "g", limit: 4, offset: 0 })).next).toBe(4);
    expect((await gifs.trending({ rating: "g", limit: 10, offset: 0 })).next).toBeNull();
    // Past GIPHY's last offset: nothing, and no call.
    expect(await gifs.trending({ rating: "g", limit: 4, offset: 500 })).toEqual({ gifs: [], next: null });
    const before = giphy.api().length;
    await gifs.trending({ rating: "g", limit: 4, offset: 0 });
    expect(giphy.api()).toHaveLength(before);
    // An empty search is trending.
    await gifs.search({ query: "   ", rating: "g", limit: 4, offset: 0 });
    expect(giphy.api()).toHaveLength(before);
  });

  test("get: from what a page brought without a call, else GIPHY; null when missing or above the rating", async () => {
    const giphy = fakeGiphy();
    const gifs = createGiphyGifs({ apiKey: "k", fetch: giphy.fetch });
    await gifs.search({ query: "dance", rating: "pg", limit: 4, offset: 0 });
    const before = giphy.api().length;
    expect(await gifs.get("aaa111", "g")).toEqual({ id: "aaa111", title: "Happy dance GIF", width: 480, height: 270 });
    expect(await gifs.get("bbb222", "g")).toBeNull();
    expect(await gifs.get("ddd444", "pg")).toBeNull();
    expect(giphy.api()).toHaveLength(before);
    // Not seen yet: one call for it.
    const fresh = createGiphyGifs({ apiKey: "k", fetch: giphy.fetch });
    expect((await fresh.get("bbb222", "pg"))?.title).toBe("Party");
    expect(giphy.api().at(-1)?.pathname).toBe("/v1/gifs/bbb222");
    expect(await fresh.get("zzz999", "pg")).toBeNull();
    // Not an id at all: no call.
    const calls = giphy.api().length;
    expect(await fresh.get("../trending", "g")).toBeNull();
    expect(giphy.api()).toHaveLength(calls);
  });

  test("files: each size from its rendition, as an image, only from GIPHY's hosts", async () => {
    const giphy = fakeGiphy();
    const gifs = createGiphyGifs({ apiKey: "k", fetch: giphy.fetch });
    const preview = await gifs.media("aaa111", "preview", "g");
    expect(preview?.contentType).toBe("image/gif");
    expect(await text(preview?.body ?? new ArrayBuffer(0))).toBe("GIF89a");
    await gifs.media("aaa111", "full", "g");
    await gifs.media("aaa111", "still", "g");
    const files = giphy.calls.filter((u) => u.hostname === "media0.giphy.com").map((u) => u.pathname);
    expect(files).toEqual([
      "/media/aaa111/200w.gif",
      "/media/aaa111/giphy-downsized.gif",
      "/media/aaa111/giphy-downsized_s.gif",
    ]);
    // One lookup for the id, then its files without a call.
    expect(giphy.api().map((u) => u.pathname)).toEqual(["/v1/gifs/aaa111"]);
    expect(await gifs.media("zzz999", "full", "g")).toBeNull();
  });

  test("files: a GIF above the workspace's rating is none, and nothing of it is fetched", async () => {
    const giphy = fakeGiphy();
    const gifs = createGiphyGifs({ apiKey: "k", fetch: giphy.fetch });
    expect(await gifs.media("ddd444", "full", "pg")).toBeNull();
    expect(await gifs.media("bbb222", "full", "g")).toBeNull();
    expect(giphy.calls.filter((u) => u.hostname === "media0.giphy.com")).toEqual([]);
    expect((await gifs.media("bbb222", "full", "pg"))?.contentType).toBe("image/gif");
  });

  test("files refused: a page instead of an image, too big (said or sent), a redirect off GIPHY", async () => {
    const url = (id: string) => rendition(id, "giphy-downsized", 480, 270).url;
    /** The `full` file of a GIF rated `g`, as GIPHY's host answers it. */
    const fileWith = async (answer: () => Response) => {
      const giphy = fakeGiphy({ files: { [url("aaa111")]: answer } });
      return createGiphyGifs({ apiKey: "k", fetch: giphy.fetch }).media("aaa111", "full", "g");
    };
    expect(
      await fileWith(() => new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } })),
    ).toBeNull();
    const declared = { "content-type": "image/gif", "content-length": String(GIF_FILE_MAX_BYTES + 1) };
    expect(await fileWith(() => new Response(tinyGif(), { headers: declared }))).toBeNull();
    const big = new Uint8Array(1024 * 1024);
    let sent = 0;
    const endless = new ReadableStream({
      pull(controller) {
        sent += big.byteLength;
        controller.enqueue(big);
        if (sent > GIF_FILE_MAX_BYTES + big.byteLength) controller.close();
      },
    });
    expect(await fileWith(() => new Response(endless, { headers: { "content-type": "image/gif" } }))).toBeNull();

    const away = fakeGiphy({
      files: {
        [url("aaa111")]: () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.gif" } }),
        [url("bbb222")]: () =>
          new Response(null, { status: 302, headers: { location: "https://i.giphy.com/bbb222.gif" } }),
      },
    });
    const moved = createGiphyGifs({ apiKey: "k", fetch: away.fetch });
    await moved.search({ query: "dance", rating: "pg", limit: 4, offset: 0 });
    expect(await moved.media("aaa111", "full", "pg")).toBeNull();
    expect(away.calls.some((u) => u.hostname === "evil.example")).toBe(false);
    // Moved within GIPHY: followed.
    expect((await moved.media("bbb222", "full", "pg"))?.contentType).toBe("image/gif");
    expect(away.calls.at(-1)?.href).toBe("https://i.giphy.com/bbb222.gif");
  });

  test("GIPHY refusing the key or not answering: searches throw, files are just missing", async () => {
    const refused = createGiphyGifs({ apiKey: "bad", fetch: fakeGiphy({ status: 401 }).fetch });
    await expect(refused.search({ query: "dance", rating: "g", limit: 4, offset: 0 })).rejects.toBeInstanceOf(
      GifProviderError,
    );
    await expect(refused.get("aaa111", "g")).rejects.toMatchObject({ status: 401 });
    expect(await refused.media("aaa111", "full", "g")).toBeNull();
    const down = createGiphyGifs({ apiKey: "k", fetch: fakeGiphy({ down: true }).fetch });
    await expect(down.trending({ rating: "g", limit: 4, offset: 0 })).rejects.toBeInstanceOf(GifProviderError);
  });

  test("ratings, from the mildest: g < pg < pg-13 < r; one not listed is never shown", () => {
    expect(gifRatingAllowed("g", "g")).toBe(true);
    expect(gifRatingAllowed("Y", "g")).toBe(true);
    expect(gifRatingAllowed("pg", "g")).toBe(false);
    expect(gifRatingAllowed("pg", "pg")).toBe(true);
    expect(gifRatingAllowed("pg-13", "pg")).toBe(false);
    expect(gifRatingAllowed("r", "pg")).toBe(false);
    expect(gifRatingAllowed("", "pg")).toBe(false);
    expect(gifRatingAllowed(undefined, "pg")).toBe(false);
  });
});

describe("the fake provider", () => {
  test("deterministic answers at a rating, a real tiny GIF for any size, every call recorded", async () => {
    const gifs = createFakeGifs();
    const dance = await gifs.search({ query: "dance", rating: "g", limit: 10, offset: 0 });
    expect(dance.gifs.map((g) => g.id)).toEqual(["fakeCelebration1", "fakeFriday1"]);
    const all = await gifs.trending({ rating: "pg", limit: 50, offset: 0 });
    expect(all.gifs.map((g) => g.id)).toContain("fakeParty1");
    expect(all.gifs.map((g) => g.id)).not.toContain("fakeParty2");
    expect(await gifs.get("fakeParty1", "g")).toBeNull();
    expect(await gifs.get("fakeThanks1", "g")).toEqual({
      id: "fakeThanks1",
      title: "Thank you so much",
      width: 480,
      height: 360,
    });
    const file = await gifs.media("fakeThanks1", "still", "g");
    expect(await text(file?.body ?? new ArrayBuffer(0))).toBe("GIF89a");
    expect(await gifs.media("nope", "full", "g")).toBeNull();
    // Above the rating: none.
    expect(await gifs.media("fakeWild1", "full", "pg")).toBeNull();
    expect(await gifs.media("fakeParty1", "full", "g")).toBeNull();
    expect(gifs.calls.media).toEqual([
      { id: "fakeThanks1", size: "still", rating: "g" },
      { id: "nope", size: "full", rating: "g" },
      { id: "fakeWild1", size: "full", rating: "pg" },
      { id: "fakeParty1", size: "full", rating: "g" },
    ]);
  });
});

describe("GIPHY with the installation's key (ADR 0091, amended 2026-10-31)", () => {
  test("GIPHY with its own key and the fake can always search", () => {
    expect(createGiphyGifs({ apiKey: "k", fetch: fakeGiphy().fetch }).available()).toBe(true);
    expect(createFakeGifs().available()).toBe(true);
  });

  test("follows the key on every call: unavailable without one, a new key used at once with pages of its own", async () => {
    const giphy = fakeGiphy();
    let key: string | null = null;
    const gifs = createKeyedGifs({ key: () => key, fetch: giphy.fetch });
    expect(gifs.available()).toBe(false);
    await expect(gifs.trending({ rating: "g", limit: 4, offset: 0 })).rejects.toBeInstanceOf(GifProviderError);
    await expect(gifs.get("aaa111", "g")).rejects.toBeInstanceOf(GifProviderError);
    expect(await gifs.media("aaa111", "full", "g")).toBeNull();
    expect(giphy.calls).toEqual([]);

    key = "first-key";
    expect(gifs.available()).toBe(true);
    const page = await gifs.search({ query: "dance", rating: "g", limit: 4, offset: 0 });
    expect(page.gifs.map((g) => g.id)).toEqual(["aaa111"]);
    // The same page again comes from the client kept for that key.
    await gifs.search({ query: "dance", rating: "g", limit: 4, offset: 0 });
    key = "second-key";
    await gifs.search({ query: "dance", rating: "g", limit: 4, offset: 0 });
    expect(giphy.api().map((u) => u.searchParams.get("api_key"))).toEqual(["first-key", "second-key"]);

    key = null;
    expect(gifs.available()).toBe(false);
    await expect(gifs.search({ query: "dance", rating: "g", limit: 4, offset: 0 })).rejects.toBeInstanceOf(
      GifProviderError,
    );
  });

  test("a key's check: one trending GIF with it; only a refusal says the key is wrong", async () => {
    const ok = fakeGiphy();
    expect(await checkGiphyKey("good-key", { fetch: ok.fetch })).toBe("ok");
    const [call, ...more] = ok.api();
    expect(more).toEqual([]);
    expect(call?.pathname).toBe("/v1/gifs/trending");
    expect(call?.searchParams.get("limit")).toBe("1");
    expect(call?.searchParams.get("api_key")).toBe("good-key");
    for (const status of [401, 403]) {
      expect(await checkGiphyKey("bad-key", { fetch: fakeGiphy({ status }).fetch })).toBe("invalid");
    }
    // A limit, an outage or no answer says nothing about the key.
    for (const status of [429, 500]) {
      expect(await checkGiphyKey("some-key", { fetch: fakeGiphy({ status }).fetch })).toBe("unknown");
    }
    expect(await checkGiphyKey("some-key", { fetch: fakeGiphy({ down: true }).fetch })).toBe("unknown");
  });
});
