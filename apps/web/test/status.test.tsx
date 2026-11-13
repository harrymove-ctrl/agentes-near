import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentStatus, StatusInput } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/* Presence and written status (ADR 0084): the "Definir status" dialog, and where a status shows. */

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const account = () => screen().getByRole("button", { name: /^Conta: / });
const badgeOf = (el: Element | null | undefined) => el?.querySelector(".ac-presence")?.getAttribute("data-presence");
const press = async (el: Element, key: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key });
    fireEvent.keyUp(el, { key });
  });
  await settle(2);
};
/**
 * The account menu (Enter on the row, focus on my face, ↓ to "Definir status") → its menu beside (→) → what I'm up
 * to: "O que você está fazendo?", or my line once I wrote one.
 */
const openDialog = async () => {
  const row = account();
  row.focus();
  await press(row, "Enter");
  await press(document.activeElement as HTMLElement, "ArrowDown");
  await press(document.activeElement as HTMLElement, "ArrowRight");
  const status = screen().getAllByRole("menu")[1] as HTMLElement;
  await click(within(status).getByRole("menuitem"));
  await settle(2);
  return screen().getByRole("dialog", { name: "Definir status" });
};
const field = (d: HTMLElement) =>
  within(d).getByRole("textbox", { name: "O que você está fazendo?" }) as HTMLInputElement;
const setStatusCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "orgs.setStatus").map((c) => c.args as [string, StatusInput]);

describe("Definir status", () => {
  test("a suggestion fills the line, its end and how you appear; Salvar sends them to the account row", async () => {
    const { state } = await go(`c/${ENG_ID}`);
    // Nothing written: the row says how I appear.
    expect(account().querySelector(".sidebar__user-line")?.textContent).toBe("Online");
    expect(badgeOf(account())).toBe("online");
    const dialog = await openDialog();
    expect(dialog.textContent).toContain("Como as pessoas te veem");
    expect(
      within(dialog)
        .getByRole("radio", { name: /^Online/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // The end only once there is a line.
    expect(within(dialog).queryByRole("combobox", { name: "Limpar depois de" })).toBeNull();

    await click(within(dialog).getByRole("button", { name: "Em reunião" }));
    expect(field(dialog).value).toBe("Em reunião");
    expect(within(dialog).getByRole("button", { name: "Em reunião" }).getAttribute("aria-pressed")).toBe("true");
    expect(
      within(dialog)
        .getByRole("radio", { name: /^Ocupado/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(dialog).getByRole("combobox", { name: "Limpar depois de" }).textContent).toContain("1 hora");
    // The preview: how the others will see you.
    const preview = dialog.querySelector(".status-preview");
    expect(preview?.textContent).toContain("📅");
    expect(preview?.textContent).toContain("Em reunião");
    expect(badgeOf(preview)).toBe("busy");

    const before = Date.now();
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    const call = setStatusCalls(state)[0];
    const input = call?.[1];
    expect(call?.[0]).toBe(ORG_ID);
    expect({ availability: input?.availability, text: input?.status?.text, emoji: input?.status?.emoji }).toEqual({
      availability: "busy",
      text: "Em reunião",
      emoji: "📅",
    });
    expect(Math.abs(new Date(input?.status?.until ?? 0).getTime() - (before + 3_600_000))).toBeLessThan(60_000);
    expect(screen().queryByRole("dialog", { name: "Definir status" })).toBeNull();
    expect(screen().getByText("Status salvo")).toBeTruthy();
    expect(account().getAttribute("aria-label")).toBe("Conta: Walter · Em reunião");
    expect(account().querySelector(".sidebar__user-line")?.textContent).toContain("Em reunião");
    expect(badgeOf(account())).toBe("busy");
  });

  test("my words with an emoji from the picker, kept until I change them; reopened, Limpar status clears", async () => {
    const { state } = await go(`c/${ENG_ID}`);
    let dialog = await openDialog();
    await type(field(dialog), "Revisando o PR #12");
    expect(within(dialog).getByRole("combobox", { name: "Limpar depois de" }).textContent).toContain("Não limpar");
    await click(within(dialog).getByRole("button", { name: "Escolher emoji" }));
    await settle(1);
    // The picker floats over the dialog, in its own layer.
    const picker = document.querySelector<HTMLElement>('.ac-emoji-popover[aria-label="Emojis"]') as HTMLElement;
    await click(within(picker).getByRole("button", { name: "party popper", hidden: true }));
    await settle(2);
    expect(within(dialog).getByRole("button", { name: "Escolher emoji" }).textContent).toBe("🎉");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(setStatusCalls(state)).toEqual([
      [ORG_ID, { availability: "auto", status: { text: "Revisando o PR #12", emoji: "🎉", until: null } }],
    ]);
    expect(within(nav()).getByRole("button", { name: /^Conta: Walter · Revisando o PR #12/ })).toBeTruthy();

    // Opened again, it starts from what is saved.
    dialog = await openDialog();
    expect(field(dialog).value).toBe("Revisando o PR #12");
    // ✕ wipes the words (and their emoji), nothing saved yet.
    await click(within(dialog).getByRole("button", { name: "Apagar" }));
    expect(field(dialog).value).toBe("");
    expect(setStatusCalls(state)).toHaveLength(1);
    await click(within(dialog).getByRole("button", { name: "Limpar status" }));
    await settle(4);
    expect(setStatusCalls(state)[1]).toEqual([ORG_ID, { availability: "auto", status: null }]);
    expect(account().querySelector(".sidebar__user-line")?.textContent).toBe("Online");
  });

  test("Aparecer como alone: hidden, the preview says others see you offline; the toast, how you appear", async () => {
    const { state } = await go(`c/${ENG_ID}`);
    const dialog = await openDialog();
    await click(within(dialog).getByRole("radio", { name: /^Oculto/ }));
    expect(dialog.querySelector(".status-preview")?.textContent).toContain("Para os outros você está offline");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(setStatusCalls(state)).toEqual([[ORG_ID, { availability: "hidden", status: null }]]);
    expect(screen().getByText("Você aparece como oculto")).toBeTruthy();
    // To myself: hidden (the dotted outline), and the row says so under my name.
    expect(badgeOf(account())).toBe("hidden");
    expect(account().querySelector(".sidebar__user-line")?.textContent).toBe("Oculto");
  });

  test("a line whose end has passed reads as none", async () => {
    const state = seedState();
    const past = new Date(Date.now() - 60_000).toISOString();
    state.statuses = new Map([
      ["u-walter", { availability: "auto", status: { text: "Almoçando", emoji: "🍽️", until: past } }],
    ]);
    await go(`c/${ENG_ID}`, state);
    // Its time is up: how I appear instead.
    expect(account().querySelector(".sidebar__user-line")?.textContent).toBe("Online");
  });
});

describe("where a status shows", () => {
  test("a hidden person reads offline to everyone else: the badge, the row, the card", async () => {
    const state = seedState();
    state.online.add("u-joao");
    state.statuses = new Map([["u-joao", { availability: "hidden", status: null }]]);
    seedDm(state, { type: "person", id: "u-joao" });
    await go(`c/${ENG_ID}`, state);
    const joao = within(nav()).getByRole("link", { name: /^João/ });
    expect(joao.getAttribute("data-presence")).toBe("offline");
    expect(badgeOf(joao)).toBe("offline");
    await click(screen().getAllByRole("button", { name: "Perfil de João" })[0] as HTMLElement);
    await settle(4);
    const card = screen().getByRole("dialog", { name: "Perfil" });
    expect(card.textContent).toContain("Offline");
    expect(card.textContent).not.toContain("Oculto");
  });

  test("a person's line: by their name in messages (words on hover), in the members list, on their card", async () => {
    const state = seedState();
    state.online.add("u-joao");
    state.statuses = new Map([
      ["u-joao", { availability: "busy", status: { text: "Focado no relatório", emoji: "🎧", until: null } }],
    ]);
    seedDm(state, { type: "person", id: "u-joao" });
    await go(`c/${ENG_ID}`, state);
    const message = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("login está devolvendo 401")) as HTMLElement;
    const emoji = within(message).getByRole("img", { name: "Focado no relatório" });
    expect([emoji.textContent, emoji.getAttribute("title")]).toEqual(["🎧", "Focado no relatório"]);
    expect(badgeOf(message.querySelector(".ac-msg__avatar"))).toBe("busy");
    // The sidebar's DM row: the emoji after the name, the words in its title.
    const joao = within(nav()).getByRole("link", { name: /^João/ });
    expect(joao.getAttribute("title")).toBe("João · Ocupado · Focado no relatório");
    // The members column: the line under the name.
    const side = screen().getByRole("complementary", { name: "Membros de #eng" });
    expect(within(side).getByRole("button", { name: "Perfil de João" }).textContent).toContain("🎧Focado no relatório");
    cleanup();

    await go(`c/${ENG_ID}`, state);
    await click(screen().getAllByRole("button", { name: "Perfil de João" })[0] as HTMLElement);
    await settle(4);
    const card = screen().getByRole("dialog", { name: "Perfil" });
    // No end: "Até você mudar" would talk to the reader about a choice only João has.
    expect(card.querySelector(".profile-card__status")?.textContent).toBe("🎧Focado no relatório");
    expect(card.textContent).toContain("Presença");
    expect(card.textContent).toContain("Ocupado");
  });

  test("on a card, a status with an end says when it clears to anyone; with none, only its owner reads Até você mudar", async () => {
    const at = new Date();
    at.setHours(23, 59, 0, 0);
    const state = seedState();
    state.statuses = new Map([
      ["u-joao", { availability: "auto", status: { text: "Almoço", emoji: "🍽️", until: at.toISOString() } }],
      ["u-walter", { availability: "auto", status: { text: "Focado", emoji: "🎧", until: null } }],
    ]);
    await go(`c/${ENG_ID}`, state);
    const line = async (name: string) => {
      await click(screen().getAllByRole("button", { name })[0] as HTMLElement);
      await settle(4);
      const text = screen().getByRole("dialog", { name: "Perfil" }).querySelector(".profile-card__status")?.textContent;
      await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" }));
      await settle(2);
      return text;
    };
    expect(await line("Perfil de João")).toMatch(/^🍽️AlmoçoSome às /);
    expect(await line("Perfil de Walter")).toBe("🎧FocadoAté você mudar");
  });

  test("an agent's line: the server's in words, its own as written; who wrote it; why it reads so", async () => {
    const now = new Date().toISOString();
    const statuses: AgentStatus[] = [
      {
        agentId: ADA_ID,
        presence: "busy",
        status: { by: "auto", text: null, kind: "channel", subject: "eng", emoji: null, until: null },
        activeAt: now,
      },
      {
        agentId: ATLAS_ID,
        presence: "online",
        status: {
          by: "self",
          text: "Deploy da v2 em staging",
          kind: null,
          subject: null,
          emoji: "🛠️",
          until: null,
        },
        activeAt: now,
      },
    ];
    const state = seedState({ agentStatuses: statuses });
    seedDm(state, { type: "agent", id: ADA_ID });
    seedDm(state, { type: "agent", id: ATLAS_ID });
    await go(`c/${ENG_ID}`, state);
    // The sidebar: the badge, and the line in the row's title (no emoji in the list).
    const ada = within(nav()).getByRole("link", { name: /^Ada/ });
    expect(ada.getAttribute("title")).toContain("Respondendo no #eng");
    expect(ada.textContent).not.toContain("💬");
    expect(badgeOf(ada)).toBe("busy");
    const atlas = within(nav()).getByRole("link", { name: /^Atlas/ });
    expect(atlas.getAttribute("title")).toContain("Deploy da v2 em staging");
    expect(badgeOf(atlas)).toBe("online");

    await click(screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
    await settle(6);
    const card = screen().getByRole("dialog", { name: "Perfil" });
    expect(card.querySelector(".profile-card__status")?.textContent).toBe(
      "💬Respondendo no #engO que está fazendo agora",
    );
    expect(card.textContent).toContain("Ocupado · Num trabalho pesado");
    expect(badgeOf(card)).toBe("busy");
    cleanup();

    // In the members column: its own words, as written.
    await go(`c/${ENG_ID}`, seedState({ agentStatuses: statuses }));
    const side = screen().getByRole("complementary", { name: "Membros de #eng" });
    expect(within(side).getByRole("region", { name: "Agentes" }).textContent).toContain("🛠️Deploy da v2 em staging");
  });

  test("an agent with no AI is drawn offline, and its card says why", async () => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [
          { agentId: ADA_ID, state: "no_ai", reason: "no_key" },
          { agentId: ATLAS_ID, state: "ready" },
        ],
      },
    });
    seedDm(state, { type: "agent", id: ADA_ID });
    await go(`c/${ENG_ID}`, state);
    const ada = within(nav()).getByRole("link", { name: /^Ada/ });
    expect(ada.getAttribute("data-presence")).toBe("offline");
    expect(badgeOf(ada)).toBe("offline");
    await click(screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Perfil" }).textContent).toContain("Offline · Sem IA conectada");
  });

  test("an agent at work reads online, whatever its AI reads for this person: the list says so, or its run first", async () => {
    // No AI here (the right hand thinks with each person's own), yet it answers someone.
    const aiStatus = {
      any: true,
      agents: [
        { agentId: ADA_ID, state: "no_ai" as const, reason: "no_key" as const },
        { agentId: ATLAS_ID, state: "ready" as const },
      ],
    };
    const row = (presence: AgentStatus["presence"], working: boolean): AgentStatus[] => [
      { agentId: ADA_ID, presence, status: null, activeAt: working ? new Date().toISOString() : null, working },
    ];
    const working = seedState({ aiStatus, agentStatuses: row("online", true) });
    seedDm(working, { type: "agent", id: ADA_ID });
    await go(`c/${ENG_ID}`, working);
    const ada = () => within(nav()).getByRole("link", { name: /^Ada/ });
    expect(ada().getAttribute("data-presence")).toBe("online");
    expect(badgeOf(ada())).toBe("online");
    cleanup();

    // The list still reads it idle: its run, as this tab hears it, is enough.
    const idle = seedState({ aiStatus, agentStatuses: row("away", false) });
    seedDm(idle, { type: "agent", id: ADA_ID });
    const r = await go(`c/${ENG_ID}`, idle);
    expect(badgeOf(ada())).toBe("offline");
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "agent.thinking", channelId: ENG_ID, threadId: null, runId: "r-now", agentId: ADA_ID },
      }),
    );
    await settle();
    expect(ada().getAttribute("data-presence")).toBe("online");
    expect(badgeOf(ada())).toBe("online");
  });
});
