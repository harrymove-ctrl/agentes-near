import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { previewBody } from "@agenteschat/client/lib/message-body";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, NOW, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {}
});

const open = async (state: FakeState = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/** The composer's one picker (ADR 0091), opened from its button. */
const openPicker = async () => {
  await click(screen().getByRole("button", { name: "Emojis, GIFs e figurinhas" }));
  await settle(3);
  return screen().getByRole("dialog", { name: "Emojis, GIFs e figurinhas" });
};
const tabsOf = (dialog: HTMLElement) =>
  within(within(dialog).getByRole("tablist", { name: "O que mandar" }))
    .getAllByRole("tab")
    .map((t) => t.textContent);
const pickTab = async (dialog: HTMLElement, name: string) => {
  await act(async () => fireEvent.mouseDown(within(dialog).getByRole("tab", { name }), { button: 0 }));
  await settle(4);
};
const posted = (state: FakeState) => state.calls.filter((c) => c.method === "chat.post").map((c) => c.args[2]);

const GIF_MEDIA = { kind: "gif", provider: "giphy", id: "gif-party", title: "party cat", width: 480, height: 360 };
const mediaPath = (id: string, size: string) => `/api/app/organizations/${ORG_ID}/gifs/${id}/media?size=${size}`;

describe("the composer's picker: Emojis, GIFs and Figurinhas (ADR 0091)", () => {
  test("one picker with three tabs; a GIF goes at once, alone, and shows from our server", async () => {
    const { state } = await open();
    const dialog = await openPicker();
    expect(tabsOf(dialog)).toEqual(["Emojis", "GIFs", "Figurinhas"]);
    await pickTab(dialog, "GIFs");
    expect(within(dialog).getByRole("searchbox", { name: "Buscar GIFs" })).toBeTruthy();
    expect(within(dialog).getByText("GIFs do GIPHY")).toBeTruthy();
    // The picker's files come from our server too.
    const cell = within(dialog).getByRole("button", { name: "GIF: party cat" });
    expect(cell.querySelector("img")?.getAttribute("src")).toBe(mediaPath("gif-party", "preview"));
    await click(cell);
    await settle(4);
    expect(posted(state)).toEqual([expect.objectContaining({ body: "", media: { kind: "gif", id: "gif-party" } })]);
    expect(screen().queryByRole("dialog")).toBeNull();
    // The message is the GIF alone, at its proportions (still here: these tests run with reduced motion).
    const gif = screen().getByRole("img", { name: "GIF: party cat" });
    expect(gif.getAttribute("src")).toBe(mediaPath("gif-party", "still"));
    expect(gif.closest("article")?.querySelector(".ac-msg__text")).toBeNull();
    expect(gif.closest(".ac-gif")?.querySelector(".ac-gif__mark")?.textContent).toBe("GIF");
  });

  test("a sticker: each agent's seven moods; one click sends it, drawn from the agent's look", async () => {
    const { state } = await open();
    const dialog = await openPicker();
    await pickTab(dialog, "Figurinhas");
    const ada = within(dialog).getByRole("region", { name: "Ada" });
    expect(within(ada).getAllByRole("button")).toHaveLength(7);
    expect(within(dialog).getByRole("region", { name: "Atlas" })).toBeTruthy();
    await click(within(ada).getByRole("button", { name: "Figurinha da Ada: comemorando" }));
    await settle(4);
    expect(posted(state)).toEqual([
      expect.objectContaining({ body: "", media: { kind: "sticker", agentId: ADA_ID, mood: "celebrate" } }),
    ]);
    const sticker = screen().getByRole("img", { name: "Figurinha da Ada: comemorando" });
    expect(sticker.tagName).toBe("CANVAS");
    expect(sticker.closest("article")?.querySelector(".ac-msg__text")).toBeNull();
  });

  test("the tabs follow the workspace and the server; with neither, the emoji picker it always was", async () => {
    const cases: [FakeState["media"], string[]][] = [
      [{ gifsAvailable: false }, ["Emojis", "Figurinhas"]],
      [{ gifs: false }, ["Emojis", "Figurinhas"]],
      [{ agentStickers: false }, ["Emojis", "GIFs"]],
    ];
    for (const [media, tabs] of cases) {
      await open(seedState({ media }));
      expect(tabsOf(await openPicker())).toEqual(tabs);
      cleanup();
    }
    // No agents: no stickers to send; GIFs off too: no tabs at all.
    const empty = seedState({ media: { gifs: false } });
    empty.agents = [];
    await open(empty);
    await click(screen().getByRole("button", { name: "Emoji" }));
    await settle(3);
    const plain = screen().getByRole("dialog", { name: "Emojis" });
    expect(within(plain).queryByRole("tablist")).toBeNull();
    expect(within(plain).getByRole("searchbox", { name: "Buscar emoji" })).toBeTruthy();
  });

  test("the reaction picker stays emoji only", async () => {
    await open();
    const bar = within(row("m-1")).getByRole("toolbar", { name: "Ações da mensagem de João" });
    await click(within(bar).getByRole("button", { name: "Reagir" }));
    await settle(2);
    expect(within(screen().getByRole("dialog", { name: "Emojis" })).queryByRole("tablist")).toBeNull();
  });

  test("GIFs turned off meanwhile: the tab says so in words", async () => {
    const { state } = await open();
    const dialog = await openPicker();
    state.media = { gifs: false };
    await pickTab(dialog, "GIFs");
    expect(within(dialog).getByRole("status").textContent).toContain("Os GIFs estão desligados neste workspace.");
  });
});

describe("GIFs and stickers in the conversation", () => {
  const withMedia = () => {
    const state = seedState();
    state.messages.push(
      {
        id: "m-gif",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: { media: GIF_MEDIA },
        createdAt: minutesAgo(50),
      },
      {
        id: "m-thanks",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "De nada!",
        mentionedAgentIds: [],
        agentRunId: "r-thanks",
        createdAt: minutesAgo(49),
      },
      // Ada's sticker right after her reply: silent, a message of its own (it carries her reply's run).
      {
        id: "m-sticker",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "",
        mentionedAgentIds: [],
        agentRunId: "r-thanks",
        meta: { media: { kind: "sticker", agentId: ADA_ID, mood: "love" }, mediaAfter: "m-thanks" },
        createdAt: minutesAgo(48.9),
      },
      {
        id: "m-quote",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-walter" },
        body: "Hahaha",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: {
          replyTo: {
            messageId: "m-gif",
            threadId: null,
            author: { type: "person", id: "u-joao" },
            authorName: "João",
            excerpt: "",
            mediaKind: "gif",
          },
        },
        createdAt: minutesAgo(48),
      },
    );
    return state;
  };

  test("a GIF: no words, its mark, still until hovered (reduced motion), then it plays", async () => {
    await open(withMedia());
    const gif = within(row("m-gif")).getByRole("img", { name: "GIF: party cat" });
    expect(row("m-gif").querySelector(".ac-msg__text")).toBeNull();
    expect(gif.getAttribute("src")).toBe(mediaPath("gif-party", "still"));
    expect([gif.getAttribute("width"), gif.getAttribute("height")]).toEqual(["480", "360"]);
    const frame = gif.closest(".ac-gif") as HTMLElement;
    await act(async () => fireEvent.mouseEnter(frame));
    expect(within(row("m-gif")).getByRole("img", { name: "GIF: party cat" }).getAttribute("src")).toBe(
      mediaPath("gif-party", "full"),
    );
  });

  test("a GIF the server no longer serves leaves its title and the mark, no broken picture", async () => {
    await open(withMedia());
    await act(async () => fireEvent.error(within(row("m-gif")).getByRole("img", { name: "GIF: party cat" })));
    const card = within(row("m-gif")).getByRole("img", { name: "GIF: party cat" });
    expect(card.tagName).toBe("SPAN");
    expect(card.querySelector("img")).toBeNull();
    expect(card.textContent).toContain("party cat");
    expect(card.querySelector(".ac-gif__mark")?.textContent).toBe("GIF");
  });

  test("an agent's sticker after its reply: no words, a reaction, never the reply's feedback", async () => {
    await open(withMedia());
    const sticker = row("m-sticker");
    expect(within(sticker).getByRole("img", { name: "Figurinha da Ada: amei" }).tagName).toBe("CANVAS");
    expect(sticker.querySelector(".ac-msg__text")).toBeNull();
    expect(within(sticker).queryByRole("button", { name: "Útil" })).toBeNull();
    const bar = within(sticker).getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    expect(within(bar).getByRole("button", { name: "Reagir" })).toBeTruthy();
    // The reply keeps its own feedback.
    await act(async () => fireEvent.mouseEnter(row("m-thanks")));
    expect(within(row("m-thanks")).getByRole("button", { name: "Útil" })).toBeTruthy();
  });

  test("a quote of a GIF says GIF", async () => {
    await open(withMedia());
    expect(
      within(row("m-quote")).getByRole("button", { name: "Resposta a João: GIF. Ver a mensagem" }).textContent,
    ).toContain("GIF");
  });
});

describe("Responder on a media-only message that just arrived", () => {
  // The live echo starts the message's thread list: it holds the message, so the panel never opens empty.
  const kinds = [
    ["a GIF", { media: GIF_MEDIA }, ".ac-gif"],
    ["a sticker", { media: { kind: "sticker", agentId: ADA_ID, mood: "love" } }, "canvas[role=img]"],
    ["an image", "image", ".artifact-tile[data-media] img"],
    ["a file", "file", ".artifact-tile[data-kind='file']"],
    ["a voice message", { voice: { clipId: "clip-1", durationMs: 4000, peaks: [0.2, 0.6, 0.4] } }, ".ac-voice"],
  ] as const;
  for (const [what, meta, selector] of kinds) {
    test(`${what}: the thread panel shows it as the root`, async () => {
      const state = seedState();
      const api = createFakeApi(state);
      const upload = async (name: string, type: string) =>
        (await api.artifacts.upload(ORG_ID, new File([new Uint8Array([137, 80, 78, 71])], name, { type }))).id;
      const realMeta =
        meta === "image"
          ? { artifacts: [{ id: await upload("tela.png", "image/png"), version: 1 }] }
          : meta === "file"
            ? { artifacts: [{ id: await upload("notas.pdf", "application/pdf"), version: 1 }] }
            : meta;
      const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
      await settle(6);
      const socket = r.sockets.last();
      await act(async () => socket.open());
      await settle(2);
      const message = {
        id: "m-live",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person" as const, id: "u-joao" },
        body: "",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: realMeta,
        createdAt: new Date().toISOString(),
      };
      state.messages.push(message);
      await act(async () =>
        socket.push({
          type: "event",
          channelId: ENG_ID,
          event: { channelId: ENG_ID, type: "message.created", messageId: message.id, message },
        }),
      );
      await settle(4);
      await act(async () => fireEvent.mouseEnter(row("m-live")));
      await click(within(within(row("m-live")).getByRole("toolbar")).getByRole("button", { name: "Responder" }));
      await settle(8);
      const panel = screen().getByRole("complementary", { name: "Thread" });
      const root = panel.querySelector('article[data-message-id="m-live"]');
      expect(root).toBeTruthy();
      expect(root?.querySelector(selector)).toBeTruthy();
    });
  }
});

describe("where a message's words would show", () => {
  test("the inbox: a sticker with no words says Figurinha", async () => {
    const state = seedState({
      notifications: [
        notification({
          id: "n-sticker",
          kind: "dm",
          actors: [{ type: "user", id: "u-joao" }],
          source: { dmId: "dm-1" },
          latest: { media: "sticker" },
        }),
      ],
    });
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(8);
    expect(document.querySelector('[data-n="n-sticker"] .nt-snip')?.textContent).toBe("Figurinha");
  });

  test("a message list's preview: the word for a GIF or a sticker with no text, in the person's language", () => {
    const t = createI18n("pt-BR").t;
    expect(previewBody(t, "", null, "gif")).toBe("GIF");
    expect(previewBody(t, "", { media: { kind: "sticker" } })).toBe("Figurinha");
    const en = createI18n("en").t;
    expect(previewBody(en, "", null, "sticker")).toBe("Sticker");
  });
});
