import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { join } from "node:path";
import type { Approval, Message } from "@agenteschat/client";
import { markedPieces, markFaced, markInk } from "@agenteschat/client/lib/activity";
import { mentionsHandle } from "@agenteschat/client/lib/markdown";
import { apiProviderOf } from "@agenteschat/client/lib/providers";
import { splitAtNames, wordIndex } from "@agenteschat/client/lib/text";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { ActorWho, withAgentFace, withAgentFaces } from "@/components/AgentAvatar";
import { InlineApproval } from "@/components/ApprovalItem";
import { SidebarHorizon } from "@/components/Sky";
import { boldNames } from "@/components/WorkingLine";
import { atRule, declarations, topLevel } from "./built-css";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const ROOT = join(import.meta.dir, "../../..");
const sheet = async (...paths: string[]) =>
  topLevel((await Promise.all(paths.map((p) => Bun.file(join(ROOT, p)).text()))).join("\n"));
const value = (css: string, selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];

const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

describe("a message that mentions me", () => {
  test("its row is tinted and my chip stands out; a mention of someone else stays plain", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-me",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "@walter pode revisar o PR? @ada já olhou",
      mentionedAgentIds: [ADA_ID],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(row("m-me").classList.contains("ac-msg--mentions-me")).toBe(true);
    const chips = [...row("m-me").querySelectorAll(".ac-mention")].map((c) => [c.textContent, c.className]);
    expect(chips).toEqual([
      ["@Walter", "ac-mention ac-mention--me"],
      ["@Ada", "ac-mention ac-mention--agent"],
    ]);
    // Ada's chip carries her tone for both themes; a person's has none.
    const [walter, ada] = [...row("m-me").querySelectorAll<HTMLElement>(".ac-mention")];
    expect(walter?.style.getPropertyValue("--mention-bg")).toBe("");
    expect(ada?.style.getPropertyValue("--mention-bg")).toMatch(/^#[0-9a-f]{6}$/);
    expect(ada?.style.getPropertyValue("--mention-ink-dark")).toMatch(/^#[0-9a-f]{6}$/);
    // m-1 mentions only Ada.
    expect(row("m-1").classList.contains("ac-msg--mentions-me")).toBe(false);
  });

  test("the handle matches as the backend reads it: any case, never inside an email", () => {
    expect(mentionsHandle("oi @Walter, tudo bem?", "walter")).toBe(true);
    expect(mentionsHandle("mande para walter@acme.com", "walter")).toBe(false);
    expect(mentionsHandle("@walterx", "walter")).toBe(false);
  });

  test("the row's tint (no bar on its edge) and the chip's shape", async () => {
    const css = await sheet("packages/ui/src/styles/components.css", "apps/web/src/layout.css");
    const me = ".channel__messages .ac-msg--mentions-me";
    expect(value(css, me, "box-shadow")).toBeUndefined();
    expect(value(css, me, "background")).toContain("var(--attention) 9%");
    expect(value(css, ".ac-mention", "padding")).toBe("0 4px");
    expect(value(css, ".ac-mention", "border-radius")).toBe("var(--radius-sm)");
    expect(value(css, ".ac-mention--me", "color")).toBe("var(--attention)");
    expect(value(css, ".ac-mention--agent", "background")).toBe("var(--mention-bg)");
    expect(value(css, '[data-theme="dark"] .ac-mention--agent', "color")).toBe("var(--mention-ink-dark)");
  });

  test("only a mention of me tints a row: my own, one row like anyone's, gets no plate even under the pointer", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-mine",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-walter" },
      body: "@joao consegue olhar?",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const mine = row("m-mine");
    expect(mine.classList.contains("ac-msg--mentions-me")).toBe(false);
    expect(mine.dataset.own).toBe("true");
    const css = await sheet("packages/ui/src/styles/components.css", "apps/web/src/layout.css");
    expect(value(css, ".ac-msg[data-own]:hover", "background")).toBe("none");
    expect(value(css, '.ac-msg[data-own][data-menu-open="true"]', "background")).toBe("none");
    // In bubbles the bubble carries it, past the plain bubble's own color (as specific, and later in the file).
    const looks = await sheet("apps/web/src/chat/looks.css");
    expect(value(looks, '.ac-msg[data-look="bubbles"]:not(.ac-msg--own) .ac-msg__text', "background")).toBe(
      "var(--msg-bubble)",
    );
    expect(
      value(looks, '.ac-msg--mentions-me[data-look="bubbles"]:not(.ac-msg--own) .ac-msg__text', "background"),
    ).toContain("--attention");
    // The just-landed plate is gone; a linked message still fades.
    const layout = await Bun.file(join(ROOT, "apps/web/src/layout.css")).text();
    expect(layout).not.toContain("ac-msg--fresh");
    expect(layout).toContain("msg-focus 2.4s");
  });
});

describe("Fixar mensagem", () => {
  test("from the right click it pins through the pins API and says so; a pinned one offers Desafixar", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const pins: [string, string, string][] = [];
    api.pins = {
      list: async () => [],
      pin: async (_orgId, channelId, messageId) => {
        pins.push(["pin", channelId, messageId]);
        const m = state.messages.find((x) => x.id === messageId);
        if (m) m.pinned = true;
        return { messageId, channelId, pinnedBy: "u-walter", pinnedAt: new Date().toISOString() } as never;
      },
      unpin: async (_orgId, channelId, messageId) => {
        pins.push(["unpin", channelId, messageId]);
      },
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    await act(async () => fireEvent.contextMenu(row("m-1"), { clientX: 40, clientY: 60 }));
    await settle(2);
    await act(async () =>
      fireEvent.click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Fixar mensagem" })),
    );
    await settle(6);
    expect(pins).toEqual([["pin", ENG_ID, "m-1"]]);
    expect(document.body.textContent).toContain("Mensagem fixada.");
    await act(async () => fireEvent.contextMenu(row("m-1"), { clientX: 40, clientY: 60 }));
    await settle(2);
    await act(async () =>
      fireEvent.click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Desafixar mensagem" })),
    );
    await settle(4);
    expect(pins.at(-1)).toEqual(["unpin", ENG_ID, "m-1"]);
  });

  const menuNames = () =>
    within(screen().getByRole("menu"))
      .getAllByRole("menuitem")
      .map((i) => i.getAttribute("aria-label") ?? i.textContent);

  test("someone else's pin, live: the menu offers Desafixar, and Fixar again once it's unpinned", async () => {
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(6);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const push = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    await push({
      type: "message.pinned",
      messageId: "m-1",
      threadId: null,
      pinnedByUserId: "u-joao",
      pinnedAt: new Date().toISOString(),
    });
    await settle(2);
    await act(async () => fireEvent.contextMenu(row("m-1"), { clientX: 40, clientY: 60 }));
    await settle(2);
    expect(menuNames()).toContain("Desafixar mensagem");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await push({ type: "message.unpinned", messageId: "m-1" });
    await settle(2);
    await act(async () => fireEvent.contextMenu(row("m-1"), { clientX: 40, clientY: 60 }));
    await settle(2);
    expect(menuNames()).toContain("Fixar mensagem");
  });

  test("someone who can't post there gets no Fixar (the server would refuse it)", async () => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.permissions = ["read"];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await act(async () => fireEvent.contextMenu(row("m-1"), { clientX: 40, clientY: 60 }));
    await settle(2);
    const names = menuNames();
    expect(names).toContain("Copiar link da mensagem");
    expect(names).not.toContain("Fixar mensagem");
  });
});

describe("right click in the browser", () => {
  const withLink = () => {
    const state = seedState();
    state.messages.push({
      id: "m-link",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "o doc está em https://example.com/doc e o trecho é `npm run build`",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    return state;
  };
  const rightClick = async (target: Element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    await act(async () => void target.dispatchEvent(event));
    await settle(2);
    return event;
  };

  test("a link or code in a message keeps the browser's menu; the message's own space gets ours", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(withLink()) });
    await settle(8);
    const link = row("m-link").querySelector('a[href^="https://example.com"]') as HTMLElement;
    expect((await rightClick(link)).defaultPrevented).toBe(false);
    expect(screen().queryByRole("menu")).toBeNull();
    const code = row("m-link").querySelector("code") as HTMLElement;
    expect((await rightClick(code)).defaultPrevented).toBe(false);
    expect(screen().queryByRole("menu")).toBeNull();
    expect((await rightClick(row("m-link"))).defaultPrevented).toBe(true);
    expect(screen().getByRole("menu")).toBeTruthy();
  });

  test("on touch, a long press keeps selecting text: no menu", async () => {
    const real = window.matchMedia.bind(window);
    const media = spyOn(window, "matchMedia").mockImplementation((query: string) =>
      query === "(pointer: coarse)"
        ? ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} } as unknown as MediaQueryList)
        : real(query),
    );
    try {
      await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
      await settle(8);
      expect((await rightClick(row("m-1"))).defaultPrevented).toBe(false);
      expect(screen().queryByRole("menu")).toBeNull();
    } finally {
      media.mockRestore();
    }
  });
});

describe("official provider logos", () => {
  const models = [
    { id: "claude-sonnet-5-5", label: "Sonnet", provider: "anthropic", available: true },
    { id: "gpt-5", label: "GPT-5", provider: "openai", available: false },
  ].map((m) => ({ ...m, inputUsdPerMTok: 1, outputUsdPerMTok: 1 }));

  test("whose API a model runs on; Automático, the one provider the workspace can use", () => {
    expect(apiProviderOf("gpt-5", models)).toBe("openai");
    expect(apiProviderOf("auto", models)).toBe("anthropic");
    expect(
      apiProviderOf(
        "auto",
        models.map((m) => ({ ...m, available: true })),
      ),
    ).toBeUndefined();
    expect(apiProviderOf("unknown", models)).toBeUndefined();
  });

  test("the DM header shows the API model's maker, not a generic brain", async () => {
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const brain = document.querySelector(".channel__brain") as HTMLElement;
    expect(brain.querySelector(".ac-brand")).toBeTruthy();
    expect(brain.textContent).toContain("Claude Sonnet 5.5");
  });

  test("the agent page's Pensa com shows the API model's maker", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(10);
    const cells = [...document.querySelectorAll(".agp-cell")] as HTMLElement[];
    const brain = cells.find((c) => c.textContent?.includes("Claude Sonnet 5.5"));
    expect(brain?.querySelector(".agp-cell__key .ac-brand")).toBeTruthy();
  });
});

describe("agent faces in a line of text", () => {
  test(".ac-who: a face at the text's size (or `--who-face`), centred on the capitals", async () => {
    const css = await sheet("packages/ui/src/styles/components.css");
    const face = ".ac-who > .ac-avatar";
    expect(value(css, face, "font-size")).toBe("inherit");
    expect(value(css, face, "width")).toBe("var(--who-face, 1.15em)");
    expect(value(css, face, "height")).toBe("var(--who-face, 1.15em)");
    // Its middle on the capitals' middle, whatever its size.
    expect(value(css, face, "vertical-align")).toBe(
      "calc(var(--cap-top) - var(--cap-mid) - var(--who-face, 1.15em) / 2)",
    );
    expect(value(css, ".ac-who", "white-space")).toBe("nowrap");
    // A long name wraps between its words, its first word staying with the face.
    expect(value(css, ".ac-who > b", "white-space")).toBe("normal");
  });

  test(".ac-who: a person's letters out of the flow, so the face's bottom is its baseline as an agent's canvas is", async () => {
    const css = await sheet("packages/ui/src/styles/components.css");
    expect(value(css, ".ac-who > .ac-avatar > :is(img, .ac-avatar__initials)", "position")).toBe("absolute");
    const letters = ".ac-who > .ac-avatar > .ac-avatar__initials";
    // Centred in the tile, still trimmed to their capitals by the tile's own rule.
    expect(value(css, letters, "margin")).toBe("auto");
    expect(value(css, letters, "height")).toBe("fit-content");
    expect(value(css, ".ac-avatar__initials", "text-box")).toBe("trim-both cap alphabetic");
    await renderPage(
      <p>
        <ActorWho actor={{ type: "person", id: "u-joao" }} name="João" /> e{" "}
        <ActorWho actor={{ type: "agent", id: ADA_ID }} name="Ada" />
      </p>,
      { api: createFakeApi(seedState()), org: true },
    );
    await settle(2);
    const [person, agent] = [...document.querySelectorAll<HTMLElement>("p .ac-who")];
    expect(person?.querySelector(".ac-avatar[data-kind='person'] .ac-avatar__initials")?.textContent).toBe("J");
    expect(person?.querySelector("b")?.textContent).toBe("João");
    expect(person?.hasAttribute("data-lead")).toBe(true);
    expect(agent?.querySelector(".ac-avatar--agent canvas")).not.toBeNull();
    expect(agent?.hasAttribute("data-lead")).toBe(false);
  });

  test(".ac-who: the face sits a word's space apart on both sides, none before it where it opens the line", async () => {
    const css = await sheet("packages/ui/src/styles/components.css");
    expect(value(css, ".ac-who > .ac-avatar", "margin-inline")).toBe("0.2em 0.4em");
    expect(value(css, ".ac-who[data-lead] > .ac-avatar", "margin-inline-start")).toBe("0");
    await renderPage(
      <>
        <p>{withAgentFace("Você no controle · o Theo espera", "Theo")}</p>
        <p>{withAgentFace("Theo espera", "Theo")}</p>
      </>,
      { api: createFakeApi(seedState()), org: true },
    );
    await settle(2);
    const [mid, lead] = [...document.querySelectorAll("p .ac-who")];
    expect(mid?.hasAttribute("data-lead")).toBe(false);
    expect(lead?.hasAttribute("data-lead")).toBe(true);
  });

  test("an approval's 'Ada pede aprovação' carries Ada's face before her name", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const approval = state.approvals.find((a) => a.id === "ap-merge") as Approval;
    const agent = (await api.agents.list(ORG_ID)).find((a) => a.id === ADA_ID);
    await renderPage(<InlineApproval approval={approval} agent={agent} members={new Map()} />, { api, org: true });
    await settle(4);
    const who = document.querySelector(".ac-who") as HTMLElement;
    expect(who.querySelector(".ac-avatar--xs")).toBeTruthy();
    expect(who.querySelector("b")?.textContent).toBe("Ada");
    expect(document.body.textContent).toContain("Ada pede aprovação");
  });

  test("the face goes before the name as a word, never inside another word", async () => {
    expect(wordIndex("Maximizando a janela · Max está abrindo", "Max")).toBe(23);
    expect(wordIndex("Anadia", "Ana")).toBe(-1);
    expect(wordIndex("Ana: pronto", "Ana")).toBe(0);
    await renderPage(<p>{withAgentFace("Maximizando a janela · Max está abrindo", "Max")}</p>, {
      api: createFakeApi(seedState()),
      org: true,
    });
    await settle(2);
    const line = document.querySelector("p") as HTMLElement;
    expect(line.firstChild?.textContent).toBe("Maximizando a janela · ");
    expect(line.querySelector(".ac-who b")?.textContent).toBe("Max");
  });
});

describe("the agent page's cards and the chat's", () => {
  test("agent cards: 12px above and below, the head pulled into the padding", async () => {
    const css = await sheet("apps/web/src/layout.css");
    expect(value(css, ".agp-card.ac-card", "--agp-card-py")).toBe("12px");
    expect(value(css, ".agp-card.ac-card", "padding-block")).toBe("var(--agp-card-py)");
    // Only a head with a button (32px) reaches into the padding; a title alone (22px) stays 12px in.
    expect(declarations(css, ".agp-card>.ac-card__head:first-child")).toEqual([]);
    expect(value(css, ".agp-card>.ac-card__head:first-child:has(.ac-card__action .ac-btn)", "margin-block")).toBe(
      "calc(var(--action-clear) - var(--agp-card-py)) -2px",
    );
    // The foot reaches the card's bottom edge (12px), not past it (--card-pad is 16px).
    expect(value(css, ".agp-card>.ac-card__foot", "margin-bottom")).toBe("-12px");
  });

  test("the cards beside them use the same 12px", async () => {
    const css = await sheet(
      "apps/web/src/pages/approvals.css",
      "apps/web/src/pages/wiki.css",
      "apps/web/src/pages/drive.css",
      "apps/web/src/components/computer/computer.css",
    );
    expect(value(css, ".ap-waiters", "padding")).toBe("12px 16px");
    expect(value(css, ".wiki-import-card", "padding")).toBe("12px");
    expect(value(css, ".drive-note", "padding")).toBe("12px 14px");
    expect(value(css, ".cmp-entry__row", "padding")).toBe("12px 14px");
  });

  test("the computer card's words centred on its icon; the take-control head's icon on its two lines", async () => {
    const css = await sheet("apps/web/src/components/computer/computer.css");
    expect(value(css, ".cmp-entry__row", "align-items")).toBe("center");
    expect(declarations(css, ".cmp-entry__row>.ac-computer")).toEqual([]);
    const lead = ".cmp-dialog .ac-dialog__lead:has(+ .ac-actline > .ac-dialog__titles)";
    expect(value(css, lead, "align-self")).toBe("center");
    expect(value(css, lead, "translate")).toBe("none");
  });

  test("the working bar's faces open the pill as far in as the globe at its end", async () => {
    const css = await sheet("apps/web/src/layout.css");
    expect(
      value(
        css,
        '.ac-typing[data-active="true"]:has(> .ac-typing__avatars):not(:has(> .ac-typing__dots, > .ac-pixspin))',
        "padding-left",
      ),
    ).toBe("7px");
  });
});

describe("the pinned bar under the channel header", () => {
  const pinOf = (messageId: string, pinnedAt: string) => {
    const message = seedState().messages.find((m) => m.id === messageId) as Message;
    return { messageId, channelId: ENG_ID, threadId: null, pinnedByUserId: "u-joao", pinnedAt, message };
  };
  const button = () => screen().getByRole("button", { name: /^Mensagens fixadas \(/ });

  test("the latest pin and the count, the list (face, words, time), a row goes to the message, Desafixar unpins; live", async () => {
    const api = createFakeApi(seedState());
    let pinned = [pinOf("m-2", "2026-11-01T10:05:00.000Z"), pinOf("m-1", "2026-11-01T10:00:00.000Z")];
    const unpinned: string[] = [];
    api.pins = {
      list: async () => pinned,
      pin: async () => ({}) as never,
      unpin: async (_orgId, _channelId, messageId) => {
        unpinned.push(messageId);
        pinned = pinned.filter((p) => p.messageId !== messageId);
      },
    };
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    expect(button().getAttribute("aria-label")).toBe("Mensagens fixadas (2)");
    expect(button().classList.contains("pinbar")).toBe(true);
    expect(button().querySelector(".pinbar__text b")?.textContent).toBe("Ada");
    expect(button().querySelector(".pinbar__text")?.textContent).toContain("Achei a causa");
    expect(button().querySelector(".ac-countchip")?.textContent).toBe("2");
    await act(async () => fireEvent.click(button()));
    await settle(2);
    const list = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
    const rows = [...list.querySelectorAll(".pins-pop__item")] as HTMLElement[];
    expect(rows.map((row) => row.querySelector(".thread-pop__name b")?.textContent)).toEqual(["Ada", "João"]);
    // A MediaRow: the face at 32px (no size class), the name and its time on one line, what it says under them; the ×
    // inside the row's card.
    expect(rows[0]?.querySelector(".thread-pop__row")?.classList.contains("ac-mediarow")).toBe(true);
    expect(rows[0]?.querySelector(".ac-avatar")?.className).not.toMatch(/ac-avatar--(xs|sm)/);
    expect(rows[0]?.querySelector("button[aria-label='Desafixar a mensagem de Ada']")?.parentElement).toBe(rows[0]);
    const css = await Bun.file(new URL("../src/components/threads/threads.css", import.meta.url).pathname).text();
    expect(css.split("\n.pins-pop__item:hover,")[1]?.split("}")[0]).toContain("background: var(--plate);");
    expect(rows[0]?.querySelector(".ac-mediarow__body.thread-pop__sub")?.textContent).toContain("Achei a causa");
    expect(rows[0]?.querySelector(".pins-pop__time")?.textContent).toBeTruthy();

    await act(async () => fireEvent.click(rows[1]?.querySelector(".thread-pop__row") as HTMLElement));
    await settle(2);
    expect(row("m-1").classList.contains("ac-msg--focus")).toBe(true);

    await act(async () => fireEvent.click(button()));
    await settle(2);
    const again = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Desafixar a mensagem de Ada" })));
    await settle(4);
    expect(unpinned).toEqual(["m-2"]);
    expect(button().getAttribute("aria-label")).toBe("Mensagens fixadas (1)");
    expect(button().querySelector(".pinbar__text b")?.textContent).toBe("João");
    expect(button().querySelector(".ac-countchip")).toBeNull();

    // Someone else pins one: the count follows the event.
    pinned = [pinOf("m-2", "2026-11-01T10:10:00.000Z"), ...pinned];
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "message.pinned",
          channelId: ENG_ID,
          messageId: "m-2",
          threadId: null,
          pinnedByUserId: "u-joao",
          pinnedAt: "2026-11-01T10:10:00.000Z",
        },
      }),
    );
    await settle(4);
    expect(button().getAttribute("aria-label")).toBe("Mensagens fixadas (2)");
  });

  test("nothing pinned: no bar", async () => {
    const api = createFakeApi(seedState());
    api.pins = { list: async () => [], pin: async () => ({}) as never, unpin: async () => {} };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    expect(screen().queryByRole("button", { name: /^Mensagens fixadas \(/ })).toBeNull();
    expect(document.querySelector(".pinbar")).toBeNull();
  });
});

describe("agent faces in more lines", () => {
  test("each name gets its face where it stands as a word, in order, whatever order they come in", () => {
    expect(splitAtNames("Atlas respondeu à pergunta da Ada", ["Ada", "Atlas"])).toEqual([
      1,
      " respondeu à pergunta da ",
      0,
    ]);
    expect(splitAtNames("Ninguém aqui", ["Ada"])).toEqual(["Ninguém aqui"]);
    // The same name twice: one face.
    expect(splitAtNames("Ada e Ada", ["Ada", "Ada"])).toEqual([0, " e Ada"]);
  });

  test("an answer line far from its question: a face before each agent", async () => {
    await renderPage(
      <p>
        {withAgentFaces("Atlas respondeu à pergunta da Ada", [
          { name: "Atlas", agentId: "a-atlas" },
          { name: "Ada", agentId: ADA_ID },
        ])}
      </p>,
      { api: createFakeApi(seedState()), org: true },
    );
    await settle(2);
    const names = [...document.querySelectorAll("p .ac-who")].map((w) => w.querySelector("b")?.textContent);
    expect(names).toEqual(["Atlas", "Ada"]);
    expect(document.querySelector("p")?.textContent).toBe("Atlas respondeu à pergunta da Ada");
  });

  test("a faced name draws the agent's face before it; other names stay in ink", async () => {
    const said = `${markFaced("Ada", ADA_ID)}: Achei a área`;
    expect(markedPieces(said)[0]).toEqual({ text: "Ada", bold: true, agentId: ADA_ID });
    expect(markedPieces(`${markInk("Theo")} e ${markInk("Iris")}`)).toEqual([
      { text: "Theo", bold: true },
      { text: " e ", bold: false },
      { text: "Iris", bold: true },
    ]);
    await renderPage(<p>{boldNames(said)}</p>, { api: createFakeApi(seedState()), org: true });
    await settle(2);
    expect(document.querySelector("p .ac-who b")?.textContent).toBe("Ada");
  });

  test("a toast that names an agent draws its face; a plain one stays plain", async () => {
    const r = await renderPage(<p />, { api: createFakeApi(seedState()) });
    await act(async () => {
      r.services.toasts.show({ text: "Devolvido à Ada.", who: { name: "Ada" } });
      r.services.toasts.show("Salvo");
    });
    const toasts = [...document.querySelectorAll(".ac-toast")] as HTMLElement[];
    expect(toasts.map((x) => x.textContent)).toEqual(["Devolvido à Ada.", "Salvo"]);
    expect(toasts[0]?.querySelector(".ac-who .ac-avatar--xs")).toBeTruthy();
    expect(toasts[0]?.querySelector(".ac-who b")?.textContent).toBe("Ada");
    expect(toasts[1]?.querySelector(".ac-who")).toBeNull();
  });
});

describe("the sidebar's sky", () => {
  test("no pixel agents drift behind the account row, however many agents work", async () => {
    type Drawn = ReactElement<{ children: ReactElement<{ options: { sprites?: number } }> }>;
    const seen: { drawn?: Drawn } = {};
    function Probe() {
      seen.drawn = SidebarHorizon({ working: 3, total: 3 }) as Drawn;
      return seen.drawn;
    }
    await renderPage(<Probe />, { api: createFakeApi(seedState()) });
    expect(seen.drawn?.props.children.props.options.sprites).toBe(0);
  });
});

describe("ghost buttons on a dark or agent-colored surface", () => {
  test("their own white ink, a light plate on hover and press, never the page's ink", async () => {
    const css = await sheet("packages/ui/src/styles/tokens.css", "packages/ui/src/styles/components.css");
    expect(value(css, ".ac-on-dark .ac-btn--ghost", "color")).toBe("var(--on-dark-soft)");
    expect(value(css, ".ac-on-dark .ac-btn--ghost:hover", "color")).toBe("var(--on-dark)");
    expect(value(css, ".ac-on-dark .ac-btn--ghost:hover", "background")).toBe("var(--on-dark-plate)");
    expect(value(css, '.ac-on-dark .ac-btn--ghost[aria-pressed="true"]', "color")).toBe("var(--on-dark)");
    expect(value(css, ".ac-on-dark .ac-btn--ghost:active:not(:disabled)", "background")).toBe(
      "var(--on-dark-plate-strong)",
    );
    expect(value(css, ".ac-on-dark .ac-btn--ghost:disabled", "color")).toBe("var(--on-dark-faint)");
    expect(value(css, ".ac-on-dark .ac-btn--ghost.ac-btn--glyph:hover::before", "background")).toBe(
      "var(--on-dark-plate)",
    );
    // The same in both themes: defined once, outside the light and dark blocks.
    expect(value(css, "[data-theme]", "--on-dark")).toBe("#fff");
    expect(value(css, "[data-theme]", "--on-dark-plate")).toBe("rgba(255, 255, 255, 0.16)");
  });

  test("the browser frame's top is such a surface; its toolbar over the page opens on the page alone", async () => {
    const css = await sheet("apps/web/src/components/browser/browser.css");
    expect(declarations(css, ".brw-mf:hover .brw-mf__over")).toEqual([]);
    expect(value(css, ".brw-mf .brw-ac__stage:hover .brw-mf__over", "opacity")).toBe("1");
    expect(value(css, ".brw-mf__now:hover .brw-mf__hist", "opacity")).toBe("1");
    expect(value(css, ".brw-stopask", "padding-left")).toBe("var(--space-3)");
  });

  test("an agent's face and name in the frame's live line keep the line's white, not the page's ink or a silhouette", async () => {
    const ui = await sheet("packages/ui/src/styles/components.css");
    expect(value(ui, ".ac-on-dark .ac-who > b", "color")).toBe("inherit");
    const css = await sheet("apps/web/src/components/browser/browser.css");
    // Only the pixel spinner is whitened: the face's own canvas keeps its colors.
    expect(declarations(css, ".brw-mf__top canvas")).toEqual([]);
    expect(value(css, ".brw-mf__top .ac-pixspin", "filter")).toBe("brightness(0) invert(1)");
    expect(value(css, ".brw-mf__hist .ac-pixspin", "filter")).toBe("none");
  });

  test("the steps list and the toolbar never open together: held open, the toolbar wins; on touch, a tapped chip wins", async () => {
    const css = await sheet("apps/web/src/components/browser/browser.css");
    const held = ".brw-mf:has(.brw-mf__over.is-pinned, .brw-mf__over:focus-within) .brw-mf__hist";
    expect(value(css, held, "visibility")).toBe("hidden");
    expect(value(css, held, "opacity")).toBe("0");
    const raw = await Bun.file(join(ROOT, "apps/web/src/components/browser/browser.css")).text();
    const touch = atRule(raw, "@media (hover: none)");
    const tapped = ".brw-mf:has(.brw-mf__now:hover > .brw-mf__hist) .brw-mf__over:not(.is-pinned)";
    expect(value(touch, tapped, "visibility")).toBe("hidden");
    expect(value(touch, tapped, "opacity")).toBe("0");
  });
});
