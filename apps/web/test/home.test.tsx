import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  type ApiClient,
  keys,
  type Mission,
  type Routine,
  type StartChoice,
  type WorkingRun,
} from "@agenteschat/client";
import { WORKING_POLL_MS } from "@agenteschat/client/lib/working";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { showWorkspace } from "@/lib/start";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { notification } from "./fakes/notifications";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const soon = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const mission = (over: Partial<Mission> = {}): Mission => ({
  id: "mi-1",
  threadId: "t-mission",
  channelId: ENG_ID,
  agentId: ADA_ID,
  ownerId: "u-walter",
  executor: "claude",
  title: "Landing nova",
  goal: "Uma landing nova para o lançamento.",
  findings: [],
  openQuestion: null,
  status: "active",
  repoDir: "",
  resumeTasks: true,
  commandApproval: "low_risk_auto",
  plan: { version: 1, done: 2, total: 5, waiting: 0, doing: 1, items: [] },
  pending: { decisions: 2, provisional: 0, reviews: 0, suggestions: 0, joinRequests: 0, commands: 0 },
  joinRequested: false,
  runningTasks: 1,
  machine: null,
  needsComputer: false,
  role: "owner",
  canAct: true,
  canManage: true,
  createdAt: ago(600),
  startedAt: ago(500),
  pausedAt: null,
  closedAt: null,
  closeReason: null,
  wikiPageId: null,
  ...over,
});

const routine = (over: Partial<Routine> & Pick<Routine, "id" | "name">): Routine => ({
  agentId: ATLAS_ID,
  prompt: "Resume a semana.",
  target: { type: "channel", channelId: ENG_ID },
  trigger: {
    type: "schedule",
    phrase: null,
    rule: { freq: "daily", times: ["18:00"], timezone: "America/Sao_Paulo" },
    cron: "0 18 * * *",
    timezone: "America/Sao_Paulo",
    description: "Todos os dias, às 18:00",
  },
  active: true,
  nextRunAt: soon(90),
  createdAt: ago(60 * 24),
  access: "read",
  report: "when_new",
  pausedReason: null,
  failuresInRow: 0,
  state: "active",
  waitingFor: null,
  brain: { kind: "model", machineName: null },
  health: { ok: 0, silent: 0, failed: 0, skipped: 0, missed: 0, total: 0 },
  canSeeDetails: true,
  canManage: true,
  lastRun: null,
  recentRuns: [],
  usage: { runs: 0, tokens: 0, costNanoUsd: 0, billedTo: "api" },
  ...over,
});

/** The fake backend with what Início reads that it doesn't fill by itself: the runs at work, missions and routines. */
function backend(
  state: FakeState,
  extra: { runs?: WorkingRun[]; waiting?: Mission[]; active?: Mission[]; routines?: Routine[] } = {},
): ApiClient {
  const base = createFakeApi(state);
  return {
    ...base,
    working: { list: async () => structuredClone(extra.runs ?? []) },
    missions: {
      ...base.missions,
      list: async (_orgId, query = {}) => {
        const missions =
          query.status === "waiting_you"
            ? (extra.waiting ?? [])
            : query.status === "active"
              ? (extra.active ?? [])
              : [];
        return structuredClone({
          missions,
          counts: { active: extra.active?.length ?? 0, waitingYou: extra.waiting?.length ?? 0, closed: 0 },
        });
      },
    },
    routines: { ...base.routines, list: async () => structuredClone(extra.routines ?? []) },
  };
}

/** A busy workspace: things waiting on me, an agent at work with its line, one finished, a routine coming. */
function busy() {
  const state = seedState({
    agentStatuses: [
      {
        agentId: ADA_ID,
        presence: "busy",
        status: { by: "self", text: "Revisando o PR #12", kind: null, subject: null, emoji: "🔎", until: null },
        activeAt: ago(0),
      },
      { agentId: ATLAS_ID, presence: "online", status: null, activeAt: ago(3) },
    ],
  });
  state.notifications = [
    notification({
      id: "n-approval",
      kind: "approval",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      source: { approvalId: "ap-merge", channelId: ENG_ID },
      latest: { title: "Publicar o post no LinkedIn", expiresAt: soon(120) },
      updatedAt: ago(5),
    }),
    notification({
      id: "n-question",
      kind: "agent_question",
      waiting: true,
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { channelId: ENG_ID, questionId: "q-1" },
      latest: { text: "Qual tom uso no e-mail?" },
      updatedAt: ago(12),
    }),
    notification({
      id: "n-mention",
      kind: "mention",
      actors: [{ type: "user", id: "u-joao" }],
      source: { channelId: ENG_ID, messageId: "m-1" },
      latest: { text: "@walter olha o deploy" },
      updatedAt: ago(20),
    }),
    notification({
      id: "n-read",
      kind: "mention",
      actors: [{ type: "user", id: "u-joao" }],
      source: { channelId: ENG_ID },
      latest: { text: "Já li essa" },
      readAt: ago(1),
      updatedAt: ago(30),
    }),
    notification({
      id: "n-finished",
      kind: "mission_finished",
      actors: [{ type: "agent", id: ADA_ID }],
      source: { missionId: "mi-old", threadId: "t-old", label: "Corrige o login" },
      updatedAt: ago(90),
    }),
  ];
  const run = (over: Partial<WorkingRun> & Pick<WorkingRun, "runId" | "agentId" | "status">): WorkingRun => ({
    channelId: ENG_ID,
    channelKind: "channel",
    channelName: "eng",
    threadId: null,
    startedAt: ago(3),
    createdAt: ago(3),
    label: null,
    ...over,
  });
  const api = backend(state, {
    runs: [
      run({ runId: "r-ada", agentId: ADA_ID, status: "running", label: "Corrige o login" }),
      // Stopped on my ok: it waits on me, so it isn't "working".
      run({ runId: "r-atlas", agentId: ATLAS_ID, status: "waiting_approval", threadId: "t-2" }),
    ],
    waiting: [mission()],
    routines: [routine({ id: "rt-week", name: "Relatório semanal" })],
  });
  return { state, api };
}

const section = (name: string) => screen().getByRole("region", { name });
const rows = (name: string) => within(section(name)).getAllByRole("listitem");

describe("Início", () => {
  test("what waits on me first, then who works, what got done and what comes next", async () => {
    const { api, state } = busy();
    const { router, services } = await renderApp(`/org/${ORG_ID}/home`, { api });
    await settle(4);
    expect(screen().getByRole("heading", { level: 1 }).textContent).toMatch(/^(Bom dia|Boa tarde|Boa noite), Walter$/);
    expect(document.querySelector(".ac-pagehead__meta")?.textContent).toBe(
      "4 coisas esperando você · 1 agente trabalhando",
    );
    expect(screen().getByRole("navigation", { name: "Navegação do workspace" }).textContent).toContain("Início");

    // Each waiting thing: who and what, the exact request, and its one button. The read mention isn't here.
    const waiting = rows("Esperando você").map((r) => r.textContent ?? "");
    expect(waiting).toHaveLength(4);
    expect(waiting[0]).toContain("Atlas fez uma pergunta");
    expect(waiting[0]).toContain("Qual tom uso no e-mail?");
    expect(waiting[0]).toEndWith("Responder");
    expect(waiting[1]).toContain("Ada pediu uma aprovação");
    expect(waiting[1]).toContain("Publicar o post no LinkedIn");
    expect(waiting[1]).toContain("para decidir");
    expect(waiting[1]).toEndWith("Revisar");
    expect(waiting[2]).toContain("Ada espera você numa missão");
    expect(waiting[2]).toContain("Landing nova");
    expect(waiting[2]).toContain("2 decisões");
    expect(waiting[3]).toContain("João mencionou você");
    expect(waiting[3]).toContain("@walter olha o deploy");
    expect(screen().queryByText("Já li essa")).toBeNull();

    // Ada works, with her own line, where and since when; Atlas waits on me, so he isn't working.
    const working = rows("Trabalhando agora");
    expect(working).toHaveLength(1);
    expect(working[0]?.textContent).toContain("Ada");
    expect(working[0]?.textContent).toContain("🔎 Revisando o PR #12");
    expect(working[0]?.textContent).toContain("#eng · há 3 min");
    expect(
      within(working[0] as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    // Runs start and end in conversations Início doesn't follow: it asks who works again on its own.
    const every = services.queryClient
      .getQueryCache()
      .find({ queryKey: keys.working(ORG_ID) })
      ?.observers.map((o) => o.options.refetchInterval);
    expect(every).toContain(WORKING_POLL_MS);

    const done = rows("Desde a sua última visita");
    expect(done.map((r) => r.textContent)).toEqual([expect.stringContaining("Ada terminou uma missão")]);
    expect(done[0]?.textContent).toContain("Corrige o login");

    const coming = rows("Próximas rotinas");
    expect(coming[0]?.textContent).toContain("Relatório semanal");
    expect(coming[0]?.textContent).toContain("Atlas");
    expect(
      within(coming[0] as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/routines?open=rt-week`);

    // Everything is set up here: no line back to a checklist, no calm line.
    expect(document.querySelector(".home-continue")).toBeNull();
    expect(screen().queryByText("Tudo em dia")).toBeNull();

    // A row opens where the inbox would, and reads the item.
    await click(within(rows("Esperando você")[1] as HTMLElement).getByRole("button"));
    await settle();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/approvals`);
    expect(state.calls).toContainEqual({ method: "notifications.read", args: [ORG_ID, "n-approval", true] });
  });

  test("while Lodi's first-run checklist has a row left: one line back to it, never a second list (ADR 0155 §6)", async () => {
    const state = withRightHand(seedState({ agents: [] }), { setup: { role: null, done: [] } });
    state.members = state.members.filter((m) => m.userId === "u-walter");
    state.connections = [];
    const { router } = await renderApp(`/org/${ORG_ID}/home`, { api: backend(state) });
    await settle(6);
    expect(document.querySelector(".ac-pagehead__meta")?.textContent).toBe(
      "Seu workspace está pronto. Comece por aqui.",
    );
    // The card's three rows (ADR 0162): an AI, apps, people.
    const line = document.querySelector(".home-continue") as HTMLElement;
    expect(line.textContent).toBe("Continue de onde parou · 1 de 3");
    expect(screen().queryByRole("region", { name: "Primeiros passos" })).toBeNull();
    for (const empty of ["Desde a sua última visita", "Próximas rotinas"])
      expect(screen().queryByRole("region", { name: empty })).toBeNull();
    await click(line);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
  });

  test("no line for a member, nor once the checklist is done or gone", async () => {
    const member = withRightHand(seedState(), { setup: { role: null, done: [] } });
    const org = member.me?.organizations[0];
    if (org) org.role = "member";
    await renderApp(`/org/${ORG_ID}/home`, { api: backend(member) });
    await settle(4);
    expect(document.querySelector(".home-continue")).toBeNull();
    cleanup();
    await renderApp(`/org/${ORG_ID}/home`, { api: backend(withRightHand(seedState())) });
    await settle(4);
    expect(document.querySelector(".home-continue")).toBeNull();
  });

  test("asking an agent sends the message in its DM, which opens with it", async () => {
    const state = seedState();
    const { router } = await renderApp(`/org/${ORG_ID}/home`, { api: backend(state) });
    await settle(4);
    const ask = screen().getByRole("region", { name: "Peça a um agente" });
    await pick(within(ask).getByRole("combobox", { name: "Agente" }), "Atlas");
    const box = within(ask).getByRole("textbox", { name: "Mensagem para o Atlas" });
    await act(async () => fireEvent.change(box, { target: { value: "Resume a semana" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "dms.open")?.args).toEqual([ORG_ID, { agentId: ATLAS_ID }]);
    const post = state.calls.find((c) => c.method === "chat.post");
    expect(post?.args[2]).toMatchObject({ body: "Resume a semana" });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`);
  });
});

describe("what opens when the app starts", () => {
  const opening = async (start: StartChoice | undefined, prepare?: (state: FakeState) => void) => {
    const state = seedState();
    if (state.me?.organizations[0] && start) state.me.organizations[0].start = start;
    prepare?.(state);
    return renderApp("/", { api: backend(state) });
  };

  test("Início by default, a chosen channel, or where I left off", async () => {
    let { router } = await opening(undefined);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
    expect(screen().getByRole("region", { name: "Peça a um agente" })).toBeTruthy();
    cleanup();

    ({ router } = await opening({ page: "channel", channelId: ENG_ID }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    cleanup();

    // The page this browser showed last in the workspace.
    localStorage.setItem("agentes.lastPlace", JSON.stringify({ [ORG_ID]: `/org/${ORG_ID}/wiki` }));
    ({ router } = await opening({ page: "last", channelId: null }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/wiki`);
  });

  test("a channel I left, or a last place there, opens Início", async () => {
    const left = (state: FakeState) => {
      state.channels = state.channels.map((c) => (c.id === GENERAL_ID ? { ...c, isMember: false } : c));
    };
    let { router } = await opening({ page: "channel", channelId: GENERAL_ID }, left);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
    cleanup();
    localStorage.setItem("agentes.lastPlace", JSON.stringify({ [ORG_ID]: `/org/${ORG_ID}/c/${GENERAL_ID}` }));
    ({ router } = await opening({ page: "last", channelId: null }, left));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
  });

  test("a personal workspace opens on the last conversation, else on its right hand's", async () => {
    const personal = (state: FakeState) => {
      if (state.me?.organizations[0]) state.me.organizations[0].mode = "personal";
      withRightHand(state);
    };
    let { router } = await opening({ page: "home", channelId: null }, personal);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
    cleanup();

    // A page that isn't a conversation doesn't count: still the right hand's.
    showWorkspace(null);
    localStorage.setItem("agentes.lastPlace", JSON.stringify({ [ORG_ID]: `/org/${ORG_ID}/wiki` }));
    ({ router } = await opening({ page: "home", channelId: null }, personal));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
    cleanup();

    showWorkspace(null);
    localStorage.setItem("agentes.lastPlace", JSON.stringify({ [ORG_ID]: `/org/${ORG_ID}/c/${ENG_ID}` }));
    ({ router } = await opening({ page: "home", channelId: null }, personal));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    cleanup();

    // A chosen channel still wins.
    showWorkspace(null);
    ({ router } = await opening({ page: "channel", channelId: GENERAL_ID }, personal));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  });

  test("only when the workspace opens: inside it, its address is Início, and a link's request goes there too", async () => {
    const { router } = await opening({ page: "channel", channelId: ENG_ID });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    await act(() => router.navigate({ to: "/org/$orgId", params: { orgId: ORG_ID } }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
    cleanup();

    // A new tab opens the email's link: the workspace opens, and the request still goes to Início.
    showWorkspace(null);
    const email = seedState();
    if (email.me?.organizations[0]) email.me.organizations[0].start = { page: "channel", channelId: ENG_ID };
    const link = await renderApp(`/org/${ORG_ID}?connect=ai`, { api: backend(email) });
    await settle();
    expect(link.router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
    expect(screen().getByRole("dialog", { name: "Conectar uma IA" })).toBeTruthy();
  });

  test("chosen on Início's header, kept on the server for every device", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/home`, { api: backend(state) });
    await settle(4);
    const choice = screen().getByRole("combobox", { name: "Ao abrir o app" });
    expect(choice.textContent).toBe("Início");
    await pick(choice, "#eng");
    expect(state.calls).toContainEqual({
      method: "orgs.setStart",
      args: [ORG_ID, { page: "channel", channelId: ENG_ID }],
    });
    expect(state.me?.organizations[0]?.start).toEqual({ page: "channel", channelId: ENG_ID });
    expect(screen().getByRole("combobox", { name: "Ao abrir o app" }).textContent).toBe("#eng");
    await pick(screen().getByRole("combobox", { name: "Ao abrir o app" }), "Onde você parou");
    expect(state.me?.organizations[0]?.start).toEqual({ page: "last", channelId: null });
  });
});
