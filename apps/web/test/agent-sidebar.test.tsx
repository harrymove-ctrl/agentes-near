import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  type ApiClient,
  asksPicture,
  PICTURE_IDLE_MS,
  PICTURE_WORKING_MS,
  pictureRefreshMs,
} from "@agenteschat/client";
import { pictureWhen } from "@agenteschat/client/lib/agent-computer";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { DM_SIDE_NARROW_QUERY, DM_SIDE_WIDE_QUERY } from "@/hooks/useMembersColumn";
import { STORAGE_KEYS } from "@/lib/storage";
import {
  ADA_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  fakeBrowserOf,
  fakeMachinesOf,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
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
  setSystemTime();
});

const seeded = seedState();
const ME = seeded.me?.user.id ?? "";
const OTHER = seeded.members.find((m) => m.userId !== ME)?.userId ?? "";
const KEY = `${STORAGE_KEYS.dmSidebar}.${ME}.${ORG_ID}`;
const toggle = () => screen().queryByRole("button", { name: "Detalhes" });
const side = () => screen().queryByRole("complementary", { name: "Detalhes" });
const section = (name: string) => within(side() as HTMLElement).queryByRole("region", { name });

interface Options {
  state?: FakeState;
  desktop?: { available: boolean; reason: string | null; running: boolean; canControl?: boolean };
  forbidden?: boolean;
  agentId?: string;
  prepare?: (api: ApiClient) => Promise<void>;
}

const openDm = async ({ state = seedState(), desktop, forbidden, agentId = ADA_ID, prepare }: Options = {}) => {
  const api = createFakeApi(state);
  await prepare?.(api);
  const fake = fakeBrowserOf.get(api);
  const machines = fakeMachinesOf.get(api);
  if (!fake || !machines) throw new Error("no fakes");
  const m = machines.pair({ name: "Box", os: "linux" });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
  fake.desktops.set(ADA_ID, desktop ?? { available: true, reason: null, running: true, canControl: true });
  if (forbidden) fake.forbidden.add(ADA_ID);
  const calls = spyOn(api.desktop, "picture");
  await renderApp(`/org/${ORG_ID}/dm/agent/${agentId}`, { api });
  await settle(12);
  return { api, calls };
};

describe("the computer section", () => {
  test("a computer with nothing to show gets its one line saying why, the way to it, and no empty picture", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await openDm({ desktop: { available: false, reason: "desktop_unavailable", running: false } });
    const computer = section("Computador") as HTMLElement;
    expect(computer.textContent).toContain("O Box ainda não mostra telas");
    expect(computer.textContent).not.toContain("Não dá para mostrar agora");
    expect(side()?.querySelector(".dm-side__noscreen")).toBeNull();
    // The way out: its computer, whose cover says what to do there and tries again.
    await act(async () => fireEvent.click(within(computer).getByRole("button", { name: "Abrir" })));
    await settle(6);
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain("O Box ainda não mostra telas");
    expect(within(dialog).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });
});

describe("the toggle", () => {
  test("open by default on a wide window; closing it is remembered per person, and Computador comes back", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await openDm();
    expect(side()).toBeTruthy();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(screen().queryByRole("button", { name: "Computador" })).toBeNull();
    await act(async () => fireEvent.click(toggle() as HTMLElement));
    expect(side()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("0");
    expect(screen().getByRole("button", { name: "Computador" })).toBeTruthy();
    cleanup();
    await openDm();
    expect(side()).toBeNull();
  });

  /** The seeded workspace as a personal one (ADR 0159). */
  const personalState = () => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.mode = "personal";
    return state;
  };

  test("a personal workspace starts it closed on a wide window; opening it is remembered", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await openDm({ state: personalState() });
    expect(side()).toBeNull();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    // With the column closed, Computador is back in the header.
    expect(screen().getByRole("button", { name: "Computador" })).toBeTruthy();
    await act(async () => fireEvent.click(toggle() as HTMLElement));
    expect(side()).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBe("1");
    cleanup();
    await openDm({ state: personalState() });
    expect(side()).toBeTruthy();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  });

  test("in a personal workspace a choice saved before still wins", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    localStorage.setItem(KEY, "1");
    await openDm({ state: personalState() });
    expect(side()).toBeTruthy();
  });

  test("a narrow window: closed at first, it floats over the chat with its scrim, and nothing is saved", async () => {
    widthIs(DM_SIDE_NARROW_QUERY);
    await openDm();
    expect(side()).toBeNull();
    await act(async () => fireEvent.click(toggle() as HTMLElement));
    const float = side() as HTMLElement;
    expect(float.classList.contains("dm-side--float")).toBe(true);
    expect(float.parentElement?.querySelector(":scope > .thread-panel__scrim")).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBeNull();
    await act(async () => fireEvent.click(within(float).getByRole("button", { name: "Fechar" })));
    expect(side()).toBeNull();
  });

  test("sits under the header, in the members' place, and stays under the agent's page floating over it", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await openDm();
    const body = screen().getByRole("main").querySelector(":scope > .channel__body") as HTMLElement;
    const column = side();
    expect(body.lastElementChild).toBe(column);
    const header = screen().getByRole("main").querySelector(".channel__header") as HTMLElement;
    await act(async () => fireEvent.click(within(header).getByRole("button", { name: "Perfil de Ada" })));
    await settle(6);
    const page = document.querySelector(".thread-panel--wide") as HTMLElement;
    expect(page).toBeTruthy();
    expect(side()).toBe(column);
    expect(column?.closest("[inert]")).toBeTruthy();
    await act(async () => fireEvent.click(document.querySelector(".thread-panel__scrim") as HTMLElement));
    await settle(6);
    expect(document.querySelector(".thread-panel--wide")).toBeNull();
    expect(side()).toBe(column);
  });

  test("no sidebar in a DM with a person", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const api = createFakeApi(seedState());
    await renderApp(`/org/${ORG_ID}/dm/person/${OTHER}`, { api });
    await settle(10);
    expect(toggle()).toBeNull();
    expect(side()).toBeNull();
  });
});

describe("what the viewer sees", () => {
  test("whoever may watch: the picture, Assumir o controle, the eye", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const { calls } = await openDm();
    const computer = section("Computador") as HTMLElement;
    expect(computer.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,c2NyZWVu");
    expect(computer.textContent).toContain("Agora há pouco");
    expect(computer.textContent).not.toContain("Ao vivo");
    expect(within(computer).getByRole("button", { name: "Assumir o controle" })).toBeTruthy();
    expect(within(computer).getByRole("button", { name: "Assistir" })).toBeTruthy();
    expect(calls).toHaveBeenCalled();
  });

  test("who may not watch gets no computer at all, and no picture is asked", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const { calls } = await openDm({ forbidden: true });
    expect(side()).toBeTruthy();
    expect(section("Computador")).toBeNull();
    expect(calls).not.toHaveBeenCalled();
  });

  test("who may not take control can still watch: one Assistir, no Assumir", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await openDm({ desktop: { available: true, reason: null, running: true, canControl: false } });
    const computer = section("Computador") as HTMLElement;
    expect(within(computer).queryByRole("button", { name: "Assumir o controle" })).toBeNull();
    expect(within(computer).getByRole("button", { name: "Assistir" }).textContent).toContain("Assistir");
  });

  test("a stopped screen is never asked for: the calm line, and watching turns it on", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const { calls } = await openDm({ desktop: { available: true, reason: null, running: false } });
    const computer = section("Computador") as HTMLElement;
    expect(calls).not.toHaveBeenCalled();
    expect(computer.querySelector("img")).toBeNull();
    expect(computer.textContent).toContain("A tela está desligada");
    expect(within(computer).getByRole("button", { name: "Assistir" })).toBeTruthy();
  });

  test("the public card's viewer: only the head", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.ownerUserId = OTHER;
      ada.audience = { mode: "owner", userIds: [] };
      ada.seesDetails = false;
    }
    await openDm({ state });
    const aside = side() as HTMLElement;
    expect(within(aside).getByRole("heading", { name: "Ada" })).toBeTruthy();
    expect(aside.querySelectorAll(".dm-side__sec")).toHaveLength(0);
    // Its head has no computer, so one who may still watch keeps the header's way in.
    expect(screen().queryByRole("button", { name: "Computador" })).toBeTruthy();
  });

  test("its right hand: no computer of its own, the viewer's plan for it", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const state = withRightHand(seedState());
    const lodi = state.agents.find((a) => a.builtin === "right_hand");
    await openDm({ state, agentId: lodi?.id ?? "" });
    expect(section("Computador")).toBeNull();
    expect(section("Como pensa")).toBeTruthy();
    // One role name, the sidebar's and its header's: never a second one in its panel.
    expect((side() as HTMLElement).querySelector(".dm-side__role")?.textContent).toBe("Seu braço direito");
    expect(side()?.textContent).not.toContain("Assistente do workspace");
  });

  test("on Automático it is named by the maker of the key it thinks with, in its panel and its header", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.model = "auto";
    state.aiStatus = {
      any: true,
      agents: state.agents.map((a) => ({ agentId: a.id, state: "ready" as const, provider: "anthropic" })),
    };
    await openDm({ state });
    expect(section("Como pensa")?.textContent).toContain("Claude");
    expect(section("Como pensa")?.textContent).not.toContain("Automático");
    expect(document.querySelector(".channel__header .channel__brain")?.textContent).toBe("Claude");
  });

  test("routines: a switch for who may change one, read-only for who may not, at most three, with the count", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const seed = (name: string, api: ApiClient) =>
      api.routines.create(ORG_ID, {
        name,
        agentId: ADA_ID,
        prompt: "Poste o resumo.",
        target: { type: "channel", channelId: ENG_ID },
        trigger: { type: "schedule", phrase: "toda segunda às 9h" },
      } as never);
    await openDm({
      prepare: async (api) => {
        const before = (await api.routines.list(ORG_ID)).filter((r) => r.agentId === ADA_ID);
        const list = api.routines.list;
        await seed("Bom dia", api);
        await seed("Faltas", api);
        await seed("Cobrar", api);
        await seed("Fechar o mês", api);
        for (const r of before) await api.routines.remove(ORG_ID, r.id);
        api.routines.list = async (orgId) =>
          (await list(orgId)).map((r) => (r.name === "Faltas" ? { ...r, canManage: false } : r));
      },
    });
    const rows = section("Rotinas") as HTMLElement;
    expect(rows.querySelector(".ac-grouphead__count")?.textContent).toBe("4");
    const switches = within(rows).getAllByRole("switch") as HTMLButtonElement[];
    expect(switches.map((s) => s.disabled)).toEqual([false, true, false]);
    expect(within(rows).getByRole("link", { name: "Ver todas" }).getAttribute("href")).toContain("/routines");
  });

  test("como pensa and the recent tasks: model, owner, this month; the agent's latest tasks", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await openDm({
      prepare: async (api) => {
        await api.issues.create(ORG_ID, {
          title: "Relatório de faltas",
          assignee: { type: "agent", id: ADA_ID },
        } as never);
      },
    });
    const thinks = section("Como pensa") as HTMLElement;
    expect(thinks.textContent).toContain("Pensa com");
    expect(thinks.textContent).toContain("Responsável");
    const tasks = section("Tarefas recentes") as HTMLElement;
    expect(within(tasks).getByRole("link", { name: /Relatório de faltas/ })).toBeTruthy();
  });
});

describe("Como pensa", () => {
  const thinks = async (speed?: "fast") => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "codex", model: "GPT-6.1 Sol", ...(speed ? { speed } : {}) };
    await openDm({ state });
    return (section("Como pensa") as HTMLElement).textContent;
  };

  test("says Rápida next to the model when that is its speed, and nothing at the standard one", async () => {
    expect(await thinks("fast")).toMatch(/GPT-6\.1 Sol pelo plano do ChatGPT.* · Rápida/);
    cleanup();
    expect(await thinks()).not.toContain("Rápida");
  });
});

describe("the picture's refresh", () => {
  test("only while the sidebar shows in a focused window, of a screen that runs", () => {
    const on = { available: true, running: true };
    expect(asksPicture(true, on)).toBe(true);
    expect(asksPicture(false, on)).toBe(false);
    expect(asksPicture(true, { available: true, running: false })).toBe(false);
    expect(asksPicture(true, { available: false, running: false })).toBe(false);
    expect(asksPicture(true, null)).toBe(false);
  });

  test("every few seconds while it works there, backed off when idle or when it shows no picture", () => {
    const picture = { data: "x", width: 1, height: 1, capturedAt: "2026-11-05T12:00:00Z" };
    expect(pictureRefreshMs(true, { picture, reason: null })).toBe(PICTURE_WORKING_MS);
    expect(pictureRefreshMs(false, { picture, reason: null })).toBe(PICTURE_IDLE_MS);
    expect(pictureRefreshMs(true, { picture: null, reason: "hidden" })).toBe(PICTURE_IDLE_MS);
    expect(pictureRefreshMs(true, undefined)).toBe(PICTURE_IDLE_MS);
  });

  test("a window out of focus asks nothing more", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const focus = spyOn(document, "hasFocus").mockReturnValue(false);
    const { calls } = await openDm();
    focus.mockRestore();
    expect(calls).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle(6);
    expect(calls).toHaveBeenCalled();
  });

  test("a window that loses the focus keeps the last picture: only the asking stops", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await openDm();
    const shown = () => (side() as HTMLElement).querySelector(".dm-side__screen img");
    expect(shown()).toBeTruthy();
    const focus = spyOn(document, "hasFocus").mockReturnValue(false);
    await act(async () => window.dispatchEvent(new Event("blur")));
    await settle(2);
    expect(shown()).toBeTruthy();
    focus.mockRestore();
  });

  test("its label: never live; a recent one says so, an older one its time", () => {
    const t = ((k: string) => k) as never;
    const now = new Date(2026, 10, 5, 12, 0, 30);
    expect(pictureWhen(t, "pt-BR", new Date(2026, 10, 5, 12, 0, 0).toISOString(), now)).toBe(
      "agentComputer.pictureNow",
    );
    expect(pictureWhen(t, "pt-BR", new Date(2026, 10, 5, 11, 40, 0).toISOString(), now)).toContain("11:40");
  });
});
