import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { MachineOutages } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, fakeMachinesOf, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const MAC = "00000000-0000-4000-8000-0000000009aa";
const PRO = "00000000-0000-4000-8000-0000000009bb";
const PC = "00000000-0000-4000-8000-0000000009cc";

const click = (el: Element) => act(async () => fireEvent.click(el));
const orgEvent = (event: Record<string, unknown>) => ({ type: "event", scope: "org", event });

function outages(): MachineOutages {
  return {
    outages: [
      {
        machineId: MAC,
        name: "MacBook Air",
        platform: "darwin",
        offlineSince: new Date(Date.now() - 12 * 60_000).toISOString(),
        agents: [
          { agentId: ADA_ID, name: "Ada", brain: "claude_code", waiting: { routines: 2, conversations: 0 } },
          { agentId: ATLAS_ID, name: "Atlas", brain: "claude_code", waiting: { routines: 0, conversations: 1 } },
        ],
        waitingRuns: 3,
      },
    ],
    targets: [
      {
        kind: "machine",
        machineId: PRO,
        name: "MacBook Pro do Walter",
        platform: "darwin",
        online: true,
        brains: ["claude_code"],
        reasonOff: null,
      },
      {
        kind: "machine",
        machineId: PC,
        name: "PC do escritório",
        platform: "windows",
        online: false,
        brains: ["claude_code"],
        reasonOff: "offline",
      },
      {
        kind: "machine",
        machineId: "00000000-0000-4000-8000-0000000009dd",
        name: "Servidor",
        platform: "linux",
        online: true,
        brains: ["codex"],
        reasonOff: null,
      },
    ],
  };
}

function setup(data: MachineOutages = outages()) {
  const state = seedState();
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setOutages(data);
  return { state, api };
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("an offline computer: the notice", () => {
  test("shows who waits and what stopped, and opens the dialog", async () => {
    const { api } = setup();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const notice = screen().getByRole("region", { name: "Computadores desconectados" });
    expect(notice.textContent).toContain("O MacBook Air desconectou há 12 min");
    expect(notice.textContent).toContain("Ada e Atlas esperam por ele · 3 tarefas paradas");
    expect(within(notice).getByRole("link", { name: "Ver computador" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/devices/${MAC}`,
    );
    await click(within(notice).getByRole("button", { name: "Trocar computador" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Trocar o computador" });
    expect(dialog.textContent).toContain(
      "O MacBook Air está desconectado. Escolha onde Ada e Atlas passam a trabalhar.",
    );
    expect(dialog.textContent).toContain("Dá para voltar ao MacBook Air depois.");
  });

  test("the Cloud's computer stopped answering: it is looked after, and there is no other computer to switch to", async () => {
    const data = outages();
    const first = data.outages[0];
    if (!first) throw new Error("no outage");
    data.outages = [{ ...first, name: "Computador da Acme", platform: "other", managed: true }];
    const { api } = setup(data);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready" });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const notice = screen().getByRole("region", { name: "Computadores desconectados" });
    expect(notice.textContent).toContain("O Computador da Acme parou de responder há 12 min");
    // That it is looked after, in one part of the dotted line.
    expect(notice.textContent).toContain("Já estamos cuidando · Ada e Atlas esperam por ele");
    expect(notice.textContent).not.toContain("nada a fazer");
    expect(notice.textContent).not.toContain("desconectou");
    expect(within(notice).queryByRole("button", { name: "Trocar computador" })).toBeNull();
  });

  test("closing it is remembered until that computer comes back", async () => {
    const { api } = setup();
    const first = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Fechar aviso" }));
    expect(screen().queryByRole("region", { name: "Computadores desconectados" })).toBeNull();
    first.unmount();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    expect(screen().queryByRole("region", { name: "Computadores desconectados" })).toBeNull();
  });
});

describe("realtime", () => {
  test("agents moved elsewhere (machine.agents_moved): the notice goes away", async () => {
    const { api } = setup();
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    expect(screen().getByRole("region", { name: "Computadores desconectados" })).toBeTruthy();
    fakeMachinesOf.get(api)?.setOutages({ outages: [], targets: [] });
    const target = { kind: "machine", machineId: PRO };
    const moved = orgEvent({ type: "machine.agents_moved", machineId: MAC, agentIds: [ADA_ID], target });
    await act(async () => sockets.last().push(moved));
    await settle(8);
    expect(screen().queryByRole("region", { name: "Computadores desconectados" })).toBeNull();
  });
});

describe("Trocar o computador", () => {
  test("every other computer, offline and other brains disabled with why; sends the body", async () => {
    const { api, state } = setup();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Trocar computador" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Trocar o computador" });
    const group = within(dialog).getByRole("radiogroup", { name: "Novo computador" });
    const rows = within(group).getAllByRole("radio");
    const row = (name: string) => rows.find((r) => r.textContent?.includes(name)) as HTMLElement;
    expect(row("MacBook Pro do Walter").getAttribute("aria-checked")).toBe("true");
    expect(row("MacBook Pro do Walter").hasAttribute("disabled")).toBe(false);
    expect(row("PC do escritório").hasAttribute("disabled")).toBe(true);
    expect(row("PC do escritório").textContent).toContain("Desconectado agora");
    expect(row("Servidor").hasAttribute("disabled")).toBe(true);
    // Who switches: both checked, with what waits.
    expect(dialog.textContent).toContain("2 rotinas esperando");
    expect(dialog.textContent).toContain("1 conversa esperando");
    await click(within(dialog).getByRole("checkbox", { name: "Atlas" }));
    await click(within(dialog).getByRole("button", { name: "Trocar 1 agente" }));
    await settle(4);
    const call = state.calls.find((c) => c.method === "machines.moveAgents");
    expect(call?.args).toEqual([ORG_ID, MAC, { agentIds: [ADA_ID], target: { kind: "machine", machineId: PRO } }]);
    expect(screen().queryByRole("dialog", { name: "Trocar o computador" })).toBeNull();
    expect(document.body.textContent).toContain("Ada agora usa MacBook Pro do Walter.");
  });
});

describe("in the chat and the sidebar", () => {
  function withNotice(state: ReturnType<typeof seedState>) {
    const base = state.messages[0] as (typeof state.messages)[number];
    state.messages.push({
      ...base,
      id: "m-wait",
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Claude Code is offline. I'll answer when it's back.",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        bodyCode: "brain_unavailable",
        bodyParams: { brain: "Claude Code" },
        brainUnavailable: { brain: "claude_code", code: "machine_offline", machineId: MAC, agentId: ADA_ID },
      },
      createdAt: new Date().toISOString(),
    });
  }

  test("the notice becomes the waiting pill, then a decided one saying the computer is back", async () => {
    const { api, state } = setup();
    withNotice(state);
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const card = document.querySelector(".rq-open") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Esperando o MacBook Air voltar");
    expect(card.textContent).toContain(
      "O Claude Code roda nele. Sigo daqui assim que ele voltar · 2 rotinas esperando",
    );
    expect(within(card).getByRole("button", { name: "Trocar computador" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("não está disponível agora");
    // It comes back: no outage anymore.
    fakeMachinesOf.get(api)?.setOutages({ outages: [], targets: [] });
    await act(async () => sockets.last().push(orgEvent({ type: "machine.status", machineId: MAC, online: true })));
    await settle(8);
    expect(document.querySelector(".rq-open")).toBeNull();
    const back = [...document.querySelectorAll<HTMLElement>(".rq-done")].find((e) =>
      e.textContent?.includes("O MacBook Air voltou"),
    ) as HTMLElement;
    expect(back.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    expect(within(back).queryByRole("button")).toBeNull();
    expect(screen().queryByRole("region", { name: "Computadores desconectados" })).toBeNull();
  });

  test("on the Cloud the card offers no switch: its workspace has one computer", async () => {
    const { api, state } = setup();
    withNotice(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready" });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const card = document.querySelector(".rq-open") as HTMLElement;
    expect(card.textContent).toContain("Esperando o MacBook Air voltar");
    expect(within(card).queryByRole("button", { name: "Trocar computador" })).toBeNull();
  });

  test("while the edition isn't known nothing offers a switch; a self-hosted server says so from boot", async () => {
    const { api, state } = setup();
    withNotice(state);
    // The workspace's setup never answers, and the server's config doesn't say.
    api.machines.computerSetup = () => new Promise(() => {});
    const first = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const card = document.querySelector(".rq-open") as HTMLElement;
    expect(card.textContent).toContain("Esperando o MacBook Air voltar");
    expect(within(card).queryByRole("button", { name: "Trocar computador" })).toBeNull();
    const notice = screen().getByRole("region", { name: "Computadores desconectados" });
    expect(within(notice).queryByRole("button", { name: "Trocar computador" })).toBeNull();
    first.unmount();

    state.authConfig = { ...state.authConfig, workspaceComputer: false };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const again = document.querySelector(".rq-open") as HTMLElement;
    expect(within(again).getByRole("button", { name: "Trocar computador" })).toBeTruthy();
    const shown = screen().getByRole("region", { name: "Computadores desconectados" });
    expect(within(shown).getByRole("button", { name: "Trocar computador" })).toBeTruthy();
  });

  test("a waiting agent's sidebar row says 'esperando', not working", async () => {
    const { api, state } = setup();
    seedDm(state, { type: "agent", id: ADA_ID });
    seedDm(state, { type: "agent", id: ATLAS_ID });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const rows = [...document.querySelectorAll(".sidebar__waiting")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe("esperando");
    expect(rows[0]?.getAttribute("title")).toBe("Esperando o MacBook Air");
  });
});
