import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { COMPACT_QUERY, DESKTOP_QUERY } from "@/components/NavDrawer";
import { TABLET_QUERY } from "@/components/Sidebar";
import { STORAGE_KEYS } from "@/lib/storage";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
/** Only `query` matches (a desktop, a tablet, a phone). */
const widthIs = (query: string) => {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === query,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};

afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const COLUMN_KEY = `${STORAGE_KEYS.membersColumn}.u-walter.${ORG_ID}`;
const toggle = () => screen().getByRole("button", { name: "Membros do canal (4)" });
const column = () => screen().queryByRole("complementary", { name: "Membros de #eng" });
const sheet = () => screen().queryByRole("dialog", { name: "Membros de #eng" });
/** A member's row, found by the name it shows. */
const row = (within: HTMLElement, name: string) =>
  [...within.querySelectorAll<HTMLElement>(".members-side__row")].find(
    (r) => r.querySelector(".members-side__label")?.textContent === name,
  ) ?? null;

const open = async (state: FakeState = seedState()) => {
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) (ada as { appearance?: unknown }).appearance = { color: "amber", accessory: "hat" };
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  await act(async () => r.sockets.last().open());
  return { state, sockets: r.sockets };
};

describe("the members column", () => {
  test("open by default on a desktop; the toggle closes it and the choice outlives a remount", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    expect(column()).toBeTruthy();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getAttribute("title")).toBe("Esconder membros");
    expect(toggle().querySelectorAll(".ac-avatar")).toHaveLength(0);
    await act(async () => fireEvent.click(toggle()));
    expect(column()).toBeNull();
    expect(localStorage.getItem(COLUMN_KEY)).toBe("0");
    cleanup();
    await open();
    expect(column()).toBeNull();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  test("under the channel's header: the header spans the chat and the column, which starts below it", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    const main = screen().getByRole("main");
    const header = main.querySelector(":scope > .channel__header") as HTMLElement;
    expect(header).toBeTruthy();
    const body = header.nextElementSibling as HTMLElement;
    expect(body.classList.contains("channel__body")).toBe(true);
    expect(body.firstElementChild?.classList.contains("channel__col")).toBe(true);
    expect(body.lastElementChild).toBe(column());
    // The messages and the composer stay in the chat's column, not under the members.
    expect(body.querySelector(":scope > .channel__col .channel__messages")).toBeTruthy();
    expect(body.querySelector(":scope > .channel__col .channel__composer")).toBeTruthy();
  });

  test("a personal workspace starts it closed on a desktop; opening it is remembered (ADR 0159)", async () => {
    widthIs(DESKTOP_QUERY);
    const personal = () => {
      const state = seedState();
      const org = state.me?.organizations[0];
      if (org) org.mode = "personal";
      return state;
    };
    // The toggle and the column by their count and the channel's name: a personal workspace may word them its way.
    const button = () => screen().getByRole("button", { name: /\(4\)/ });
    const side = () => screen().queryByRole("complementary", { name: /eng/ });
    await open(personal());
    expect(side()).toBeNull();
    expect(button().getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(button()));
    expect(side()).toBeTruthy();
    expect(localStorage.getItem(COLUMN_KEY)).toBe("1");
    cleanup();
    await open(personal());
    expect(side()).toBeTruthy();
  });

  test("closed by default on a tablet, where the toggle opens it beside the chat", async () => {
    widthIs(TABLET_QUERY);
    await open();
    expect(column()).toBeNull();
    await act(async () => fireEvent.click(toggle()));
    expect(column()).toBeTruthy();
    expect(localStorage.getItem(COLUMN_KEY)).toBe("1");
  });

  test("groups: the owner with the crown, the hoisted Admin, the agents, then offline; you, and the agents' lines", async () => {
    widthIs(DESKTOP_QUERY);
    const state = seedState();
    state.online.add("u-joao");
    const { sockets } = await open(state);
    const side = column() as HTMLElement;
    const heads = [...side.querySelectorAll(".members-side__head")].map((h) => h.textContent);
    expect(heads).toEqual(["Dono — 1", "Admin — 1", "Agentes — 2"]);
    // The owner's and each role's group carry their mark.
    expect(side.querySelectorAll(".members-side__head .ac-rolemark")).toHaveLength(2);
    const owner = within(side).getByRole("region", { name: "Dono" });
    expect(within(owner).getByRole("img", { name: "Dono do workspace" })).toBeTruthy();
    expect(owner.textContent).toContain("você");
    expect(within(side).getByRole("region", { name: "Admin" }).textContent).toContain("João");
    const agents = within(side).getByRole("region", { name: "Agentes" });
    expect(agents.textContent).toContain("Dev");
    // Answering without a mention is said on the agent's card, not as a chip in the row.
    expect(agents.textContent).not.toContain("sem menção");
    // Ada starts thinking: her state here, and the trail behind her row.
    await act(async () =>
      sockets.last().push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.run",
          channelId: ENG_ID,
          threadId: "m-1",
          runId: "r9",
          agentId: ADA_ID,
          status: "running",
        },
      }),
    );
    await settle(2);
    const ada = row(column() as HTMLElement, "Ada") as HTMLElement;
    // Named "Perfil de Ada", described by all it shows (presence, line, chips).
    expect(ada.getAttribute("aria-label")).toBe("Perfil de Ada");
    // What it does here: the pixel orbit beside its name, labelled, and the row's title; the row keeps its height.
    expect(ada.querySelector(".members-side__name .ac-pixspin")?.getAttribute("aria-label")).toBe("pensando");
    expect(document.getElementById(ada.getAttribute("aria-describedby") ?? "")?.getAttribute("title")).toContain(
      "pensando",
    );
    expect(ada.querySelector("[data-busy] .sidebar__trail")).toBeTruthy();
    // ↑/↓ between the rows.
    const rows = [...(column() as HTMLElement).querySelectorAll<HTMLElement>(".members-side__row")];
    rows[0]?.focus();
    await act(async () => fireEvent.keyDown(rows[0] as HTMLElement, { key: "ArrowDown" }));
    expect(document.activeElement === (rows[1] as HTMLElement)).toBe(true);
  });

  test("someone offline sits under Offline, drawn quieter", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    const offline = within(column() as HTMLElement).getByRole("region", { name: "Offline" });
    const joao = offline.querySelector(".members-side__inner") as HTMLElement;
    expect(joao.textContent).toContain("João");
    expect(joao.getAttribute("data-presence")).toBe("offline");
  });

  test("live: an agent someone else made and added, a person who joins, both leaving, without a reload", async () => {
    widthIs(DESKTOP_QUERY);
    const state = seedState();
    const { sockets } = await open(state);
    const names = () =>
      [...(column() as HTMLElement).querySelectorAll(".members-side__label")].map((l) => l.textContent);
    const channelEvent = (type: string, member: { type: "person" | "agent"; id: string }) =>
      act(async () =>
        sockets.last().push({ type: "event", channelId: ENG_ID, event: { type, channelId: ENG_ID, member } }),
      );
    expect(names()).not.toContain("Lodi");
    // Made a moment ago in another browser: the app doesn't know it yet, so the agents are read again too.
    const lodi = { ...(state.agents[0] as (typeof state.agents)[number]), id: "a-lodi", name: "Lodi", handle: "lodi" };
    state.agents.push(lodi);
    state.channelMembers[ENG_ID]?.push({ type: "agent", id: "a-lodi" });
    await channelEvent("channel.member_added", { type: "agent", id: "a-lodi" });
    await settle(4);
    expect(names()).toContain("Lodi");
    // A newcomer to the workspace, placed here by their invitation: `org.members` reads who is where again.
    const bia = {
      ...(state.members[1] as (typeof state.members)[number]),
      userId: "u-bia",
      name: "Bia",
      email: "bia@acme.com.br",
    };
    state.members.push(bia);
    state.channelMembers[ENG_ID]?.push({ type: "person", id: "u-bia" });
    await act(async () => sockets.last().push({ type: "event", scope: "org", event: { type: "org.members" } }));
    await settle(4);
    expect(names()).toContain("Bia");
    state.channelMembers[ENG_ID] = (state.channelMembers[ENG_ID] ?? []).filter(
      (m) => m.id !== "a-lodi" && m.id !== "u-bia",
    );
    await channelEvent("channel.member_removed", { type: "agent", id: "a-lodi" });
    // A second change to the same list this soon is read when the gap between two reads ends.
    await act(() => new Promise((r) => setTimeout(r, 600)));
    await settle(4);
    expect(names()).not.toContain("Lodi");
    expect(names()).not.toContain("Bia");
  });

  test("someone's new name (from another device) shows at once", async () => {
    widthIs(DESKTOP_QUERY);
    const { state, sockets } = await open();
    const joao = state.members.find((m) => m.userId === "u-joao");
    if (joao) joao.name = "João Pedro";
    await act(async () => sockets.last().push({ type: "event", scope: "org", event: { type: "org.members" } }));
    await settle(6);
    expect(row(column() as HTMLElement, "João Pedro")).toBeTruthy();
    expect(row(column() as HTMLElement, "João")).toBeNull();
  });

  test("an agent out of its plan: one short line with no emoji, the whole line on hover and on its card", async () => {
    widthIs(DESKTOP_QUERY);
    const until = new Date(Date.now() + 60_000).toISOString();
    const state = seedState({
      agentStatuses: [
        {
          agentId: ADA_ID,
          presence: "out",
          status: { by: "auto", text: null, kind: "out_of_plan", subject: null, emoji: null, until, count: 4 },
          activeAt: new Date().toISOString(),
        },
      ],
    });
    await open(state);
    await settle(4);
    const ada = row(column() as HTMLElement, "Ada") as HTMLElement;
    const line = ada.querySelector(".members-side__line") as HTMLElement;
    expect(line.textContent).toMatch(/^Sem limite · volta às \d{1,2}:\d{2}$/);
    expect(line.querySelector(".status-line__emoji")).toBeNull();
    const inner = ada.querySelector(".members-side__inner") as HTMLElement;
    expect(inner.getAttribute("title")).toContain("Sem limite no plano");
    expect(inner.getAttribute("title")).toContain("4 conversas esperando");
    await act(async () => fireEvent.click(ada));
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Perfil" }).textContent).toContain("4 conversas esperando");
  });

  test("a row opens the member's card", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    await act(async () => fireEvent.click(row(column() as HTMLElement, "João") as HTMLElement));
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Perfil" }).textContent).toContain("João");
  });

  test("not in a DM", async () => {
    widthIs(DESKTOP_QUERY);
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(6);
    expect(document.querySelector(".members-side")).toBeNull();
  });

  test("on a phone: a sheet with the threads, pins and settings buttons, and a field that finds members", async () => {
    widthIs(COMPACT_QUERY);
    await open(withRightHand(seedState()));
    expect(column()).toBeNull();
    await act(async () => fireEvent.click(toggle()));
    await settle(2);
    const panel = sheet() as HTMLElement;
    expect(panel.classList.contains("members-sheet")).toBe(true);
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(within(panel).getByRole("button", { name: "Configurações do canal" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Mensagens fixadas" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /^Threads/ })).toBeTruthy();
    expect(row(panel, "Lodi")).toBeNull();
    await act(async () =>
      fireEvent.change(within(panel).getByRole("searchbox", { name: "Buscar pessoas e agentes" }), {
        target: { value: "atl" },
      }),
    );
    expect(row(panel, "Ada")).toBeNull();
    expect(row(panel, "Atlas")).toBeTruthy();
    // The cog closes the sheet for the channel's details.
    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Configurações do canal" })));
    await settle(3);
    expect(sheet()).toBeNull();
    expect(screen().getByRole("dialog", { name: /eng/ })).toBeTruthy();
  });
});

describe("Adicionar pessoa ou agente at the bottom", () => {
  test("the column's last row opens the channel details' add flow, alone", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    const add = within(column() as HTMLElement).getByRole("button", { name: "Adicionar pessoa ou agente" });
    expect(add.parentElement?.lastElementChild).toBe(add);
    await act(async () => fireEvent.click(add));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Adicionar a #eng" })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: /^#eng/ })).toBeNull();
  });

  test("never offers the right hand: it is in no channel", async () => {
    widthIs(DESKTOP_QUERY);
    const state = withRightHand(seedState());
    state.agents.push({
      ...(state.agents.find((a) => a.id === ATLAS_ID) as FakeState["agents"][number]),
      id: "a-theo",
      name: "Theo",
      handle: "theo",
    });
    await open(state);
    await act(async () =>
      fireEvent.click(within(column() as HTMLElement).getByRole("button", { name: "Adicionar pessoa ou agente" })),
    );
    await settle(4);
    const add = screen().getByRole("dialog", { name: "Adicionar a #eng" });
    expect(within(add).queryByText("Lodi")).toBeNull();
    expect(within(add).getByText("Theo")).toBeTruthy();
  });

  test("the phone's sheet has it too, and it closes the sheet", async () => {
    widthIs(COMPACT_QUERY);
    await open();
    await act(async () => fireEvent.click(toggle()));
    await settle(2);
    await act(async () =>
      fireEvent.click(within(sheet() as HTMLElement).getByRole("button", { name: "Adicionar pessoa ou agente" })),
    );
    await settle(4);
    expect(sheet()).toBeNull();
    expect(screen().getByRole("dialog", { name: "Adicionar a #eng" })).toBeTruthy();
  });

  test("not for who can't add members", async () => {
    widthIs(DESKTOP_QUERY);
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) Object.assign(org, { role: "member", permissions: [] });
    await open(state);
    expect(within(column() as HTMLElement).queryByRole("button", { name: "Adicionar pessoa ou agente" })).toBeNull();
  });
});

describe("the phone's members sheet: a dialog over the channel", () => {
  const openSheet = async () => {
    widthIs(COMPACT_QUERY);
    await open();
    toggle().focus();
    await act(async () => fireEvent.click(toggle()));
    await settle(2);
    return sheet() as HTMLElement;
  };

  test("focus goes in, the channel behind is inert; Esc closes it and focus is back on the toggle", async () => {
    const panel = await openSheet();
    expect(panel.contains(document.activeElement)).toBe(true);
    expect((screen().getByRole("main") as HTMLElement).inert).toBe(true);
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    await settle(1);
    expect(sheet()).toBeNull();
    expect((screen().getByRole("main") as HTMLElement).inert).toBe(false);
    expect(document.activeElement === toggle()).toBe(true);
  });

  test("a swipe to the right closes it; a short one doesn't", async () => {
    const panel = await openSheet();
    const swipe = async (dx: number) =>
      act(async () => {
        fireEvent.touchStart(panel, { touches: [{ clientX: 100 }] });
        fireEvent.touchEnd(panel, { changedTouches: [{ clientX: 100 + dx }] });
      });
    await swipe(20);
    expect(sheet()).toBeTruthy();
    await swipe(120);
    expect(sheet()).toBeNull();
  });

  test("the backdrop closes it", async () => {
    await openSheet();
    const scrim = document.querySelector(".members-sheet__scrim") as HTMLElement;
    expect(scrim.inert).toBe(false);
    await act(async () => fireEvent.click(scrim));
    expect(sheet()).toBeNull();
  });
});

describe("the members column's edges", () => {
  test("someone who hasn't joined a public channel still sees its members", async () => {
    widthIs(DESKTOP_QUERY);
    const state = seedState();
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) eng.isMember = false;
    await open(state);
    expect(column()).toBeTruthy();
  });

  test("offline past the cap waits behind Mostrar mais", async () => {
    widthIs(DESKTOP_QUERY);
    const state = seedState();
    const base = state.members[1] as (typeof state.members)[number];
    const extra = Array.from({ length: 105 }, (_, i) => ({
      ...base,
      userId: `u-off-${i}`,
      name: `Offline ${String(i).padStart(3, "0")}`,
      handle: `off${i}`,
    }));
    state.members.push(...extra);
    state.channelMembers[ENG_ID]?.push(...extra.map((m) => ({ type: "person" as const, id: m.userId })));
    await open(state);
    const offline = within(column() as HTMLElement).getByRole("region", { name: "Offline" });
    expect(offline.querySelectorAll(".members-side__row").length).toBe(100);
    await act(async () => fireEvent.click(within(offline).getByRole("button", { name: /^Mostrar mais/ })));
    expect(offline.querySelectorAll(".members-side__row").length).toBeGreaterThan(100);
  });
});

describe("answering without a mention, as true for my own messages as who picks them", () => {
  const withRouting = async (mine: NonNullable<AiStatus["routing"]>["mine"]) => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [],
        routing: { by: mine === "plan" ? "plans" : mine, mine, model: null, noSmallModel: null },
        apiKey: false,
      },
    });
    await open(state);
  };
  const columnAgents = async () => {
    await settle(4);
    return within(column() as HTMLElement).getByRole("region", { name: "Agentes" }).textContent;
  };
  /** The details' row line of an agent that answers on its own, and its menu's "Por conta própria" line. */
  const onItsOwn = async () => {
    await act(async () =>
      fireEvent.click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" })),
    );
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    // Who manages it lands on Visão geral (ADR 0134): its people and agents are under Membros.
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Membros" })));
    await settle(2);
    const row = within(dialog).getByText("Atlas").closest(".member-row") as HTMLElement;
    const line = row.querySelector(".small")?.textContent;
    const button = within(row).getByRole("button", { name: "Opções de Atlas" });
    button.focus();
    await act(async () => {
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
    });
    await settle(1);
    const option = within(screen().getByRole("menu")).getByRole("menuitemradio", { name: /^Por conta própria/ });
    return { line, option: option.querySelector(".ac-menu__desc")?.textContent };
  };

  /** The card an agent's row in the column opens. */
  const cardOf = async (name: string) => {
    await act(async () => fireEvent.click(row(column() as HTMLElement, name) as HTMLElement));
    await settle(3);
    return screen().getByRole("dialog", { name: "Perfil" }).textContent;
  };

  test("my own plan picks: no chip in the column and no line on the agent's card about answering without an @", async () => {
    await withRouting("plan");
    expect(await columnAgents()).not.toContain("sem menção");
    expect(await cardOf("Atlas")).not.toContain("sem precisar de @");
  });

  test("only rules for my messages: no line on its card; it still takes replies and follow-ups", async () => {
    await withRouting("rules");
    expect(await columnAgents()).not.toContain("sem menção");
    expect(await cardOf("Atlas")).not.toContain("sem precisar de @");
    cleanup();
    await withRouting("rules");
    expect(await onItsOwn()).toEqual({
      line: "Também responde a respostas e continuações",
      option: "Também responde a respostas e continuações",
    });
  });

  test("the router off: for now only a mention calls it", async () => {
    await withRouting("off");
    expect(await columnAgents()).not.toContain("sem menção");
    cleanup();
    await withRouting("off");
    expect(await onItsOwn()).toEqual({
      line: "Por enquanto, responde só quando alguém menciona",
      option: "Por enquanto, responde só quando alguém menciona",
    });
  });

  test("Jev picks: it joins in on its own, when the topic calls for it", async () => {
    await withRouting("jev");
    expect(await onItsOwn()).toEqual({
      line: "Entra na conversa por conta própria",
      option: "Responde quando o assunto pede, sem precisar de @",
    });
  });
});

describe("Settings › Papéis: listed apart", () => {
  test("a role's switch sets whether its people get their own group in the members column", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/roles`, { api: createFakeApi(state) });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Admin/ })));
    await settle(4);
    const hoist = screen().getByRole("switch", { name: /Mostrar separado na lista de membros/ });
    expect(hoist.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(hoist));
    await settle(2);
    expect(state.calls.find((c) => c.method === "roles.update")?.args[2]).toEqual({ hoist: false });
  });
});

describe("an agent out of office", () => {
  test("sleeps in the members column while its plan is spent, and wakes when it is back", async () => {
    widthIs(DESKTOP_QUERY);
    const state = seedState();
    const line = { by: "auto" as const, text: null, subject: null, emoji: null, until: null, count: 2 };
    state.agentStatuses = [
      { agentId: ADA_ID, presence: "away", status: { ...line, kind: "out_of_plan" }, activeAt: null },
      { agentId: ATLAS_ID, presence: "online", status: null, activeAt: null },
    ];
    await open(state);
    const ada = row(column() as HTMLElement, "Ada") as HTMLElement;
    expect(ada.querySelector(".ac-avatar")?.getAttribute("data-state")).toBe("sleeping");
    const atlas = row(column() as HTMLElement, "Atlas") as HTMLElement;
    expect(atlas.querySelector(".ac-avatar")?.getAttribute("data-state")).toBe("idle");
  });
});
