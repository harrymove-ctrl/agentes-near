import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Message } from "../src/api/types";
import { createHttpApi } from "../src/index";
import {
  GIF_CATEGORY_IDS,
  gifLabel,
  gifMedia,
  gifMediaUrl,
  hitText,
  isMediaAfterReply,
  mediaKindOf,
  messageMediaOf,
  postedMedia,
  quoteText,
  STICKER_MOODS,
  stickerLabel,
  stickerMedia,
  textOrMedia,
} from "../src/lib/media";
import { previewBody } from "../src/lib/message-body";
import { localMeta, replyOf } from "../src/lib/reply";
import { buildTimeline } from "../src/lib/timeline";

/** The words these helpers say, as the app's pt-BR has them. */
const WORDS: Record<string, string> = {
  "media.word.gif": "GIF",
  "media.word.sticker": "Figurinha",
  "media.gifTitled": "GIF: {{title}}",
  "media.stickerOf": "Figurinha do {{name}}: {{mood}}",
  "media.stickerOf_female": "Figurinha da {{name}}: {{mood}}",
  "media.moods.celebrate": "comemorando",
  "media.moods.love": "amei",
  "voice.word": "Mensagem de voz",
};
const t = ((key: string, o: Record<string, string> = {}) =>
  (WORDS[o.context ? `${key}_${o.context}` : key] ?? WORDS[key] ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_, k: string) => o[k] ?? "",
  )) as unknown as TFunction;

const GIF = { kind: "gif", provider: "giphy", id: "abc", title: "party cat", width: 480, height: 270 };
const STICKER = { kind: "sticker", agentId: "ag-1", mood: "love" };

const message = (patch: Partial<Message> = {}): Message => ({
  id: "m-1",
  channelId: "c-1",
  threadId: null,
  author: { type: "person", id: "u-1" },
  body: "",
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: "2026-10-31T12:00:00.000Z",
  ...patch,
});

describe("what a message carries (ADR 0091)", () => {
  // Read from the server's source, not imported: the client never loads the engine (it holds the database).
  test("the same moods and categories as the server (packages/engine/src/media.ts), in its order", async () => {
    const source = await Bun.file(new URL("../../engine/src/media.ts", import.meta.url).pathname).text();
    const moods = /STICKER_MOODS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    const categories = /GIF_CATEGORIES = \{([^}]*)\}/.exec(source)?.[1] ?? "";
    expect<string[]>([...STICKER_MOODS]).toEqual([...moods.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? ""));
    expect<string[]>([...GIF_CATEGORY_IDS]).toEqual([...categories.matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? ""));
  });

  test("the wave is a sticker people send: a mood the client reads and posts", () => {
    expect(STICKER_MOODS).toContain("wave");
    const wave = { kind: "sticker", agentId: "ag-1", mood: "wave" };
    expect(messageMediaOf({ media: wave })).toEqual(wave as never);
    expect(stickerMedia("ag-1", "wave")).toEqual({ kind: "sticker", agentId: "ag-1", mood: "wave" });
  });

  test("messageMediaOf reads meta.media as the server does; anything malformed is none", () => {
    for (const media of [
      { kind: "gif", id: "" },
      { kind: "sticker", agentId: "ag-1", mood: "angry" },
      { kind: "video", id: "x" },
      "gif",
    ])
      expect(messageMediaOf({ media })).toBeNull();
    expect(messageMediaOf({})).toBeNull();
    expect(messageMediaOf({ media: STICKER })).toEqual(STICKER as never);
    expect(messageMediaOf({ media: { kind: "gif", id: "x", title: 3, width: -1 } })).toMatchObject({
      title: "",
      width: 1,
      height: 1,
    });
    expect(messageMediaOf({ media: GIF })).toEqual(GIF as never);
    expect(messageMediaOf({ media: { kind: "gif", id: "x" } })).toEqual({
      kind: "gif",
      provider: "giphy",
      id: "x",
      title: "",
      width: 1,
      height: 1,
    });
    expect(messageMediaOf(undefined)).toBeNull();
    expect(messageMediaOf(null)).toBeNull();
  });

  test("the silent sticker after an agent's reply is marked by meta.mediaAfter", () => {
    expect(isMediaAfterReply({ media: STICKER, mediaAfter: "m-reply" })).toBe(true);
    expect(isMediaAfterReply({ media: STICKER })).toBe(false);
    expect(isMediaAfterReply(undefined)).toBe(false);
  });

  test("a GIF's file is always our server's media route, never the provider's address", () => {
    expect(gifMediaUrl("org-1", "abc", "preview")).toBe("/api/app/organizations/org-1/gifs/abc/media?size=preview");
    expect(gifMediaUrl("org-1", "a/b c", "full")).toBe("/api/app/organizations/org-1/gifs/a%2Fb%20c/media?size=full");
    // The phone app: its server first.
    expect(gifMediaUrl("org-1", "abc", "still", "https://app.example.com/")).toBe(
      "https://app.example.com/api/app/organizations/org-1/gifs/abc/media?size=still",
    );
  });

  test("what goes to the server names the GIF or the sticker, never a GIF's size or title", () => {
    const picked = gifMedia({ id: "abc", title: "party cat", width: 480, height: 270 });
    expect(picked).toEqual(GIF as never);
    expect(postedMedia(picked)).toEqual({ kind: "gif", id: "abc" });
    expect(postedMedia(stickerMedia("ag-1", "deal"))).toEqual({ kind: "sticker", agentId: "ag-1", mood: "deal" });
  });
});

describe("the word for a GIF or a sticker where text shows", () => {
  test("a kind stored beside a text, however it was written", () => {
    expect(mediaKindOf("gif")).toBe("gif");
    expect(mediaKindOf({ kind: "sticker" })).toBe("sticker");
    expect(mediaKindOf("video")).toBeNull();
    expect(mediaKindOf(undefined)).toBeNull();
  });

  test("a message's text, or the word for its media when it has none", () => {
    expect(textOrMedia(t, "", { media: GIF })).toBe("GIF");
    expect(textOrMedia(t, "  ", { media: STICKER })).toBe("Figurinha");
    expect(textOrMedia(t, "olha isso", { media: GIF })).toBe("olha isso");
    expect(textOrMedia(t, "", {})).toBe("");
  });

  test("a last-message preview: the list's mediaKind or its meta's kind, only with no text", () => {
    expect(previewBody(t, "", null, "gif")).toBe("GIF");
    expect(previewBody(t, "", { mediaKind: "sticker" })).toBe("Figurinha");
    expect(previewBody(t, "", { media: { kind: "gif" } })).toBe("GIF");
    expect(previewBody(t, "valeu!", null, "sticker")).toBe("valeu!");
    expect(previewBody(t, "", null)).toBe("");
    expect(previewBody(t, "**O deploy**\n\n| a |\n| - |\n| b |", null)).toBe("O deploy a b");
    expect(previewBody(t, "**O deploy**", {})).toBe("O deploy");
  });

  test("a quote of a GIF says GIF, read from the server's reply ref and written in the optimistic one", () => {
    const meta = { replyTo: { messageId: "m-9", author: { type: "person", id: "u-2" }, excerpt: "", media: "gif" } };
    const reply = replyOf(meta);
    expect(reply?.media).toBe("gif");
    expect(reply && quoteText(t, reply)).toBe("GIF");
    expect(replyOf({ replyTo: { messageId: "m-9", excerpt: "", mediaKind: { kind: "sticker" } } })?.media).toBe(
      "sticker",
    );
    // A plain quote has no media key at all.
    expect(Object.keys(replyOf({ replyTo: { messageId: "m-9", excerpt: "oi" } }) ?? {})).not.toContain("media");
    const local = localMeta(message({ id: "m-gif", meta: { media: GIF } }), "Ana", []);
    expect(replyOf(local)).toMatchObject({ messageId: "m-gif", excerpt: "", media: "gif" });
    expect(quoteText(t, { excerpt: "oi", media: "gif" })).toBe("oi");
  });

  test("a quote's line reads as words: no Markdown's marks, and something where the original has none", () => {
    expect(quoteText(t, { excerpt: "## Resumo **do deploy** em [produção](https://x.test)" })).toBe(
      "Resumo do deploy em produção",
    );
    expect(quoteText(t, { excerpt: "- primeiro item" })).toBe("primeiro item");
    expect(quoteText(t, { excerpt: "" })).toBe("channel.quoteNoWords");
    const file = { id: "a-1", version: 1, title: "relatorio.pdf" };
    expect(replyOf(localMeta(message({ id: "m-file", meta: { artifacts: [file] } }), "Ana", []))?.excerpt).toBe(
      "relatorio.pdf",
    );
  });

  test("a reply shown away from its root quotes it: a sticker root says Figurinha", () => {
    const root = message({ id: "root", meta: { media: STICKER }, createdAt: "2026-10-31T12:00:00.000Z" });
    const other = message({ id: "other", body: "outra coisa", createdAt: "2026-10-31T12:01:00.000Z" });
    const reply = message({ id: "r", threadId: "root", body: "kkk", createdAt: "2026-10-31T12:02:00.000Z" });
    const items = buildTimeline([root, other, reply], [], []);
    const shown = items.find((i) => i.kind === "message" && i.message.id === "r");
    const context = shown?.kind === "message" ? shown.context : undefined;
    expect(context).toMatchObject({ messageId: "root", media: "sticker" });
  });

  test("names for screen readers: a GIF by its title, a sticker by its agent and mood", () => {
    expect(gifLabel(t, "party cat")).toBe("GIF: party cat");
    expect(gifLabel(t, "  ")).toBe("GIF");
    expect(stickerLabel(t, "Ada", "love")).toBe("Figurinha da Ada: amei");
    expect(stickerLabel(t, "Dev", "celebrate")).toBe("Figurinha do Dev: comemorando");
  });

  test("a search hit says its words, else what it was: only a voice message's hit says voice message", () => {
    expect(hitText(t, { snippet: "deploy notes", mediaKind: "gif" })).toBe("deploy notes");
    expect(hitText(t, { snippet: "**O deploy**\n\n```sh\nbun run\n```" })).toBe("O deploy bun run");
    expect(hitText(t, { snippet: "", mediaKind: "voice" })).toBe("Mensagem de voz");
    // Listed by filters alone: a GIF or a sticker sent with no words.
    expect(hitText(t, { snippet: "", mediaKind: "gif" })).toBe("GIF");
    expect(hitText(t, { snippet: "", mediaKind: "sticker" })).toBe("Figurinha");
    expect(hitText(t, { snippet: "" })).toBe("");
  });
});

describe("HTTP client (ADR 0091)", () => {
  function fakeFetch(responses: Record<string, { status: number; body?: unknown }>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses[`${init.method} ${url}`] ?? { status: 404, body: { error: { code: "gifs.off" } } };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    };
    return { fetch, calls };
  }
  const org = "/api/app/organizations/o1";

  test("GIF search: free text or a category (never both), a page at a time; gifs.off is an ApiError", async () => {
    const page = { gifs: [{ id: "g1", title: "oi", width: 10, height: 10 }], next: 24 };
    const { fetch, calls } = fakeFetch({
      [`GET ${org}/gifs?q=gato&offset=24&limit=24&lang=pt`]: { status: 200, body: page },
      [`GET ${org}/gifs?category=thanks&limit=24&lang=en`]: { status: 200, body: { gifs: [], next: null } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.gifs?.search("o1", { q: " gato ", offset: 24, limit: 24, lang: "pt" })).toEqual(page);
    expect(await api.gifs?.search("o1", { category: "thanks", offset: 0, limit: 24, lang: "en" })).toEqual({
      gifs: [],
      next: null,
    });
    const off = await api.gifs?.search("o1", {}).catch((e) => e);
    expect(off).toMatchObject({ status: 404, code: "gifs.off" });
    expect(calls.every((c) => c.init.method === "GET")).toBe(true);
  });

  test("posting a GIF or a sticker sends what names it, with an empty body", async () => {
    const sent = message({ id: "srv-1", meta: { media: GIF } });
    const { fetch, calls } = fakeFetch({ [`POST ${org}/channels/c1/messages`]: { status: 201, body: sent } });
    const api = createHttpApi({ fetch });
    const media = { kind: "gif", id: "abc" } as const;
    await api.chat.post("o1", "c1", { body: "", clientId: "k1", media });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ body: "", clientId: "k1", media });
  });
});
