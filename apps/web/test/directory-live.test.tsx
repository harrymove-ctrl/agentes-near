import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { COMPACT_QUERY, DESKTOP_QUERY } from "@/components/NavDrawer";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;

afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  setSystemTime();
  localStorage.clear();
});

const VENDAS_ID = "c-vendas";

/** What Lodi leaves behind: an agent and a channel with it inside, written on the server. */
function lodiMakes(state: FakeState) {
  const base = state.agents[0] as (typeof state.agents)[number];
  state.agents.push({ ...base, id: "a-iara", name: "Iara", handle: "iara", role: "Vendas" });
  state.channels.push({
    id: VENDAS_ID,
    name: "vendas",
    topic: "",
    visibility: "public",
    isMember: true,
    createdAt: new Date().toISOString(),
  });
  state.channelMembers[VENDAS_ID] = [
    { type: "person", id: "u-walter" },
    { type: "agent", id: "a-iara" },
  ];
}

async function open(state: FakeState = seedState(), path = `/org/${ORG_ID}/c/${ENG_ID}`, width = DESKTOP_QUERY) {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === width,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const api = createFakeApi(state);
  const agentReads = spyOn(api.agents, "list");
  const dmReads = spyOn(api.dms, "list");
  const r = await renderApp(path, { api });
  await settle(6);
  await act(async () => r.sockets.last().open());
  await settle(4);
  const orgEvent = async (type: string) => {
    await act(async () => r.sockets.last().push({ type: "event", scope: "org", event: { type } }));
    await settle(6);
  };
  return { ...r, state, api, agentReads, dmReads, orgEvent };
}

/** Past the gap between two reads of a list: what a burst left for its end has been read. */
const gapEnds = async () => {
  await act(() => new Promise((r) => setTimeout(r, 600)));
  await settle(6);
};

const column = (channel: string) => screen().queryByRole("complementary", { name: `Membros de #${channel}` });
const memberNames = (channel: string) =>
  [...(column(channel)?.querySelectorAll(".members-side__label") ?? [])].map((l) => l.textContent);
const rows = () => [...document.querySelectorAll<HTMLAnchorElement>("a.sidebar__item")];
const label = (a: HTMLAnchorElement) => a.querySelector(".sidebar__item-label")?.textContent?.trim().replace(/^#/, "");
const channelLink = (name: string) => rows().find((a) => label(a) === name);
const sidebarText = () => screen().getByRole("navigation", { name: "Navegação do workspace" }).textContent;
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;

describe("Lodi made agents and channels while the app was open", () => {
  test("the sidebar lists the channel by itself, and its column has the new agent, on opening it", async () => {
    const app = await open();
    expect(channelLink("vendas")).toBeUndefined();
    lodiMakes(app.state);
    await app.orgEvent("agents.changed");
    await app.orgEvent("channels.changed");
    const link = channelLink("vendas");
    expect(link).toBeTruthy();
    await act(async () => fireEvent.click(link as HTMLAnchorElement));
    await settle(8);
    expect(memberNames("vendas")).toContain("Iara");
    expect(screen().getByRole("button", { name: "Membros do canal (2)" })).toBeTruthy();
  });

  test("the sidebar hears of the channel from Lodi's receipt while the agent list stays old", async () => {
    const app = await open();
    lodiMakes(app.state);
    const receipt = {
      type: "message.actions",
      channelId: ENG_ID,
      messageId: "m-none",
      actions: [{ kind: "channel.created" }],
    };
    await act(async () => app.sockets.last().push({ type: "event", channelId: ENG_ID, event: receipt }));
    await settle(6);
    const before = app.agentReads.mock.calls.length;
    await act(async () => fireEvent.click(channelLink("vendas") as HTMLAnchorElement));
    await settle(8);
    expect(memberNames("vendas")).toContain("Iara");
    expect(app.agentReads.mock.calls.length).toBe(before + 1);
  });

  test("an id nobody can name reads the directory once, not on every read of the list", async () => {
    const app = await open();
    app.state.channelMembers[ENG_ID]?.push({ type: "agent", id: "a-nobody" });
    const before = app.agentReads.mock.calls.length;
    await app.orgEvent("channels.changed");
    await app.orgEvent("channels.changed");
    await app.orgEvent("channels.changed");
    expect(app.agentReads.mock.calls.length).toBe(before + 1);
  });

  test("the channel is already open when its agents join", async () => {
    const app = await open();
    const base = app.state.agents[0] as (typeof app.state.agents)[number];
    app.state.agents.push({ ...base, id: "a-iara", name: "Iara", handle: "iara" });
    app.state.channelMembers[ENG_ID]?.push({ type: "agent", id: "a-iara" });
    await app.orgEvent("channels.changed");
    expect(memberNames("eng")).toContain("Iara");
    expect(screen().getByRole("button", { name: "Membros do canal (5)" })).toBeTruthy();
  });
});

describe("what changes elsewhere shows everywhere, without a reload", () => {
  test("a renamed agent: the column, the sidebar's Agentes and the @ suggestions", async () => {
    const app = await open();
    const ada = app.state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.name = "Ada Lima";
    await app.orgEvent("agents.changed");
    expect(memberNames("eng")).toContain("Ada Lima");
    expect(memberNames("eng")).not.toContain("Ada");
    expect(sidebarText()).toContain("Ada Lima");
    await act(async () => {
      fireEvent.change(composer(), { target: { value: "@ada", selectionStart: 4, selectionEnd: 4 } });
    });
    await settle(4);
    expect(screen().getAllByRole("option")[0]?.textContent).toContain("Ada Lima");
  });

  test("an archived agent leaves the column, the header's count and Agentes", async () => {
    const app = await open();
    app.state.agents = app.state.agents.filter((a) => a.id !== ADA_ID);
    app.state.channelMembers[ENG_ID] = (app.state.channelMembers[ENG_ID] ?? []).filter((m) => m.id !== ADA_ID);
    await app.orgEvent("agents.changed");
    await app.orgEvent("channels.changed");
    expect(memberNames("eng")).not.toContain("Ada");
    expect(screen().getByRole("button", { name: "Membros do canal (3)" })).toBeTruthy();
    expect(sidebarText()).not.toContain("Ada");
  });

  test("a channel archived or renamed elsewhere changes in the sidebar", async () => {
    const app = await open();
    app.state.channels = app.state.channels.map((c) => (c.name === "general" ? { ...c, name: "geral" } : c));
    await app.orgEvent("channels.changed");
    expect(channelLink("geral")).toBeTruthy();
    app.state.channels = app.state.channels.filter((c) => c.name !== "geral");
    await app.orgEvent("channels.changed");
    await gapEnds();
    expect(channelLink("geral")).toBeUndefined();
  });

  test("the phone-width members sheet, open when an agent joins", async () => {
    const app = await open(seedState(), `/org/${ORG_ID}/c/${ENG_ID}`, COMPACT_QUERY);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Membros do canal (4)" })));
    await settle(2);
    const base = app.state.agents[0] as (typeof app.state.agents)[number];
    app.state.agents.push({ ...base, id: "a-iara", name: "Iara", handle: "iara" });
    app.state.channelMembers[ENG_ID]?.push({ type: "agent", id: "a-iara" });
    await app.orgEvent("channels.changed");
    const sheet = screen().getByRole("dialog", { name: "Membros de #eng" });
    expect(sheet.textContent).toContain("Iara");
  });

  test("Agentes e acesso: a new agent gets its row, a renamed one its name", async () => {
    const app = await open(seedState(), `/org/${ORG_ID}/settings/access`);
    const base = app.state.agents[0] as (typeof app.state.agents)[number];
    app.state.agents.push({ ...base, id: "a-iara", name: "Iara", handle: "iara" });
    const ada = app.state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.name = "Ada Lima";
    await app.orgEvent("agents.changed");
    const matrix = screen().getByRole("region", { name: "Acesso dos agentes" });
    expect(matrix.textContent).toContain("Iara");
    expect(matrix.textContent).toContain("Ada Lima");
  });

  test("a DM names its agent as it is now", async () => {
    const state = withRightHand(seedState());
    const dmId = seedDm(state, { type: "agent", id: ADA_ID });
    const app = await open(state, `/org/${ORG_ID}/c/${dmId}`);
    const before = app.dmReads.mock.calls.length;
    const dm = app.state.dms.find((d) => d.channelId === dmId);
    if (dm) dm.with.name = "Ada Lima";
    const ada = app.state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.name = "Ada Lima";
    await app.orgEvent("agents.changed");
    expect(app.dmReads.mock.calls.length).toBeGreaterThan(before);
    expect(screen().getByRole("combobox", { name: /Ada Lima/ })).toBeTruthy();
  });

  test("the first agent to join an empty channel: the composer's suggestions speak to it", async () => {
    const state = seedState();
    state.messages = state.messages.filter((m) => m.channelId !== ENG_ID);
    state.channelMembers[ENG_ID] = (state.channelMembers[ENG_ID] ?? []).filter((m) => m.type === "person");
    const app = await open(state);
    expect(document.body.textContent).not.toContain("@Ada ");
    app.state.channelMembers[ENG_ID] = [...(app.state.channelMembers[ENG_ID] ?? []), { type: "agent", id: ADA_ID }];
    await app.orgEvent("channels.changed");
    expect(document.body.textContent).toContain("@Ada ");
  });
});

describe("a burst is a read at once and a read when it ends, on any screen", () => {
  test("ten agents made one after the other, each joining the open channel", async () => {
    const app = await open();
    const memberReads = spyOn(app.api.chat, "members");
    const agents = app.agentReads.mock.calls.length;
    const dms = app.dmReads.mock.calls.length;
    const base = app.state.agents[0] as (typeof app.state.agents)[number];
    for (let i = 0; i < 10; i++) {
      const id = `a-new-${i}`;
      app.state.agents.push({ ...base, id, name: `Novo ${i}`, handle: `novo${i}` });
      app.state.channelMembers[ENG_ID]?.push({ type: "agent", id });
      const joined = { type: "channel.member_added", channelId: ENG_ID, member: { type: "agent", id } };
      await act(async () => {
        const socket = app.sockets.last();
        socket.push({ type: "event", scope: "org", event: { type: "agents.changed" } });
        socket.push({ type: "event", scope: "org", event: { type: "channels.changed" } });
        socket.push({ type: "event", channelId: ENG_ID, event: joined });
      });
      await settle(1);
    }
    await gapEnds();
    expect(app.agentReads.mock.calls.length).toBeLessThanOrEqual(agents + 2);
    expect(app.dmReads.mock.calls.length).toBeLessThanOrEqual(dms + 2);
    expect(memberReads.mock.calls.length).toBeLessThanOrEqual(4);
    expect(memberNames("eng")).toContain("Novo 9");
  });
});

describe("what happened while nobody could hear", () => {
  test("a reconnect reads the agents and the channels again", async () => {
    const app = await open();
    await act(async () => app.sockets.last().drop());
    lodiMakes(app.state);
    await act(() => new Promise((r) => setTimeout(r, 1200)));
    await act(async () => app.sockets.last().open());
    await settle(8);
    expect(channelLink("vendas")).toBeTruthy();
    expect(app.agentReads.mock.calls.length).toBeGreaterThan(1);
  });

  test("a reconnect names who joined the workspace meanwhile", async () => {
    const app = await open();
    const readsOfPeople = spyOn(app.api.orgs, "members");
    await act(async () => app.sockets.last().drop());
    await act(() => new Promise((r) => setTimeout(r, 1200)));
    await act(async () => app.sockets.last().open());
    await settle(8);
    expect(readsOfPeople.mock.calls.length).toBeGreaterThan(0);
  });

  test("back to a tab hidden for a while: the same, with the socket still up", async () => {
    const app = await open();
    lodiMakes(app.state);
    const hide = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      window.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    };
    await act(async () => hide("hidden"));
    setSystemTime(new Date(Date.now() + 60_000));
    await act(async () => hide("visible"));
    await settle(8);
    expect(channelLink("vendas")).toBeTruthy();
  });

  test("nothing polls: an idle app reads no list by itself", async () => {
    const app = await open();
    const before = app.agentReads.mock.calls.length;
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
    expect(app.agentReads.mock.calls.length).toBe(before);
  });
});
