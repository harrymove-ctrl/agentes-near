import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { DESKTOP_QUERY } from "@/components/NavDrawer";
import {
  ADA_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The team's right hand (ADR 0137) on the web: its pinned row, the members column, its profile, its DM, Settings. */

let media: { mockRestore: () => void } | null = null;
afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const go = async (state: FakeState, path = `c/${GENERAL_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const pinRow = () => nav().querySelector<HTMLElement>("a[data-right-hand]");
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("the right hand's row in the sidebar", () => {
  test("the first row of Agentes, above the pinned agents, with its label as a tag; never under Mensagens diretas", async () => {
    const state = withRightHand(seedState());
    seedDm(state, { type: "agent", id: LODI_ID }, { ago: 2 });
    seedDm(state, { type: "agent", id: ADA_ID }, { ago: 5 });
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [ADA_ID], channels: [], people: [] },
    };
    await go(state);
    const row = pinRow();
    expect(row).toBeTruthy();
    const agents = nav().querySelector<HTMLElement>('[data-section="agents"]');
    const body = agents?.querySelector(".sidebar__section-body");
    expect(body?.firstElementChild).toBe(row);
    expect(nav().querySelector('[data-section="people"]')?.contains(row)).toBe(false);
    expect(row?.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
    expect(row?.querySelector(".sidebar__item-label")?.textContent).toBe("Lodi");
    expect(row?.querySelector(".sidebar__item-role")?.textContent).toBe("seu braço direito");
    expect(row?.querySelector(".sidebar__item-role")?.classList.contains("ac-tag")).toBe(true);
    const dms = [...nav().querySelectorAll<HTMLElement>("[data-agent-row]")].map((r) => r.dataset.agentRow);
    expect(dms[0]).toBe(ADA_ID);
    expect(dms).not.toContain(LODI_ID);
    // Closed, Agentes still shows it (the stylesheet keeps `[data-right-hand]` in sight).
    await click(agents?.querySelector(".sidebar__section-toggle") as HTMLElement);
    expect(agents?.querySelector(".sidebar__section")?.getAttribute("data-open")).toBe("false");
    expect(body?.firstElementChild).toBe(pinRow());
  });

  test("alone in AGENTES, it offers no first agent to a member who can't create one", async () => {
    const state = withRightHand(seedState({ agents: [] }));
    const org = state.me?.organizations[0];
    if (org) org.role = "member";
    await go(state);
    const agents = nav().querySelector<HTMLElement>('[data-section="agents"]');
    expect(agents?.querySelector(".sidebar__section-body")?.firstElementChild).toBe(pinRow());
    expect(agents?.textContent).not.toContain("Criar o primeiro agente");
  });

  test("Novo until it is first opened, then its label; its DM's unread count when it answered", async () => {
    const state = withRightHand(seedState());
    await go(state);
    expect(pinRow()?.textContent).toContain("Novo");
    await click(pinRow() as HTMLElement);
    expect(pinRow()?.textContent).not.toContain("Novo");
    expect(pinRow()?.textContent).toContain("seu braço direito");
    cleanup();
    localStorage.clear();
    // Its DM opened any other way (the onboarding, Mensagem on its card): gone all the same.
    const { router } = await go(withRightHand(seedState()));
    expect(pinRow()?.textContent).toContain("Novo");
    await act(async () => {
      await router.navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: ORG_ID, agentId: LODI_ID } });
    });
    await settle(8);
    expect(pinRow()?.textContent).not.toContain("Novo");
    cleanup();
    // Remembered in this browser.
    const again = withRightHand(seedState());
    seedDm(again, { type: "agent", id: LODI_ID }, { unread: 2 });
    await go(again);
    expect(pinRow()?.querySelector(".sidebar__item-meta")).toBeNull();
    expect(pinRow()?.textContent).toContain("2");
  });

  test("outside its audience, there is no row", async () => {
    await go(
      withRightHand(seedState(), { ownerUserId: "u-joao", audience: { mode: "people", userIds: [], roleIds: ["r"] } }),
    );
    expect(pinRow()).toBeNull();
  });
});

describe("the right hand elsewhere", () => {
  test("the members column doesn't list it: it is in no channel, an @mention reaches it", async () => {
    media = spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: q === DESKTOP_QUERY,
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    const r = await go(withRightHand(seedState()), `c/${ENG_ID}`);
    await act(async () => r.sockets.last().open());
    const column = screen().getByRole("complementary", { name: "Membros de #eng" });
    const agents = within(column).getByRole("region", { name: "Agentes" });
    const names = [...agents.querySelectorAll(".members-side__label")].map((n) => n.textContent);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("Lodi");
    expect(column.textContent).not.toContain("chame com @lodi");
  });

  test("its DM says what it is and that nothing changes without you", async () => {
    await go(withRightHand(seedState()), `dm/agent/${LODI_ID}`);
    const header = document.querySelector(".channel__header") as HTMLElement;
    // As the language writes it; the line's first letter goes up in CSS (no case change on translated text).
    const topic = header.querySelector(".channel__topic[data-right-hand]");
    expect(topic?.textContent).toBe("seu braço direito · age com as suas permissões");
    // Nothing about models: each person's DM with it thinks with their own AI, in the side panel's Como pensa.
    expect(header.querySelector(".channel__brain")).toBeNull();
    expect(header.textContent).not.toContain("Automático");
    expect(header.textContent).not.toContain("Computador");
    expect(screen().getByRole("combobox", { name: "Mensagem para Lodi · nada muda sem você" })).toBeTruthy();
  });

  test("its greeting's paragraphs sit in a typed message's Markdown wrapper, so its first line is where any message's is", async () => {
    await go(withRightHand(seedState()), `dm/agent/${LODI_ID}`);
    const greeting = [...document.querySelectorAll(".ac-msg__text b")].find((b) =>
      b.textContent?.startsWith("Oi, eu sou o Lodi"),
    );
    const wrapper = greeting?.closest("p")?.parentElement;
    expect(wrapper?.className).toBe("md md--message");
    expect(wrapper?.parentElement?.classList.contains("ac-msg__text")).toBe(true);
  });

  test("its greeting's name opens the profile card, as any message's; in its DM no face, the sides say who spoke", async () => {
    await go(withRightHand(seedState()), `dm/agent/${LODI_ID}`);
    const greeting = [...document.querySelectorAll(".ac-msg")].find((m) =>
      m.textContent?.includes("Oi, eu sou o Lodi"),
    );
    expect(greeting?.querySelector(".ac-msg__avatar")).toBeNull();
    expect(greeting?.getAttribute("data-faces")).toBe("false");
    expect(document.querySelector(".channel__messages")?.getAttribute("data-faces")).toBe("false");
    const name = greeting?.querySelector(".profile-trigger--name") as HTMLElement;
    expect(name.getAttribute("aria-label")).toBe("Perfil de Lodi");
    await click(name);
    expect(document.querySelector(".profile-card")?.textContent).toContain("Lodi");
  });

  test("with a team and no card left, its greeting still ends with the way to build the team", async () => {
    const state = withRightHand(seedState());
    seedDm(state, { type: "agent", id: LODI_ID }, { body: "oi, tudo bem?" });
    await go(state, `dm/agent/${LODI_ID}`);
    await click(screen().getByRole("button", { name: "Montar o time" }));
    expect(state.messages.some((m) => m.body === "Me ajuda a montar o time.")).toBe(true);
  });

  test("on the first visit it waves under its greeting, once: the visit marks its DM read, so the next has no wave", async () => {
    const state = withRightHand(seedState());
    state.dms.push({
      channelId: "dm-lodi",
      with: { type: "agent", id: LODI_ID, name: "Lodi", handle: "lodi" },
      everRead: false,
    });
    state.channelMembers["dm-lodi"] = [
      { type: "person", id: state.me?.user.id ?? "" },
      { type: "agent", id: LODI_ID },
    ];
    await go(state, `dm/agent/${LODI_ID}`);
    const sticker = document.querySelector('.ac-msg canvas.ac-sticker[data-mood="wave"]');
    expect(sticker?.getAttribute("aria-hidden")).toBe("true");
    expect(sticker?.classList.contains("ac-msg-media")).toBe(true);
    expect(state.calls).toContainEqual({ method: "dms.markRead", args: [ORG_ID, "dm-lodi"] });
    cleanup();
    await go(state, `dm/agent/${LODI_ID}`);
    expect(document.querySelector(".ac-msg__text b")?.textContent).toStartWith("Oi, eu sou o Lodi");
    expect(document.querySelector('canvas[data-mood="wave"]')).toBeNull();
  });

  test("Lodi's page: its name, the lock line and its audit link", async () => {
    await go(withRightHand(seedState()), `agents/${LODI_ID}`);
    expect(screen().getByRole("heading", { name: "Lodi" })).toBeTruthy();
    const body = document.querySelector(".page") as HTMLElement;
    expect(body.textContent).toContain("Na barra lateral ele aparece sempre como “seu braço direito”.");
    expect(body.textContent).toContain("O Lodi não pode ser arquivado nem apagado.");
    expect(within(body).getByRole("link", { name: "Ver o que o Lodi fez" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/audit?agent=${LODI_ID}`,
    );
  });

  test("Mudar visual: the face and the choices in the dialog's body, Cancelar and Salvar in its footer", async () => {
    await go(withRightHand(seedState()), `agents/${LODI_ID}`);
    await click(screen().getByRole("button", { name: "Mudar o visual do Lodi" }));
    const dialog = screen().getByRole("dialog", { name: "Mudar visual" });
    const body = dialog.querySelector(":scope > .ac-dialog__body") as HTMLElement;
    expect(body.querySelector(".rh-set__face")).not.toBeNull();
    expect(body.querySelector(".agp-look")).not.toBeNull();
    const foot = dialog.querySelector(":scope > .ac-dialog__foot") as HTMLElement;
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancelar", "Salvar"]);
  });

  test("renaming it there saves the name and its @", async () => {
    const { state } = await go(withRightHand(seedState()), `agents/${LODI_ID}`);
    const name = screen().getByRole("textbox", { name: "Nome e visual" });
    await act(async () => fireEvent.change(name, { target: { value: "Bento" } }));
    await act(async () => fireEvent.blur(name));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args.slice(1)).toEqual([
      LODI_ID,
      { name: "Bento", handle: "bento" },
    ]);
  });

  test("nobody has a Lodi section in the settings", async () => {
    const state = withRightHand(seedState());
    const org = state.me?.organizations[0];
    if (org) org.role = "member";
    await go(state, "settings/account");
    const settingsNav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(settingsNav).queryByRole("link", { name: "Lodi" })).toBeNull();
  });
});
