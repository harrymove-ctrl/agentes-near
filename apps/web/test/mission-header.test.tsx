import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { MachineTask, Mission } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const task = (id: string, status: MachineTask["status"], title: string, missionId: string): MachineTask => ({
  id,
  agentId: ADA_ID,
  machineId: "machine_1",
  channelId: ENG_ID,
  threadId: "root-app",
  missionId,
  title,
  executor: "claude",
  status,
  exitCode: status === "failed" ? 1 : status === "done" ? 0 : null,
  seconds: 90,
  lastLine: status === "running" ? "Rodando os testes" : "Pronto",
  files: status === "done" ? ["app/index.tsx"] : [],
  branch: null,
  cwd: null,
  resumedFromId: null,
  resumedTaskId: null,
  startedAt: new Date(Date.now() - 90_000).toISOString(),
  endedAt: status === "running" ? null : new Date().toISOString(),
  lastEventAt: new Date().toISOString(),
  createdAt: new Date(Date.now() - 90_000).toISOString(),
});

async function missionThread(patch: Partial<Mission> = {}, only?: MachineTask["status"][]) {
  const state = seedState();
  const api = createFakeApi(state);
  const mission = await api.missions.create(ORG_ID, {
    agentId: ADA_ID,
    goal: "App mobile",
    title: "App mobile",
    channelId: ENG_ID,
    threadId: "root-app",
  });
  state.messages.push({
    id: "root-app",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: "Vamos fazer o app mobile",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {},
    createdAt: new Date().toISOString(),
  });
  await api.threads.create(ORG_ID, {
    id: "root-app",
    channelId: ENG_ID,
    firstMessageId: "root-app",
    lastMessageId: "root-app",
    title: "App mobile",
    mission: { id: mission.id, agentId: ADA_ID, status: "active", planDone: 1, planTotal: 3, waitingYou: 0 },
  } as Parameters<typeof api.threads.create>[1]);
  const live: Mission = {
    ...mission,
    status: "active",
    startedAt: new Date().toISOString(),
    plan: {
      version: 1,
      done: 1,
      total: 3,
      waiting: 0,
      doing: 1,
      items: [
        { id: "i1", title: "Telas", status: "done" },
        { id: "i2", title: "Login", status: "doing" },
        { id: "i3", title: "Fotos", status: "todo" },
      ],
    },
    ...patch,
  };
  api.missions.ofThread = async () => ({ ...live });
  api.missions.get = async () => ({ ...live });
  const tasks = [
    task("t1", "running", "Login com e-mail", mission.id),
    task("t2", "done", "Telas iniciais", mission.id),
    task("t3", "failed", "Build do iOS", mission.id),
  ];
  const shown = only ? tasks.filter((x) => only.includes(x.status)) : tasks;
  api.missions.threadTasks = async () => shown.map((x) => ({ ...x }));
  await renderApp(`/org/${ORG_ID}/threads/root-app`, { api });
  await settle(10);
  return { api, mission: live };
}

const theHeader = () => {
  const header = document.querySelector("header.mh") as HTMLElement;
  expect(header).toBeTruthy();
  return header;
};

describe("a mission's thread: the header is the mission's", () => {
  test("title once, state, who programs, 'Missão · #eng', the strip, what runs, sessions; no floating card", async () => {
    await missionThread();
    const header = theHeader();
    expect(within(header).getAllByText("App mobile")).toHaveLength(1);
    expect(within(header).getByRole("heading", { level: 1, name: "App mobile" })).toBeTruthy();
    expect(header.textContent).toContain("Missão · #eng");
    expect(header.textContent).not.toContain("mensagem direta");
    expect(header.textContent).toContain("Claude Code");
    expect(header.textContent).toContain("1 de 3 itens");
    expect(header.textContent).toContain("1 rodando");
    // The running pill is the agent's pixel orbit, not a ring or a pause icon.
    expect(header.querySelector(".mh__strip canvas.ac-pixspin")).toBeTruthy();
    expect(within(header).getByRole("button", { name: /3 sessões/ })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Arquivos" })).toBeTruthy();
    expect(document.querySelector(".mi-pinned")).toBeNull();
  });

  test("a long title wraps whole: its state after its words, the header's buttons under them as one group", async () => {
    const long = "Migrar o checkout para o novo provedor de pagamentos com reembolso automático";
    await missionThread({ title: long });
    const header = theHeader();
    expect(within(header).getByRole("heading", { level: 1, name: long })).toBeTruthy();
    const line = header.querySelector(".mh__row > .mh__main.ac-actline") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.firstElementChild?.matches(".mh__text")).toBe(true);
    expect(line.lastElementChild?.matches(".mh__end")).toBe(true);
    // The title is the heading's whole name: no tooltip stands in for words cut short.
    expect(header.querySelector(".mh__title")?.hasAttribute("title")).toBe(false);
  });

  test("nothing running: no 'nada rodando' pill (it read as paused), no orbit", async () => {
    await missionThread({ runningTasks: 0 }, ["done"]);
    const header = theHeader();
    expect(header.textContent).not.toContain("nada rodando");
    expect(header.textContent).not.toContain("rodando");
    expect(header.querySelector(".mh__strip canvas.ac-pixspin")).toBeNull();
  });

  test("no computer: the owner's note, its icon on the words' line and Escolher computador beside it", async () => {
    await missionThread({ needsComputer: true, role: "owner" });
    const header = theHeader();
    const note = header.querySelector(".mh__note") as HTMLElement;
    expect(note.textContent).toContain("A missão ficou sem computador");
    // The button sits outside the words' line, so the note centres it on them.
    const line = note.querySelector(".ac-iconline") as HTMLElement;
    expect(line.firstElementChild?.matches("svg.ac-icon")).toBe(true);
    expect(line.textContent).toContain("A missão ficou sem computador");
    const choose = within(note).getByRole("button", { name: "Escolher computador" });
    expect(line.contains(choose)).toBe(false);
  });

  test("N sessões opens the sessions dialog: filters with counts, a session opens O que mudou and Ver saída", async () => {
    await missionThread();
    const header = theHeader();
    await act(async () => fireEvent.click(within(header).getByRole("button", { name: /3 sessões/ })));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Sessões" });
    expect(dialog.textContent).toContain("Missão · App mobile");
    const filters = within(dialog).getByRole("radiogroup", { name: "Mostrar sessões" });
    expect(within(filters).getByRole("radio", { name: /Rodando/ }).textContent).toContain("1");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
    await act(async () => fireEvent.click(within(filters).getByRole("radio", { name: /Falharam/ })));
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    expect(dialog.textContent).toContain("Build do iOS");
    await act(async () => fireEvent.click(within(filters).getByRole("radio", { name: /Concluídas/ })));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Telas iniciais/ })));
    expect(dialog.textContent).toContain("O que mudou");
    expect(dialog.textContent).toContain("app/index.tsx");
    expect(within(dialog).getByRole("button", { name: "Ver saída" })).toBeTruthy();
  });
});
