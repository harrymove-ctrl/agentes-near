import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys, type Message } from "@agenteschat/client";
import type { ChatPrefs } from "@agenteschat/client/lib/chat-look";
import { MessageLookContext, MessageText, Message as Row } from "@agenteschat/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { type ReactNode, useLayoutEffect } from "react";
import { usePageTextSize } from "@/chat/look";
import {
  ADA_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  GENERAL_ID,
  NOW,
  ORG_ID,
  seedDm,
  seedState,
  withChatPrefs,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const said = (channelId: string, id: string, who: string, body: string, minutes: number) =>
  ({
    id,
    channelId,
    threadId: null,
    author: who.startsWith("u-") ? { type: "person", id: who } : { type: "agent", id: who },
    body,
    mentionedAgentIds: [],
    agentRunId: who.startsWith("u-") ? null : `r-${id}`,
    createdAt: ago(minutes),
  }) as Message;

const row = (id: string) => {
  const el = document.querySelector<HTMLElement>(`article[data-message-id="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};

/** #eng with João, me and Ada; `personal`: in a personal workspace (ADR 0159). */
async function openChannel(prefs?: ChatPrefs, personal = false) {
  const messages = [
    said(ENG_ID, "j1", "u-joao", "Bom dia!", 30),
    said(ENG_ID, "w1", "u-walter", "Vi o alerta", 20),
    said(ENG_ID, "a1", ADA_ID, "Olhando.", 10),
  ];
  const state = withChatPrefs(seedState({ messages }), prefs);
  const org = state.me?.organizations[0];
  if (personal && org) org.mode = "personal";
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(10);
}

async function openDm(prefs?: ChatPrefs) {
  const state = seedState();
  const channelId = seedDm(state, { type: "agent", id: ADA_ID }, { body: "x" });
  state.messages = [
    ...state.messages.filter((m) => m.channelId !== channelId),
    said(channelId, "w1", "u-walter", "Quantas faltam?", 20),
    said(channelId, "a1", ADA_ID, "Faltam 14.", 10),
  ];
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(withChatPrefs(state, prefs)) });
  await settle(10);
}

describe("the defaults", () => {
  test("a channel lists everyone on the left: my row has its face, name and time", async () => {
    await openChannel();
    const mine = row("w1");
    expect(mine.dataset.look).toBe("left");
    expect(mine.classList.contains("ac-msg--own")).toBe(false);
    expect(mine.querySelector(".ac-msg__avatar")).not.toBeNull();
    expect(mine.querySelector(".ac-msg__head .ac-msg__author")?.textContent).toContain("Walter");
    expect(mine.querySelector(".ac-msg__own-foot")).toBeNull();
  });

  test("in a personal workspace a channel opens in bubbles too, mine on the right; a choice still wins", async () => {
    await openChannel(undefined, true);
    expect(row("w1").dataset.look).toBe("bubbles");
    expect(row("w1").dataset.tone).toBe("light");
    expect(row("w1").classList.contains("ac-msg--own")).toBe(true);
    cleanup();
    await openChannel({ channelStyle: "left" }, true);
    expect(row("w1").dataset.look).toBe("left");
  });

  test("a DM is in bubbles with the light tone: mine on the right in the agent's color, no name, the time inside", async () => {
    await openDm();
    const mine = row("w1");
    expect(mine.dataset.look).toBe("bubbles");
    expect(mine.dataset.tone).toBe("light");
    expect(mine.classList.contains("ac-msg--own")).toBe(true);
    expect(mine.style.getPropertyValue("--msg-mine")).not.toBe("");
    expect(mine.querySelector(".ac-msg__own-foot")).toBeNull();
    expect(mine.querySelector(".ac-msg__text .ac-msg__stamp")?.textContent).toContain(":");
    expect(mine.style.getPropertyValue("--stamp-text")).toBe(
      JSON.stringify(mine.querySelector(".ac-msg__stamp .ac-msg__time")?.textContent),
    );
    const theirs = row("a1");
    expect(theirs.dataset.names).toBe("false");
    expect(theirs.querySelector(".ac-msg__head")).toBeNull();
    expect(theirs.querySelector(".ac-msg__text .ac-msg__stamp")).not.toBeNull();
  });

  test("a DM whose sides say who spoke shows no face; one in Esquerda, and a channel, keep it", async () => {
    await openDm();
    expect(row("a1").querySelector(".ac-msg__avatar")).toBeNull();
    expect(row("a1").dataset.faces).toBe("false");
    expect(document.querySelector(".channel__messages")?.getAttribute("data-faces")).toBe("false");
    cleanup();
    await openDm({ dmStyle: "left" });
    expect(row("a1").querySelector(".ac-msg__avatar")).not.toBeNull();
    expect(document.querySelector(".channel__messages")?.hasAttribute("data-faces")).toBe(false);
    cleanup();
    await openChannel({ channelStyle: "bubbles" });
    expect(row("a1").querySelector(".ac-msg__avatar")).not.toBeNull();
  });
});

describe("each style in a channel and in a DM", () => {
  test("Confortável is the original layout in both", async () => {
    await openChannel({ channelStyle: "comfortable" });
    expect(row("w1").classList.contains("ac-msg--own")).toBe(true);
    expect(row("w1").querySelector(".ac-msg__own-foot")).not.toBeNull();
    expect(row("a1").querySelector(".ac-msg__stamp")).toBeNull();
    cleanup();
    await openDm({ dmStyle: "comfortable" });
    expect(row("w1").querySelector(".ac-msg__own-foot")).not.toBeNull();
    expect(row("a1").querySelector(".ac-msg__head")).not.toBeNull();
  });

  test("Tudo à esquerda in a DM has no bubble either", async () => {
    await openDm({ dmStyle: "left" });
    expect(row("w1").classList.contains("ac-msg--own")).toBe(false);
    expect(row("w1").querySelector(".ac-msg__stamp")).toBeNull();
  });

  test("Bolhas in a channel: the name in the bubble with its color, mine in the strong tone when chosen", async () => {
    await openChannel({ channelStyle: "bubbles", channelTone: "strong" });
    const ada = row("a1");
    expect(ada.querySelector(".ac-msg__text .ac-msg__bubble-head")?.textContent).toContain("Ada");
    expect(ada.dataset.names).toBeUndefined();
    expect(ada.style.getPropertyValue("--msg-name")).not.toBe("");
    expect(row("w1").dataset.tone).toBe("strong");
  });

  test("Compacta: the time ahead of every row, mine on the left", async () => {
    for (const open of [() => openChannel({ channelStyle: "compact" }), () => openDm({ dmStyle: "compact" })]) {
      await open();
      expect(row("w1").dataset.look).toBe("compact");
      expect(row("w1").classList.contains("ac-msg--own")).toBe(false);
      expect(row("a1").querySelector(":scope > .ac-msg__clock")?.textContent).toContain(":");
      cleanup();
    }
  });
});

describe("Tamanho do texto in a conversation", () => {
  test("a step chosen on another device is the page's, for every conversation and panel on it, until it closes", async () => {
    await openChannel({ textSize: "xs" });
    expect(document.documentElement.dataset.textSize).toBe("xs");
    expect(row("a1").closest("[data-text-size]")).toBe(document.documentElement);
    cleanup();
    expect(document.documentElement.dataset.textSize).toBeUndefined();
    await openDm();
    expect(document.documentElement.dataset.textSize).toBe("md");
  });

  test("the page has the step before it paints: rows from the device's snapshot never show at the default first", () => {
    delete document.documentElement.dataset.textSize;
    let painted: string | undefined;
    function Page() {
      usePageTextSize({ textSize: "xl" });
      return null;
    }
    // A later sibling's layout effect runs ahead of every passive one, when the browser is about to paint.
    function Rows() {
      useLayoutEffect(() => {
        painted = document.documentElement.dataset.textSize;
      }, []);
      return null;
    }
    render(
      <>
        <Page />
        <Rows />
      </>,
    );
    expect(painted).toBe("xl");
  });
});

describe("The room a bubble's last line keeps for its time", () => {
  const bubble = (time: ReactNode, own = false) =>
    render(
      <MessageLookContext.Provider value={{ style: "bubbles", tone: "light", mine: "#0a7", names: true, faces: true }}>
        <Row avatar={null} author="Ada" time={time} own={own}>
          <MessageText>B</MessageText>
        </Row>
      </MessageLookContext.Provider>,
    ).container.querySelector<HTMLElement>(".ac-msg");

  test("is the time's own words, a 12-hour one as a 24-hour one, mine as anyone's", () => {
    for (const words of ["23:43", "11:08 PM", "오후 11:08"]) {
      for (const own of [false, true]) {
        const row = bubble(<time dateTime="2026-01-01T23:08:00Z">{words}</time>, own);
        expect(row?.style.getPropertyValue("--stamp-text")).toBe(JSON.stringify(words));
        expect(row?.querySelector(".ac-msg__text > .ac-msg__stamp")?.textContent).toBe(words);
        cleanup();
      }
    }
    expect(bubble("9:05 AM")?.style.getPropertyValue("--stamp-text")).toBe('"9:05 AM"');
  });

  test("a time that isn't plain words names none: the sheet keeps the widest clock's room", () => {
    const row = bubble(
      <span>
        <b>23</b>:43
      </span>,
    );
    expect(row?.style.getPropertyValue("--stamp-text")).toBe("");
  });

  test("the sheet reads those words, and keeps the mark's room on a row of mine before the mark is there", () => {
    const css = readFileSync(join(import.meta.dir, "../src/chat/looks.css"), "utf8");
    expect(css).toContain('content: var(--stamp-text, "00:00 PM");');
    expect(css).toContain(
      '.ac-msg--own[data-look="bubbles"],\n.ac-msg[data-look="bubbles"]:has(.ac-msg__stamp .ac-msg__aside) {',
    );
  });
});

describe("a row with no bubble in a DM", () => {
  test("keeps its name ahead of its time, as in a channel: a time alone beside a face reads as a broken line", async () => {
    const state = seedState();
    const channelId = seedDm(state, { type: "agent", id: ADA_ID }, { body: "x" });
    state.messages = [
      ...state.messages.filter((m) => m.channelId !== channelId),
      said(channelId, "w1", "u-walter", "Pode subir?", 20),
      { ...said(channelId, "c1", ADA_ID, "", 10), meta: { approvalId: "ap-merge" } } as Message,
    ];
    const approval = state.approvals.find((a) => a.id === "ap-merge");
    if (approval) Object.assign(approval, { channelId, threadId: null, messageId: "c1" });
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(withChatPrefs(state)) });
    await settle(10);
    const card = row("c1");
    expect(card.dataset.look).toBe("bubbles");
    expect(card.dataset.names).toBeUndefined();
    const head = card.querySelector(".ac-msg__head") as HTMLElement;
    expect(head.querySelector(".ac-msg__author")?.textContent).toContain("Ada");
    expect(head.querySelector(".ac-msg__time")?.textContent).toContain(":");
  });
});

describe("a reply being written in Bolhas", () => {
  test("no bubble while it works: the bar says it writes, and how long it has been at it", async () => {
    const state = seedState();
    const channelId = seedDm(state, { type: "agent", id: ADA_ID }, { body: "x" });
    const r = await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(withChatPrefs(state)) });
    await settle(10);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const run = { threadId: null, runId: "r-live", agentId: ADA_ID, channelId };
    const push = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId, event: { ...run, ...event } }));
    await push({ type: "agent.run", status: "running", startedAt: ago(1) });
    await push({ type: "agent.typing" });
    await push({ type: "agent.delta", seq: 1, text: "Escrevendo" });
    await settle(4);
    expect(document.querySelector('article[data-run-id="r-live"]')).toBeNull();
    const bar = document.querySelector('.ac-typing[data-active="true"]') as HTMLElement;
    expect(bar.querySelector(".ac-typing__text")?.textContent).toBe("Ada escrevendo…");
    expect(bar.querySelector(".ac-typing__elapsed")?.textContent).toMatch(/\d s$/);
  });
});

describe("Sua conta › Conversa", () => {
  const openSettings = async (state: FakeState) => {
    await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state) });
    await settle(8);
  };
  const click = async (el: Element) => {
    await act(async () => fireEvent.click(el));
    await settle(4);
  };

  test("channels and DMs each save their own style; Clara and Forte show only with Bolhas", async () => {
    const state = withChatPrefs(seedState());
    await openSettings(state);
    const styles = () => screen().getByRole("radiogroup", { name: "Densidade da conversa" });
    expect(within(styles()).getByRole("radio", { name: "Tudo à esquerda" }).getAttribute("aria-checked")).toBe("true");
    expect(screen().queryByRole("radiogroup", { name: "Minhas mensagens nos canais" })).toBeNull();

    await click(within(styles()).getByRole("radio", { name: "Compacta" }));
    expect(state.calls).toContainEqual({ method: "orgs.setChatPrefs", args: [ORG_ID, { channelStyle: "compact" }] });

    await click(screen().getByRole("radio", { name: "DMs" }));
    expect(within(styles()).getByRole("radio", { name: "Bolhas" }).getAttribute("aria-checked")).toBe("true");
    const tones = screen().getByRole("radiogroup", { name: "Minhas mensagens nas DMs" });
    await click(within(tones).getByRole("radio", { name: "Forte" }));
    expect(state.calls).toContainEqual({ method: "orgs.setChatPrefs", args: [ORG_ID, { dmTone: "strong" }] });
    expect(state.me?.organizations[0]?.chatPrefs).toEqual({ channelStyle: "compact", dmTone: "strong" });
  });

  test("where a conversation opens: the last read message until the person picks", async () => {
    const state = withChatPrefs(seedState());
    await openSettings(state);
    const open = screen().getByRole("radiogroup", { name: "Ao abrir uma conversa, me leve para" });
    const checked = (name: string) => within(open).getByRole("radio", { name }).getAttribute("aria-checked");
    expect(checked("Última mensagem lida")).toBe("true");
    expect(checked("Mensagem mais recente")).toBe("false");
    await click(within(open).getByRole("radio", { name: "Mensagem mais recente" }));
    expect(state.calls).toContainEqual({ method: "orgs.setChatPrefs", args: [ORG_ID, { openAt: "latest" }] });
    expect(state.me?.organizations[0]?.chatPrefs).toEqual({ openAt: "latest" });
    expect(checked("Mensagem mais recente")).toBe("true");
  });

  test("whoever picked the newest message keeps it", async () => {
    await openSettings(withChatPrefs(seedState(), { openAt: "latest" }));
    const open = screen().getByRole("radiogroup", { name: "Ao abrir uma conversa, me leve para" });
    expect(within(open).getByRole("radio", { name: "Mensagem mais recente" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  test("Tamanho do texto: five steps, Padrão until the person picks, and a pick shows at once on the page", async () => {
    const state = withChatPrefs(seedState());
    await openSettings(state);
    const sizes = screen().getByRole("radiogroup", { name: "Tamanho do texto" });
    const names = ["Menor", "Pequeno", "Padrão", "Grande", "Maior"];
    expect(
      within(sizes)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("title")),
    ).toEqual(names);
    for (const name of names) expect(within(sizes).getByRole("radio", { name }).textContent).toContain("A");
    // Each step an A in its own size; only the default says its name on screen.
    const glyphs = [...sizes.querySelectorAll<HTMLElement>(".chat-look__a")];
    expect(glyphs.map((g) => g.dataset.textSize)).toEqual(["xs", "sm", "md", "lg", "xl"]);
    expect(sizes.querySelectorAll(".ac-visually-hidden")).toHaveLength(4);
    expect(within(sizes).getByRole("radio", { name: "Padrão" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.textSize).toBe("md");
    // The preview: two of the conversation's own rows at the step's real size, in the look of the switch's choice.
    const preview = () => document.querySelector<HTMLElement>(".chat-look__mini--real");
    expect(preview()?.dataset.textSize).toBe("md");
    expect(preview()?.querySelectorAll("article.ac-msg")).toHaveLength(2);
    expect(preview()?.querySelector(".channel__messages")?.getAttribute("data-look")).toBe("left");

    await click(within(sizes).getByRole("radio", { name: "Maior" }));
    expect(state.calls).toContainEqual({ method: "orgs.setChatPrefs", args: [ORG_ID, { textSize: "xl" }] });
    expect(within(sizes).getByRole("radio", { name: "Maior" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.textSize).toBe("xl");
    expect(preview()?.dataset.textSize).toBe("xl");
    // The looks' small pictures stay at the default size, so a big step never crowds them.
    const pictures = [...document.querySelectorAll<HTMLElement>(".chat-look__mini:not(.chat-look__mini--real)")];
    expect(pictures).toHaveLength(6);
    expect(new Set(pictures.map((m) => m.dataset.textSize))).toEqual(new Set(["md"]));
    expect(state.me?.organizations[0]?.chatPrefs).toEqual({ textSize: "xl" });
  });

  test("a server from before the choice shows no card", async () => {
    await openSettings(seedState());
    expect(screen().queryByRole("radiogroup", { name: "Densidade da conversa" })).toBeNull();
  });
});

describe("opening at the last read message", () => {
  const openUnread = async (prefs: ChatPrefs) => {
    const messages = [
      said(ENG_ID, "a0", ADA_ID, "Lida.", 60),
      said(ENG_ID, "a1", ADA_ID, "Nova um.", 10),
      said(ENG_ID, "a2", ADA_ID, "Nova dois.", 5),
    ];
    const state = withChatPrefs(seedState({ messages }), prefs);
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) Object.assign(eng, { unreadCount: 2, lastReadAt: ago(30) });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(10);
  };

  test("the Novas line goes before the first unread message", async () => {
    await openUnread({ openAt: "read" });
    const line = document.querySelector(".channel__unread");
    expect(line).not.toBeNull();
    expect(line?.nextElementSibling).toBe(row("a1"));
  });

  test("a page kept from an earlier visit: the line still lands, once the fresh page brings the unread", async () => {
    const state = withChatPrefs(seedState({ messages: [said(ENG_ID, "a0", ADA_ID, "Lida.", 60)] }), {
      openAt: "read",
    });
    const api = createFakeApi(state);
    const { router, services } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const go = (channelId: string) =>
      act(async () => router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId } }));
    await go(GENERAL_ID);
    await settle(10);
    state.messages.push(said(ENG_ID, "a1", ADA_ID, "Nova um.", 10), said(ENG_ID, "a2", ADA_ID, "Nova dois.", 5));
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) Object.assign(eng, { unreadCount: 2, lastReadAt: ago(30) });
    await act(async () => {
      await services.queryClient.invalidateQueries({ queryKey: keys.channels(ORG_ID) });
      await services.queryClient.invalidateQueries({ queryKey: keys.messages(ORG_ID, ENG_ID), refetchType: "none" });
    });
    // The fresh page lands after the conversation is on screen with the old one, as over a network.
    let land = () => {};
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });
    const read = api.chat.messages;
    api.chat.messages = async (...args) => {
      await landed;
      return read(...args);
    };
    await go(ENG_ID);
    await settle(10);
    expect(document.querySelector(".channel__unread")).toBeNull();
    await act(async () => land());
    await settle(10);
    expect(document.querySelector(".channel__unread")?.nextElementSibling).toBe(row("a1"));
  });

  test("by default it opens there too: the line before the first unread message", async () => {
    await openUnread({});
    expect(document.querySelector(".channel__unread")?.nextElementSibling).toBe(row("a1"));
  });

  test("whoever picked the newest message opens at the end, with no line", async () => {
    await openUnread({ openAt: "latest" });
    expect(document.querySelector(".channel__unread")).toBeNull();
  });
});
