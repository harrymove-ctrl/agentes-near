import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { HOVER_CLOSE_MS, mentionQuery } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  GENERAL_ID,
  meWithRole,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const typeIn = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  });
const keyDown = (el: Element, key: string) => act(async () => fireEvent.keyDown(el, { key }));
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
/** The card's ⋯ (Radix opens it on pointer down): its entries. */
const openMore = async (card: HTMLElement) => {
  await act(async () =>
    fireEvent.pointerDown(within(card).getByRole("button", { name: "Mais" }), { button: 0, ctrlKey: false }),
  );
  await settle(2);
  return screen().getByRole("menu", { name: "Mais" });
};

describe("@mention autocomplete", () => {
  test("query right before the caret", () => {
    expect(mentionQuery("oi @ad", 6)).toEqual({ start: 3, query: "ad" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("joao@acme", 9)).toBeNull();
    expect(mentionQuery("@ada ", 5)).toBeNull();
  });

  test("channel members first, filter as you type, arrows and Enter insert @handle + space", async () => {
    await go(`c/${ENG_ID}`);
    const box = composer();
    expect(box.getAttribute("aria-expanded")).toBe("false");
    await typeIn(box, "oi @a");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    const options = within(list).getAllByRole("option");
    // Name matches first (Ada, Atlas), then other matches (João).
    expect(options[0]?.textContent).toContain("Ada");
    expect(options[1]?.textContent).toContain("Atlas");
    expect(options[0]?.textContent).toContain("@ada · Agente · Dev");
    expect(list.textContent).toContain("Neste canal");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[0]?.id ?? null);
    await keyDown(box, "ArrowDown");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[1]?.id ?? null);
    await keyDown(box, "Enter");
    expect(composer().value).toBe("oi @atlas ");
    expect(screen().queryByRole("listbox", { name: "Pessoas e agentes" })).toBeNull();
  });

  test("Tab picks, Esc closes without sending", async () => {
    const { state } = await go(`c/${ENG_ID}`);
    await typeIn(composer(), "@jo");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("João");
    await keyDown(composer(), "Tab");
    expect(composer().value).toBe("@joao ");
    await typeIn(composer(), "@joao e @ad");
    expect(screen().getByRole("listbox", { name: "Pessoas e agentes" })).toBeTruthy();
    await keyDown(composer(), "Escape");
    expect(screen().queryByRole("listbox", { name: "Pessoas e agentes" })).toBeNull();
    expect(composer().value).toBe("@joao e @ad");
    expect(state.calls.some((c) => c.method === "chat.post")).toBe(false);
  });

  test("an agent outside the channel says so, and picking it offers to add it", async () => {
    const { state } = await go(`c/${GENERAL_ID}`);
    await typeIn(composer(), "@atl");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    const atlas = within(list).getByRole("option", { name: /Atlas/ });
    expect(atlas.textContent).toContain("não está no canal");
    expect(list.textContent).toContain("No workspace");
    await click(atlas);
    expect(composer().value).toBe("@atlas ");
    const offer = screen()
      .getByText("Atlas não está no canal e não vai ver a menção.")
      .closest(".mention-offer") as HTMLElement;
    await click(within(offer).getByRole("button", { name: "Adicionar ao canal" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.addMember")?.args).toEqual([
      ORG_ID,
      GENERAL_ID,
      { agentId: ATLAS_ID },
    ]);
    expect(screen().getByText("Atlas entrou no canal.")).toBeTruthy();
  });

  test("in a DM, picking an agent outside it offers nothing to add: a DM takes no new member", async () => {
    const { state } = await go(`dm/agent/${ADA_ID}`);
    await typeIn(composer(), "@atl");
    await click(
      within(screen().getByRole("listbox", { name: "Pessoas e agentes" })).getByRole("option", { name: /Atlas/ }),
    );
    expect(composer().value).toBe("@atlas ");
    expect(document.querySelector(".mention-offer")).toBeNull();
    expect(state.calls.some((c) => c.method === "chat.addMember")).toBe(false);
  });

  test("the right hand is in every channel: no note, and picking it offers nothing to add", async () => {
    const { state } = await go(`c/${GENERAL_ID}`, withRightHand(seedState()));
    await typeIn(composer(), "@lod");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    const lodi = within(list).getByRole("option", { name: /Lodi/ });
    expect(lodi.textContent).not.toContain("não está no canal");
    await click(lodi);
    expect(composer().value).toBe("@lodi ");
    expect(document.querySelector(".mention-offer")).toBeNull();
    expect(state.calls.some((c) => c.method === "chat.addMember")).toBe(false);
  });

  test("@todos comes first for who may mention everyone, in their language, and shows as a mention to each reader", async () => {
    const state = seedState();
    // Typed in English by someone else: this reader sees their own word.
    state.messages.push({
      id: "m-all",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "@everyone deploy às 15h",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: { mentionsEveryone: true },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const pill = screen().getByText("@todos");
    expect(pill.className).toContain("ac-mention--me");
    expect(screen().queryByText("@everyone")).toBeNull();
    await typeIn(composer(), "@to");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    const first = within(list).getAllByRole("option")[0];
    expect(first?.textContent).toContain("@todos");
    expect(first?.textContent).toContain("Todo mundo desta conversa, pessoas e agentes");
    await keyDown(composer(), "Enter");
    expect(composer().value).toBe("@todos ");
  });

  test("without `mention_everyone` the list doesn't offer it", async () => {
    const state = seedState();
    meWithRole(state, ["post"]);
    await go(`c/${ENG_ID}`, state);
    await typeIn(composer(), "@");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    expect(list.textContent).not.toContain("@todos");
  });

  test("works in the task conversation's box too", async () => {
    await go("issues/131");
    // The task's composer lives in its conversation panel (ADR 0145).
    await click(screen().getByRole("button", { name: /^Conversa( \d+)?$/ }));
    await settle(6);
    expect(screen().getByRole("heading", { name: "Conversa da tarefa" })).toBeTruthy();
    const box = screen().getByRole("combobox", { name: /^Comentar na tarefa/ }) as HTMLTextAreaElement;
    await typeIn(box, "@ad");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("Ada");
    await keyDown(box, "Enter");
    expect(box.value).toBe("@ada ");
  });
});

describe("profile card", () => {
  const card = () => screen().getByRole("dialog", { name: "Perfil" });

  test("person: role, presence, local time, the message box and Mensagem direta in the ⋯", async () => {
    await go(`c/${ENG_ID}`);
    await click(screen().getAllByRole("button", { name: "Perfil de João" })[0] as HTMLElement);
    await settle(4);
    const c = card();
    expect(c.textContent).toContain("João");
    expect(c.textContent).toContain("Admin");
    expect(c.textContent).toContain("Hora local");
    // Their zone in words, never its IANA id.
    expect(c.textContent).toMatch(/\d{2}:\d{2} · Lisboa/);
    expect(c.textContent).not.toContain("Europe/Lisbon");
    expect(within(c).getByRole("textbox", { name: /^Mensagem para João/ })).toBeTruthy();
    const more = await openMore(c);
    expect(within(more).getByRole("menuitem", { name: "Mensagem direta" })).toBeTruthy();
  });

  test("agent: role, owner, model, budget used (%), the message box, and its page in the panel from the ⋯", async () => {
    await go(`c/${ENG_ID}`);
    await click(screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
    await settle(6);
    const c = card();
    expect(c.textContent).toContain("Agente · Dev");
    expect(c.textContent).toContain("Responsável");
    expect(c.textContent).toContain("João");
    expect(c.textContent).toContain("sonnet 5.5");
    expect(c.textContent).not.toContain("Pode");
    expect(c.textContent).toContain("31% do orçamento usado este mês");
    expect(c.textContent).not.toContain("US$");
    expect(within(c).getByRole("meter", { name: "Orçamento usado no mês" })).toBeTruthy();
    expect(within(c).getByRole("textbox", { name: "Mensagem para a Ada" })).toBeTruthy();
    await click(within(await openMore(c)).getByRole("menuitem", { name: "Ver perfil" }));
    await settle(4);
    expect(screen().getByRole("complementary", { name: "Perfil da Ada" })).toBeTruthy();
  });

  test("agent thinking with Claude Code: the card says the model by its plan instead of the API model, its computer only beside another", async () => {
    type Brain = NonNullable<ReturnType<typeof seedState>["agents"][number]["brain"]>;
    const model = async (brains: Record<string, Brain>) => {
      const state = seedState();
      for (const a of state.agents) if (brains[a.id]) a.brain = brains[a.id];
      await go(`c/${ENG_ID}`, state);
      await click(screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
      await settle(6);
      const line = card().querySelector(".profile-card__brain")?.textContent;
      expect(card().textContent).not.toContain("sonnet 5.5");
      cleanup();
      return line;
    };
    // The workspace's one computer tells nothing apart.
    expect(await model({ [ADA_ID]: { kind: "claude_code", model: "Opus", computer: "MacBook" } })).toBe(
      "Opus pelo plano do Claude",
    );
    // Beside an agent on another computer it does; nobody chose Ada's model, so the plan alone.
    expect(
      await model({
        [ADA_ID]: { kind: "claude_code", model: "auto", computer: "MacBook" },
        [ATLAS_ID]: { kind: "codex", model: "GPT-6 Sol", computer: "Servidor" },
      }),
    ).toBe("Plano do Claude no MacBook");
  });

  test("agent on a plan: its plan's limits and no budget until it spends through the API, then the budget after them", async () => {
    /** Ada thinks with Claude Team; `spent`: what she spent through the API this month (of US$ 40). */
    const onPlan = (spent: number) => {
      const state = seedState();
      const ada = state.agents.find((a) => a.id === ADA_ID);
      if (ada) {
        ada.brain = {
          kind: "claude_code",
          model: "Sonnet",
          account: "Claude Team",
          usage: {
            windows: [
              { kind: "five_hour", usedPercent: 12 },
              { kind: "seven_day", usedPercent: 40 },
            ],
            source: "probe",
            at: new Date().toISOString(),
          },
        };
      }
      state.spentUsd = { [ADA_ID]: spent };
      return state;
    };
    const open = async (state: ReturnType<typeof seedState>) => {
      await go(`c/${ENG_ID}`, state);
      await click(screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
      await settle(6);
      return card();
    };
    const meters = (c: HTMLElement) =>
      within(c)
        .queryAllByRole("meter")
        .map((m) => m.getAttribute("aria-label"));
    let c = await open(onPlan(0));
    expect(c.querySelector(".ac-planmeter__line")?.textContent).toBe("Claude Team · semana 40% · 5h 12%");
    expect(c.textContent).not.toContain("orçamento");
    expect(meters(c)).toEqual(["Semana"]);
    cleanup();
    c = await open(onPlan(12.3));
    const text = c.textContent ?? "";
    expect(text.indexOf("Claude Team · semana 40% · 5h 12%")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Claude Team · semana 40% · 5h 12%")).toBeLessThan(
      text.indexOf("31% do orçamento usado este mês"),
    );
    // One bar, the plan's: the budget is the short line under it.
    expect(meters(c)).toEqual(["Semana"]);
  });

  test("an agent without owner says so; members don't see spend", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = null;
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(`c/${ENG_ID}`, state);
    await click(screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
    await settle(6);
    expect(card().textContent).toContain("sem responsável");
    expect(within(card()).queryByRole("meter")).toBeNull();
  });

  test("keyboard: the name is focusable and Enter opens it; the avatar copy is mouse-only", async () => {
    await go(`c/${ENG_ID}`);
    const triggers = screen().getAllByRole("button", { name: "Perfil de João" });
    // The avatar trigger is hidden from assistive tech and the tab order.
    const avatar = document.querySelector('.profile-trigger[aria-hidden="true"]');
    expect(avatar?.getAttribute("tabindex")).toBe("-1");
    const name = triggers[0] as HTMLElement;
    name.focus();
    await keyDown(name, "Enter");
    await click(name);
    await settle(3);
    expect(card()).toBeTruthy();
  });

  test("hover with a mouse opens after ~400 ms; touch hover never does", async () => {
    await go(`c/${ENG_ID}`);
    const name = screen().getAllByRole("button", { name: "Perfil de João" })[0] as HTMLElement;
    await act(async () => fireEvent.pointerEnter(name, { pointerType: "touch" }));
    await wait(500);
    expect(screen().queryByRole("dialog", { name: "Perfil" })).toBeNull();
    await act(async () => fireEvent.pointerLeave(name, { pointerType: "touch" }));
    await act(async () => fireEvent.pointerEnter(name, { pointerType: "mouse" }));
    await wait(150);
    expect(screen().queryByRole("dialog", { name: "Perfil" })).toBeNull();
    await wait(350);
    await settle(3);
    expect(card().textContent).toContain("João");
  });

  test("hover opens it without taking the focus, open or closed; a press brings the focus in", async () => {
    await go(`c/${ENG_ID}`);
    const box = composer();
    box.focus();
    const name = screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement;
    await act(async () => fireEvent.pointerEnter(name, { pointerType: "mouse" }));
    await wait(500);
    await settle(3);
    expect(within(card()).getByRole("button", { name: "Mais" })).toBeTruthy();
    expect(document.activeElement === box).toBe(true);
    await act(async () => fireEvent.pointerLeave(name, { pointerType: "mouse" }));
    await wait(HOVER_CLOSE_MS + 50);
    expect(screen().queryByRole("dialog", { name: "Perfil" })).toBeNull();
    expect(document.activeElement === box).toBe(true);
    await click(name);
    await settle(3);
    expect(card().contains(document.activeElement)).toBe(true);
  });

  test("mention chips in messages open the card too", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-mention",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "Pode ver isso, @ada?",
      mentionedAgentIds: [ADA_ID],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const chip = Array.from(document.querySelectorAll(".profile-trigger--mention")).find((b) =>
      b.textContent?.includes("@Ada"),
    ) as HTMLElement;
    expect(chip.getAttribute("aria-label")).toBe("Perfil de Ada");
    await click(chip);
    await settle(6);
    expect(card().textContent).toContain("Agente · Dev");
  });

  test("a handle of no one in the workspace (an X username) stays plain text", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-outside",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "coloca no backlog o que o @fulano do X sugeriu, @ada",
      mentionedAgentIds: [ADA_ID],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("coloca no backlog")) as HTMLElement;
    expect([...row.querySelectorAll(".ac-mention")].map((m) => m.textContent)).toEqual(["@Ada"]);
    expect(row.textContent).toContain("o que o @fulano do X sugeriu");
  });
});
