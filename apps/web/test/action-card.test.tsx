import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  LODI_ID,
  meWithRole,
  NOW,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

type State = ReturnType<typeof seedState>;

/** An agent's "Conectar uma IA" card in #eng (`meta.actionCard`), as `offer_connect_ai` posts it. */
const card = (id: string, params: Record<string, unknown>, minute = 0): Message => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent", id: ATLAS_ID },
  body: "Connect an AI: server text",
  mentionedAgentIds: [],
  agentRunId: `r-${id}`,
  meta: { bodyCode: "action_connect_ai", actionCard: { kind: "connect_ai", forUserId: "u-walter", params } },
  createdAt: new Date(NOW.getTime() + minute * 60_000).toISOString(),
});

const open = async (state: State) => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
};
const click = async (el: HTMLElement, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
/** The message with this card: a waiting pill while it can be acted on, a decided one once done. */
const cardRow = (title: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.querySelector(".rq-open, .rq-done")?.textContent?.includes(title)) as HTMLElement;
const dialog = (name: string) => screen().queryByRole("dialog", { name });
const withBrain = (state: State, agentId: string, kind: NonNullable<Agent["brain"]>["kind"]) => {
  const agent = state.agents.find((a) => a.id === agentId);
  if (agent) agent.brain = { kind, model: null };
};

describe("an agent's Connect card", () => {
  test("in place of its text: the step for the agents it names, the agent's line, and Connect opens that step for them", async () => {
    const state = seedState();
    // A plan thinks only for its owner's agents (ADR 0059 §3): Walter connects his for his own.
    for (const a of state.agents) a.ownerUserId = "u-walter";
    state.messages.push(
      card("c-ada", { what: "claude", agentIds: [ADA_ID], why: "Você pediu para a Ada usar o seu plano." }),
      card("c-both", { what: "claude", agentIds: [ATLAS_ID, ADA_ID], why: "Os dois com o seu plano." }, 1),
    );
    await open(state);
    const ada = cardRow("Conectar o plano do Claude para Ada");
    expect(ada.textContent).toContain("Você pediu para a Ada usar o seu plano.");
    expect(ada.textContent).not.toContain("server text");
    // One agent named: the dialog is for her alone, on Claude's plan, with no choice of agent.
    await click(within(ada).getByRole("button", { name: "Conectar" }));
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(within(plan).getByRole("region", { name: "Seu plano do Claude" })).toBeTruthy();
    expect(within(plan).queryByRole("combobox", { name: "Agentes que usam este plano" })).toBeNull();
    await click(within(plan).getByRole("button", { name: "Fechar" }));
    // Two: a choice between them, the first one named chosen.
    await click(
      within(cardRow("Conectar o plano do Claude para Atlas e Ada")).getByRole("button", { name: "Conectar" }),
    );
    const both = dialog("Conectar uma IA") as HTMLElement;
    expect(within(both).getByRole("region", { name: "Seu plano do Claude" })).toBeTruthy();
    expect(within(both).getByRole("combobox", { name: "Agentes que usam este plano" }).textContent).toContain("Atlas");
  });

  test("an organization's key: no agent named, the key panel with its maker picked; it stays a button", async () => {
    const state = seedState();
    state.messages.push(
      card("c-key", { what: "api_key", provider: "openai", agentIds: [], why: "Sua chave da OpenAI." }),
    );
    await open(state);
    const row = cardRow("Adicionar uma chave de API");
    expect(row.textContent).not.toContain("Conectado");
    await click(within(row).getByRole("button", { name: "Conectar" }));
    const add = dialog("Conectar uma IA") as HTMLElement;
    expect(within(add).getByRole("combobox", { name: "Provedor" }).textContent).toBe("OpenAI");
  });

  test("done from live data: 'Conectado' once its agents think (with that plan, for a plan's card)", async () => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [
          { agentId: ADA_ID, state: "ready" },
          { agentId: ATLAS_ID, state: "no_ai", reason: "no_key" },
        ],
      },
    });
    withBrain(state, ADA_ID, "claude_code");
    state.messages.push(
      card("c-claude", { what: "claude", agentIds: [ADA_ID], why: "Plano do Claude." }),
      card("c-chatgpt", { what: "chatgpt", agentIds: [ADA_ID], why: "Plano do ChatGPT." }, 1),
      card("c-atlas", { agentIds: [ATLAS_ID], why: "O Atlas ainda não tem IA." }, 2),
    );
    await open(state);
    const claude = cardRow("Conectar o plano do Claude para Ada");
    expect(within(claude).queryByRole("button", { name: "Conectar" })).toBeNull();
    expect(claude.textContent).toContain("Conectado");
    // A decided pill, no longer waiting.
    expect(claude.querySelector(".rq-open")).toBeNull();
    expect(claude.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    // Ada thinks, but not with a ChatGPT plan; Atlas has no AI yet.
    for (const title of ["Conectar o plano do ChatGPT para Ada", "Conectar uma IA para Atlas"]) {
      const row = cardRow(title);
      expect(row.textContent).not.toContain("Conectado");
      expect(within(row).getByRole("button", { name: "Conectar" })).toBeTruthy();
    }
  });
});

describe("an agent's card to connect an app or an MCP server, and to invite people", () => {
  /** A card `offer_connect_app` / `offer_invites` posts as Atlas in #eng. */
  const offer = (id: string, kind: string, params: Record<string, unknown>, minute = 0): Message => ({
    ...card(id, {}, minute),
    body: "server text",
    meta: { bodyCode: "action_connect_app", actionCard: { kind, forUserId: "u-walter", params } },
  });
  const type = async (el: HTMLElement, value: string) => {
    await act(async () => fireEvent.change(el, { target: { value } }));
    await settle(2);
  };

  test("an MCP server's address: Conectar opens connecting by address with it filled in; once connected, one line", async () => {
    const state = seedState();
    state.messages.push(
      offer("c-mcp", "connect_app", { url: "https://oauth.acme.example.com/mcp", why: "Você pediu o MCP da Acme." }),
    );
    await open(state);
    const row = cardRow("Conectar oauth.acme.example.com");
    expect(row.textContent).toContain("Você pediu o MCP da Acme.");
    expect(row.textContent).not.toContain("server text");
    await click(within(row).getByRole("button", { name: "Conectar" }));
    const flow = dialog("Conectar servidor MCP") as HTMLElement;
    expect((within(flow).getByLabelText("Endereço do servidor MCP") as HTMLInputElement).value).toBe(
      "https://oauth.acme.example.com/mcp",
    );
    await type(within(flow).getByLabelText("Nome"), "Acme");
    await click(within(flow).getByRole("button", { name: "Conectar" }), 8);
    const done = cardRow("Conectar oauth.acme.example.com");
    expect(done.querySelector(".rq-open")).toBeNull();
    expect(done.textContent).toContain("Conectado");
  });

  test("a catalog service opens its own connect step; with no address, connecting by address asks for it", async () => {
    const state = seedState({ connections: [] });
    state.messages.push(
      offer("c-linear", "connect_app", { connector: "linear", why: "Para ler as issues." }),
      offer("c-any", "connect_app", { why: "Me passe o endereço no diálogo." }, 1),
    );
    await open(state);
    await click(within(cardRow("Conectar Linear")).getByRole("button", { name: "Conectar" }));
    expect(dialog("Conectar Linear")).toBeTruthy();
    await click(within(dialog("Conectar Linear") as HTMLElement).getByRole("button", { name: "Fechar" }));
    await click(within(cardRow("Adicionar um servidor MCP")).getByRole("button", { name: "Conectar" }));
    const flow = dialog("Conectar servidor MCP") as HTMLElement;
    expect((within(flow).getByLabelText("Endereço do servidor MCP") as HTMLInputElement).value).toBe("");
  });

  test("invites: Convidar opens the invite dialog with the addresses in it; done once they're invited", async () => {
    const state = seedState();
    state.messages.push(
      offer("c-inv", "invite_people", { emails: ["ana@example.com", "bia@example.com"], why: "O time de design." }),
    );
    await open(state);
    const row = cardRow("Convidar 2 pessoas");
    expect(row.textContent).toContain("ana@example.com, bia@example.com");
    await click(within(row).getByRole("button", { name: "Convidar" }));
    const invite = dialog("Convidar para a Acme") as HTMLElement;
    expect(invite.textContent).toContain("ana@example.com");
    expect(invite.textContent).toContain("bia@example.com");
    cleanup();

    const sent = seedState();
    sent.messages.push(offer("c-inv", "invite_people", { emails: ["ana@example.com"], why: "Design." }));
    sent.invitations.push({
      id: "i-ana",
      email: "ana@example.com",
      role: "member",
      status: "pending",
      expiresAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    });
    await open(sent);
    const done = cardRow("ana@example.com");
    expect(done.querySelector(".rq-open")).toBeNull();
    expect(done.textContent).toContain("Convite enviado: ana@example.com");
  });
});

describe("a stretch's pause card (ADR 0089)", () => {
  /** The card a stretch's limit posts as Atlas in #eng, for the agents it holds. */
  const pause = (id: string, actionCard: Record<string, unknown>, minute = 0): Message => ({
    ...card(id, {}, minute),
    body: "Ada and Atlas stopped to check with you: server text",
    meta: {
      bodyCode: `stretch_paused_${actionCard.reason}`,
      actionCard: {
        kind: "stretch_paused",
        stretchId: "s-1",
        state: "paused",
        forUserId: "u-joao",
        held: [],
        continuedByUserId: null,
        continuedAt: null,
        ...actionCard,
      },
    },
  });

  test("who stopped and why, in place of its text; Continuar lets them go on", async () => {
    const state = seedState();
    state.messages.push(pause("p-runs", { reason: "runs", limit: 50, agentIds: [ADA_ID, ATLAS_ID] }));
    await open(state);
    const row = cardRow("Ada e Atlas pararam para checar com você antes de continuar");
    expect(row.textContent).not.toContain("server text");
    expect(row.textContent).not.toContain("passos");
    await click(within(row).getByRole("button", { name: "Continuar" }));
    expect(state.calls.some((c) => c.method === "chat.answerNow" && c.args[1] === "p-runs")).toBe(true);
  });

  test("an agent's budget share in money for who can see costs; once continued, one quiet line and no button", async () => {
    const state = seedState();
    state.messages.push(
      pause("p-spend", { reason: "spend", limit: 20, agentIds: [ADA_ID] }),
      pause(
        "p-done",
        {
          reason: "runs",
          limit: 10,
          agentIds: [ATLAS_ID],
          state: "continued",
          continuedByUserId: "u-walter",
          continuedAt: NOW.toISOString(),
        },
        1,
      ),
    );
    await open(state);
    // Ada's own budget is US$\u00a040: 20% of it.
    const spend = cardRow("Ada parou para checar com você · usou US$\u00a08 (20% do orçamento do mês)");
    expect(within(spend).getByRole("button", { name: "Continuar" })).toBeTruthy();
    const done = cardRow("Você deixou continuar");
    // The card folds: who let them go on and when, the pause itself only as the line's name.
    expect(done.querySelector(".rq-open")).toBeNull();
    expect(
      within(done).getByRole("group", { name: "Atlas parou para checar com você antes de continuar" }),
    ).toBeTruthy();
    expect(within(done).queryByRole("button", { name: "Continuar" })).toBeNull();
  });
});

describe("what waits on a plan's limit: Não rodar", () => {
  /** Atlas's "I'll answer when the plan resets" in #eng, naming the run it holds. */
  const note = (id: string, usageWait: Record<string, unknown>, minute = 0): Message => ({
    ...card(id, {}, minute),
    body: "The Claude plan hit its limit: server text",
    meta: {
      bodyCode: "plan_limit_wait_unknown",
      bodyParams: { plan: "Claude" },
      usageWait: { code: "plan_limit", runId: `r-${id}`, forUserId: "u-joao", ...usageWait },
    },
  });

  test("under the note for who may: it cancels the run; once canceled the note says so and offers nothing", async () => {
    const state = seedState();
    state.messages.push(note("w-open", {}), note("w-done", { canceled: true }, 1));
    await open(state);
    const rows = screen().getAllByRole("article");
    const open_ = rows.find(
      (a) => a.textContent?.includes("Respondo assim que ele renovar") && !a.textContent.includes("Cancelado"),
    ) as HTMLElement;
    await click(within(open_).getByRole("button", { name: "Não rodar" }));
    expect(state.calls.some((c) => c.method === "agents.cancelRun" && c.args[1] === "r-w-open")).toBe(true);
    const done = rows.find((a) =>
      a.textContent?.includes("Cancelado. Não vai rodar quando o limite voltar."),
    ) as HTMLElement;
    expect(done).toBeTruthy();
    expect(within(done).queryByRole("button", { name: "Não rodar" })).toBeNull();
  });

  test("a note that speaks for later turns in its conversation says how many it stops", async () => {
    const state = seedState();
    state.messages.push(note("w-three", { runIds: ["r-2", "r-3"] }));
    await open(state);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Respondo assim que ele renovar")) as HTMLElement;
    await click(within(row).getByRole("button", { name: "Não rodar estas 3" }));
    expect(state.calls.some((c) => c.method === "agents.cancelRun" && c.args[1] === "r-w-three")).toBe(true);
  });

  test("Ver fila: one short row each in order, Não rodar only where the viewer may, Não rodar nenhuma for all", async () => {
    const state = seedState();
    state.messages.push(note("w-line", {}));
    const row = (runId: string, over: Record<string, unknown> = {}) => ({
      runId,
      kind: "conversation" as const,
      channelId: ENG_ID,
      threadId: null,
      channelKind: "channel",
      channelName: "eng",
      messageId: "w-line",
      askers: ["u-joao"],
      since: new Date(NOW.getTime() - 3 * 24 * 3600_000).toISOString(),
      after: { count: 12, names: ["Nina", "Ada"] },
      state: "queued" as const,
      title: null,
      mayStop: true,
      ...over,
    });
    state.usageQueues = {
      [ATLAS_ID]: {
        agentId: ATLAS_ID,
        reason: "plan",
        plan: "Claude",
        resetsAt: null,
        sharedWith: [ADA_ID],
        rows: [
          row("r-a", { state: "answering" }),
          row("r-b"),
          row("r-c", { channelName: "vendas", askers: ["u-ana"], mayStop: false }),
        ],
        hidden: 1,
        mayStopAll: true,
        closed: [],
      },
    };
    await open(state);
    const note_ = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Respondo assim que ele renovar")) as HTMLElement;
    await click(within(note_).getByRole("button", { name: "Ver fila" }));
    const dialog = await screen().findByRole("dialog");
    // One title for the phase: it answers the first one, so it is picking up. The shared plan only behind the ⓘ.
    expect(dialog.querySelector(".ac-dialog__title")?.textContent).toContain("Atlas está retomando");
    expect(within(dialog).getByRole("button", { name: "Sobre a fila" })).toBeTruthy();
    expect(dialog.textContent).not.toContain("mensagens depois");
    expect(dialog.textContent).not.toContain("Ver conversa");
    // Nothing skipped: no switch, the list alone.
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    const rows = Array.from(dialog.querySelectorAll(".uq__row")) as HTMLElement[];
    expect(rows.map((r) => r.querySelector(".uq__n")?.textContent)).toEqual(["1", "2", "3"]);
    expect(rows[0]?.textContent).toContain("Respondendo");
    expect(rows[2]?.textContent).toContain("#vendas");
    // "Não rodar" only where the viewer may use it: not on the one answering, not on someone else's.
    expect(within(dialog).getAllByRole("button", { name: "Não rodar" })).toHaveLength(1);
    expect(within(rows[2] as HTMLElement).queryByRole("button", { name: "Não rodar" })).toBeNull();
    expect(dialog.textContent).toContain("+1 que você não vê");
    expect(within(dialog).getByRole("link", { name: "Trocar a IA do Atlas" }).getAttribute("href")).toContain(
      "sec=brain",
    );
    await click(within(dialog).getByRole("button", { name: "Não rodar" }));
    expect(state.calls.some((c) => c.method === "agents.cancelRun" && c.args[1] === "r-b")).toBe(true);
    // Counts only what is still in line: two rows and the hidden one, never the one answering.
    await click(within(dialog).getByRole("button", { name: "Não rodar nenhuma" }));
    expect(dialog.textContent).toContain("Não rodar as 3?");
    await click(within(dialog).getByRole("button", { name: "Sim, não rodar" }));
    expect(state.calls.some((c) => c.method === "agents.cancelUsageQueue" && c.args[1] === ATLAS_ID)).toBe(true);
  });

  test("the whole row opens its conversation, with the dialog closed", async () => {
    const state = seedState();
    state.messages.push(note("w-open", {}));
    state.usageQueues = {
      [ATLAS_ID]: {
        agentId: ATLAS_ID,
        reason: "plan",
        plan: "Claude",
        resetsAt: null,
        sharedWith: [],
        rows: [
          {
            runId: "r-o",
            kind: "conversation",
            channelId: ENG_ID,
            threadId: null,
            channelKind: "channel",
            channelName: "eng",
            messageId: "w-open",
            askers: ["u-joao"],
            since: NOW.toISOString(),
            after: { count: 0, names: [] },
            state: "queued",
            title: null,
            mayStop: false,
          },
        ],
        hidden: 0,
        mayStopAll: false,
        closed: [],
      },
    };
    await open(state);
    const note_ = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Respondo assim que ele renovar")) as HTMLElement;
    await click(within(note_).getByRole("button", { name: "Ver fila" }));
    const dialog = await screen().findByRole("dialog");
    // Not the owner: no bulk action, no footer.
    expect(within(dialog).queryByRole("button", { name: "Não rodar nenhuma" })).toBeNull();
    await click(dialog.querySelector(".uq__open") as HTMLElement);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("a catch-up skipped as already handled says why, with Responder mesmo assim; pressed, it says who asked", async () => {
    const state = seedState();
    const at = new Date().toISOString();
    const closed = { reason: "solved", who: { name: "Nina", userId: "u-nina" }, askers: ["u-joao"], at };
    state.messages.push(
      note("w-skip", { ended: true, closed }),
      note(
        "w-asked",
        { ended: true, closed, continuedRunId: "r-new", continuedByUserId: "u-joao", continuedByName: "João" },
        1,
      ),
    );
    await open(state);
    const rows = screen().getAllByRole("article");
    const skipped = rows.find(
      (a) => a.textContent?.includes("Não respondi: Nina já cuidou disso.") && !a.textContent.includes("pediu"),
    ) as HTMLElement;
    expect(within(skipped).queryByRole("button", { name: "Não rodar" })).toBeNull();
    await click(within(skipped).getByRole("button", { name: "Responder mesmo assim" }));
    expect(state.calls.some((c) => c.method === "agents.continueRun" && c.args[1] === "r-w-skip")).toBe(true);
    const asked = rows.find((a) => a.textContent?.includes("João pediu para eu responder mesmo assim.")) as HTMLElement;
    expect(asked).toBeTruthy();
    expect(within(asked).queryByRole("button", { name: "Responder mesmo assim" })).toBeNull();
  });

  test("Puladas: what it skipped in the last day, why in the dialog's voice, Responder mesmo assim for who may", async () => {
    const state = seedState();
    state.messages.push(note("w-q", {}));
    const at = new Date().toISOString();
    const skipped = (runId: string, closed: Record<string, unknown>, mayAnswer: boolean) => ({
      runId,
      channelId: ENG_ID,
      threadId: null,
      channelKind: "channel",
      channelName: "eng",
      messageId: `m-${runId}`,
      closed: { askers: ["u-joao"], at, ...closed } as never,
      continuedRunId: null,
      mayAnswer,
    });
    state.usageQueues = {
      [ATLAS_ID]: {
        agentId: ATLAS_ID,
        reason: "plan",
        plan: "Claude",
        resetsAt: null,
        sharedWith: [],
        rows: [
          {
            runId: "r-w",
            kind: "conversation",
            channelId: ENG_ID,
            threadId: null,
            channelKind: "channel",
            channelName: "eng",
            messageId: "w-q",
            askers: ["u-joao"],
            since: at,
            after: { count: 0, names: [] },
            state: "queued",
            title: null,
            mayStop: true,
          },
        ],
        hidden: 0,
        mayStopAll: true,
        closed: [
          skipped("r-s1", { reason: "solved", who: { name: "Nina" } }, true),
          skipped("r-s2", { reason: "withdrawn", who: { name: "João" } }, false),
        ],
      },
    };
    await open(state);
    const note_ = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Respondo assim que ele renovar")) as HTMLElement;
    await click(within(note_).getByRole("button", { name: "Ver fila" }));
    const dialog = await screen().findByRole("dialog");
    expect(dialog.querySelector(".ac-dialog__title")?.textContent).toBe("Atlas volta quando o plano renovar");
    // Both lists have something: the switch, on Na fila, with one count each.
    const queued = within(dialog).getByRole("radio", { name: /Na fila/ });
    expect(queued.getAttribute("aria-checked")).toBe("true");
    expect(queued.textContent).toContain("1");
    expect(dialog.textContent).not.toContain("Nina já cuidou disso");
    await click(within(dialog).getByRole("radio", { name: /Puladas/ }));
    expect(dialog.textContent).toContain("Nina já cuidou disso");
    expect(dialog.textContent).toContain("João disse que não precisa mais");
    expect(dialog.textContent).not.toContain("Não respondi");
    // The footer is the line's: not on Puladas.
    expect(within(dialog).queryByRole("button", { name: "Não rodar nenhuma" })).toBeNull();
    expect(within(dialog).getAllByRole("button", { name: "Responder mesmo assim" })).toHaveLength(1);
    await click(within(dialog).getByRole("button", { name: "Responder mesmo assim" }));
    expect(state.calls.some((c) => c.method === "agents.continueRun" && c.args[1] === "r-s1")).toBe(true);
  });

  test("Ver fila under a skipped catch-up's note opens on Puladas", async () => {
    const state = seedState();
    const at = new Date().toISOString();
    const closed = { reason: "solved", who: { name: "Nina", userId: "u-nina" }, askers: ["u-joao"], at };
    state.messages.push(note("w-skipped", { ended: true, closed }));
    state.usageQueues = {
      [ATLAS_ID]: {
        agentId: ATLAS_ID,
        reason: "plan",
        plan: "Claude",
        resetsAt: null,
        sharedWith: [],
        rows: [
          {
            runId: "r-w",
            kind: "conversation",
            channelId: ENG_ID,
            threadId: null,
            channelKind: "channel",
            channelName: "eng",
            messageId: "w-skipped",
            askers: ["u-joao"],
            since: at,
            after: { count: 0, names: [] },
            state: "queued",
            title: null,
            mayStop: true,
          },
        ],
        hidden: 0,
        mayStopAll: true,
        closed: [
          {
            runId: "r-w-skipped",
            channelId: ENG_ID,
            threadId: null,
            channelKind: "channel",
            channelName: "eng",
            messageId: "w-skipped",
            closed: closed as never,
            continuedRunId: null,
            mayAnswer: true,
          },
        ],
      },
    };
    await open(state);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Não respondi: Nina já cuidou disso.")) as HTMLElement;
    await click(within(row).getByRole("button", { name: "Ver fila" }));
    const dialog = await screen().findByRole("dialog");
    expect(
      within(dialog)
        .getByRole("radio", { name: /Puladas/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(dialog.textContent).toContain("Nina já cuidou disso");
  });

  test("back at work, the note offers nothing to cancel", async () => {
    const state = seedState();
    state.messages.push(note("w-back", { ended: true }));
    await open(state);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Respondo assim que ele renovar")) as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Não rodar" })).toBeNull();
  });

  test("a member who didn't ask and doesn't own the agent sees it greyed", async () => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.role = "member";
    state.messages.push(note("w-theirs", {}));
    await open(state);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Respondo assim que ele renovar")) as HTMLElement;
    expect((within(row).getByRole("button", { name: "Não rodar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a long-work pause's card: Não rodar beside Continuar agora; canceled, it says so", async () => {
    const state = seedState();
    const usageCard = (id: string, over: Record<string, unknown>, minute = 0): Message => ({
      ...card(id, {}, minute),
      body: "Atlas paused this work: server text",
      meta: {
        bodyCode: "usage_paused",
        bodyParams: { agent: "Atlas", plan: "Claude", percent: "96", window: "five_hour" },
        actionCard: {
          kind: "usage_paused",
          state: "paused",
          runId: `r-${id}`,
          waitId: "w1",
          agentId: ATLAS_ID,
          forUserId: "u-walter",
          source: "plan",
          percent: 96,
          window: "five_hour",
          plan: "Claude",
          continuedByUserId: null,
          continuedAt: null,
          ...over,
        },
      },
    });
    state.messages.push(usageCard("u-open", {}), usageCard("u-done", { state: "canceled" }, 1));
    await open(state);
    const cards = screen()
      .getAllByRole("article")
      .filter((a) => a.querySelector(".rq-open, .rq-done"));
    const paused = cards.find((a) => within(a).queryByRole("button", { name: "Continuar agora" })) as HTMLElement;
    await click(within(paused).getByRole("button", { name: "Não rodar" }));
    expect(state.calls.some((c) => c.method === "agents.cancelRun" && c.args[1] === "r-u-open")).toBe(true);
    expect(cards.some((a) => a.textContent?.includes("Cancelado. Não vai rodar quando o limite voltar."))).toBe(true);
    cleanup();

    const held = createFakeApi(state);
    held.agents.cancelRun = () => new Promise(() => {});
    state.messages.push(usageCard("u-held", {}, 2));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: held });
    await settle(5);
    const waiting = screen()
      .getAllByRole("article")
      .find((a) => a.querySelector(".rq-open") && within(a).queryByRole("button", { name: "Continuar agora" }));
    await click(within(waiting as HTMLElement).getByRole("button", { name: "Não rodar" }));
    const go = within(waiting as HTMLElement).getByRole("button", { name: "Continuar agora" });
    expect(go.closest("fieldset[disabled]")).not.toBeNull();
  });
});

describe("an agent's card to install or update a skill", () => {
  const offer = (id: string, kind: string, params: Record<string, unknown>): Message => ({
    ...card(id, {}),
    body: "server text",
    meta: { bodyCode: "action_install_skill", actionCard: { kind, forUserId: "u-walter", params } },
  });

  test("Instalar opens Instalar skill on the link, its skills read to pick, and its box turns them on for the agent", async () => {
    const state = seedState();
    const link = "https://github.com/acme/skills/tree/main/deploy";
    state.messages.push(offer("c-skill", "install_skill", { url: link, why: "Faz deploys." }));
    await open(state);
    const row = cardRow("Instalar uma skill");
    expect(row.textContent).toContain("Faz deploys.");
    expect(row.textContent).toContain(link);
    await click(within(row).getByRole("button", { name: "Instalar" }), 8);
    const install = dialog("Instalar skill") as HTMLElement;
    expect((within(install).getByRole("textbox", { name: "Link do GitHub" }) as HTMLInputElement).value).toBe(link);
    // Reading the link installs nothing, so it names no agent.
    expect(state.calls.filter((c) => c.method === "skills.import").map((c) => c.args[1])).toEqual([
      { url: link, list: true },
    ]);
    const box = within(install).getByRole("checkbox", { name: "Fica ligada para Atlas" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    // Kept for the way back from connecting GitHub on its site.
    expect(JSON.parse(sessionStorage.getItem("agentes.skills.installFor") ?? "null")).toEqual({
      url: link,
      agentId: ATLAS_ID,
    });
    await click(within(install).getByRole("checkbox", { name: /deploy/ }));
    await click(within(install).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "skills.importPicked")?.args.slice(1)).toEqual([
      link,
      ["skills/deploy"],
      ATLAS_ID,
    ]);
  });

  test("unchecked, or on a link typed over the card's, what installs goes on for nobody; a same name says it replaces", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.skills.create(ORG_ID, { name: "deploy", description: "O deploy de hoje.", body: "# Deploy" });
    const link = "https://github.com/acme/skills/tree/main/deploy";
    state.messages.push(offer("c-skill", "install_skill", { url: link, why: "Faz deploys." }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow("Instalar uma skill")).getByRole("button", { name: "Instalar" }), 8);
    const install = () => within(dialog("Instalar skill") as HTMLElement);
    expect(dialog("Instalar skill")?.textContent).toContain("Substitui a skill deploy já instalada");
    const retype = async (value: string) => {
      await act(async () =>
        fireEvent.change(install().getByRole("textbox", { name: "Link do GitHub" }), { target: { value } }),
      );
      await settle(3);
    };
    await retype("https://github.com/acme/other");
    expect(install().queryByRole("checkbox", { name: /Fica ligada/ })).toBeNull();
    await retype(link);
    await click(install().getByRole("checkbox", { name: "Fica ligada para Atlas" }));
    // Back on the card's link, unchecked: the link installs at once, for nobody.
    await click(install().getByRole("button", { name: "Instalar" }), 8);
    expect(state.calls.filter((c) => c.method === "skills.import").map((c) => c.args[1])).toEqual([
      { url: link, list: true },
      { url: link },
    ]);
  });

  test("reopened, the dialog reads the card's link again; a pick named like a removed skill says it replaces it", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const old = await api.skills.create(ORG_ID, { name: "deploy", description: "O deploy antigo.", body: "# Deploy" });
    await api.skills.remove(ORG_ID, old.id);
    const link = "https://github.com/acme/skills/tree/main/deploy";
    state.messages.push(offer("c-skill", "install_skill", { url: link, why: "Faz deploys." }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const openIt = () => click(within(cardRow("Instalar uma skill")).getByRole("button", { name: "Instalar" }), 8);
    await openIt();
    expect(dialog("Instalar skill")?.textContent).toContain("Substitui a skill deploy removida");
    await click(within(dialog("Instalar skill") as HTMLElement).getByRole("button", { name: "Cancelar" }), 4);
    await openIt();
    expect(dialog("Instalar skill")?.textContent).toContain("Substitui a skill deploy removida");
    expect(state.calls.filter((c) => c.method === "skills.import").map((c) => c.args[1])).toEqual([
      { url: link, list: true },
      { url: link, list: true },
    ]);
  });

  test("a card by an agent archived since, or by the right hand, shows no box and turns nothing on", async () => {
    const link = "https://github.com/acme/skills/tree/main/deploy";
    const installFrom = async (state: ReturnType<typeof seedState>, author: string) => {
      state.messages.push({
        ...offer("c-skill", "install_skill", { url: link, why: "Faz deploys." }),
        author: { type: "agent", id: author },
      });
      await open(state);
      await click(within(cardRow("Instalar uma skill")).getByRole("button", { name: "Instalar" }), 8);
      const install = within(dialog("Instalar skill") as HTMLElement);
      expect(install.queryByRole("checkbox", { name: /Fica ligada/ })).toBeNull();
      await click(install.getByRole("checkbox", { name: /deploy/ }));
      await click(install.getByRole("button", { name: "Instalar" }));
      await settle(6);
      expect(state.calls.find((c) => c.method === "skills.importPicked")?.args.slice(1)).toEqual([
        link,
        ["skills/deploy"],
      ]);
      cleanup();
    };
    const archived = seedState();
    const atlas = archived.agents.find((a) => a.id === ATLAS_ID);
    archived.agents = archived.agents.filter((a) => a.id !== ATLAS_ID);
    archived.former = [
      { id: ATLAS_ID, name: atlas?.name ?? "Atlas", role: atlas?.role ?? "", appearance: null, deleted: false },
    ];
    await installFrom(archived, ATLAS_ID);
    const ownCard = seedState();
    withRightHand(ownCard);
    await installFrom(ownCard, LODI_ID);
  });

  test("a link typed over the card's, or a repository picked from the connected GitHub, installs for nobody", async () => {
    const link = "https://github.com/acme/skills/tree/main/deploy";
    const picked = (state: ReturnType<typeof seedState>) =>
      state.calls.filter((c) => c.method === "skills.importPicked").map((c) => c.args.slice(1));
    const typedOver = seedState();
    typedOver.messages.push(offer("c-skill", "install_skill", { url: link, why: "Faz deploys." }));
    await open(typedOver);
    await click(within(cardRow("Instalar uma skill")).getByRole("button", { name: "Instalar" }), 8);
    const install = () => within(dialog("Instalar skill") as HTMLElement);
    const other = "https://github.com/acme/other";
    await act(async () =>
      fireEvent.change(install().getByRole("textbox", { name: "Link do GitHub" }), { target: { value: other } }),
    );
    await click(install().getByRole("button", { name: "Instalar" }), 8);
    await click(install().getByRole("checkbox", { name: /deploy/ }));
    await click(install().getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(typedOver.calls.filter((c) => c.method === "skills.import").map((c) => c.args[1])).toEqual([
      { url: link, list: true },
      { url: other },
    ]);
    expect(picked(typedOver)).toEqual([[other, ["skills/deploy"]]]);
    cleanup();

    const fromGithub = seedState();
    const contoso = "https://github.com/contoso/skills";
    fromGithub.githubRepos = {
      connected: true,
      accounts: [
        {
          login: "contoso",
          type: "Organization",
          repositories: [
            { fullName: "contoso/skills", owner: "contoso", name: "skills", private: true, updatedAt: null },
          ],
        },
      ],
      truncated: false,
    };
    fromGithub.messages.push(offer("c-skill", "install_skill", { url: link, why: "Faz deploys." }));
    await open(fromGithub);
    await click(within(cardRow("Instalar uma skill")).getByRole("button", { name: "Instalar" }), 8);
    // The card's link read lists its skill; cleared, the connected GitHub's repositories are offered.
    await act(async () =>
      fireEvent.change(install().getByRole("textbox", { name: "Link do GitHub" }), { target: { value: "" } }),
    );
    await settle(3);
    await click(install().getByRole("button", { name: "Escolher do GitHub conectado" }), 4);
    const repo = install()
      .getAllByRole("button")
      .find((b) => b.classList.contains("ac-row") && b.textContent?.startsWith("contoso/skills"));
    await click(repo as HTMLElement);
    expect(install().queryByRole("checkbox", { name: /Fica ligada/ })).toBeNull();
    await click(install().getByRole("checkbox", { name: /deploy/ }));
    await click(install().getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(picked(fromGithub)).toEqual([[contoso, ["skills/deploy"]]]);
  });

  test("connecting GitHub from the card's dialog comes back to Skills with the agent, for its box", async () => {
    setNavigateAway(() => {});
    const state = seedState();
    state.connections = [];
    const link = "https://github.com/contoso/skills";
    state.messages.push(offer("c-skill", "install_skill", { url: link, why: "Lê o repositório privado." }));
    await open(state);
    await click(within(cardRow("Instalar uma skill")).getByRole("button", { name: "Instalar" }), 8);
    await click(within(dialog("Instalar skill") as HTMLElement).getByRole("button", { name: "Conectar o GitHub" }), 2);
    const flow = screen().getByRole("dialog", { name: "Conectar GitHub" });
    await click(within(flow).getByRole("button", { name: "Continuar no GitHub" }), 4);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")?.args[2]).toEqual({
      returnTo: `/org/${ORG_ID}/settings/skills?install=${encodeURIComponent(link)}&agent=${ATLAS_ID}`,
      serverUrl: undefined,
    });
  });

  test("done for everyone once the library has it, a member who doesn't manage agents too", async () => {
    const state = seedState();
    meWithRole(state, []);
    const link = "https://github.com/acme/skills/tree/main/pr-review";
    state.messages.push(offer("c-have", "install_skill", { url: link, why: "Revisa PRs." }));
    await open(state);
    const row = cardRow("Instalada");
    expect(row.querySelector(".rq-done")).not.toBeNull();
    expect(row.textContent).toContain(`Instalada: ${link}`);
    expect(within(row).queryByRole("button", { name: "Instalar" })).toBeNull();
  });

  test("an update waiting on its scripts: Revisar opens the skill, where it is applied", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const [review] = await api.skills.list(ORG_ID);
    if (!review) throw new Error("no skill");
    const pendingUpdate = { scripts: ["scripts/lint.sh"], at: NOW.toISOString(), dismissed: false };
    await api.skills.update(ORG_ID, review.id, { pendingUpdate } as never);
    state.messages.push(offer("c-up", "update_skills", { skillIds: [review.id], why: "Script novo." }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const row = cardRow("Atualizar uma skill");
    await click(within(row).getByRole("button", { name: "Revisar" }), 8);
    const sheet = dialog(review.name) as HTMLElement;
    expect(sheet.textContent).toContain("A atualização do link muda arquivos que rodam: scripts/lint.sh");
    await click(within(sheet).getByRole("button", { name: "Aplicar atualização" }), 8);
    expect(state.calls.some((c) => c.method === "skills.approveUpdate")).toBe(true);
  });
});

describe("an agent's event proposal", () => {
  const proposalCard = (status: "pending" | "confirmed" | "dismissed", requesterUserId = "u-walter"): Message => ({
    id: "m-cal",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Event proposal: Revisão do PR",
    mentionedAgentIds: [],
    agentRunId: "r-cal",
    meta: {
      bodyCode: "calendar_proposal",
      bodyParams: { title: "Revisão do PR" },
      calendarProposalId: "p-cal",
      calendarProposal: {
        id: "p-cal",
        agentId: ADA_ID,
        requesterUserId,
        title: "Revisão do PR",
        start: new Date(NOW.getTime() + 86_400_000).toISOString(),
        end: new Date(NOW.getTime() + 86_400_000 + 1_800_000).toISOString(),
        participants: [{ type: "person", id: "u-joao" }],
        note: null,
        status,
      },
    },
    createdAt: NOW.toISOString(),
  });

  test("a card in the conversation: Confirmar e convidar makes the event; then it says what was decided", async () => {
    const state = seedState();
    state.messages.push(proposalCard("pending"));
    const api = createFakeApi(state);
    const confirmed: string[] = [];
    api.calendar.confirmProposal = async (_org, id) => {
      confirmed.push(id);
      return {} as never;
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const row = cardRow("Revisão do PR");
    expect(row.textContent).toContain("João");
    await click(within(row).getByRole("button", { name: "Confirmar e convidar" }));
    expect(confirmed).toEqual(["p-cal"]);
    expect(cardRow("Revisão do PR").textContent).toContain("Evento criado");
    expect(within(cardRow("Revisão do PR")).queryByRole("button", { name: "Confirmar e convidar" })).toBeNull();
  });

  test("someone else's, for a member: it says who confirms, with no buttons", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    state.messages.push(proposalCard("pending", "u-joao"));
    await open(state);
    const row = cardRow("Revisão do PR");
    expect(row.textContent).toContain("João confirma");
    expect(within(row).queryByRole("button", { name: "Confirmar e convidar" })).toBeNull();
  });
});
