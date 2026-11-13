import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ActiveRun, Agent, ComputerQueue, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { STORAGE_KEYS } from "@/lib/storage";
import { atRule, builtCss, declarations, topLevel } from "./built-css";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const NOVA_ID = "00000000-0000-4000-8000-0000000000a7";
const RIO_ID = "00000000-0000-4000-8000-0000000000a8";
const in_ = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const click = (el: Element) => act(async () => fireEvent.click(el));
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
const turns = () => [...document.querySelectorAll<HTMLElement>(".cq-turn")];
/** A run with no words yet shows here, not as a block of its own. */
const thinking = () => document.querySelector(".ac-typing")?.textContent ?? "";
const orgEvent = (event: Record<string, unknown>) => ({ type: "event", scope: "org", event });
const atlasWaits = () => ({
  type: "agent.run",
  channelId: ENG_ID,
  threadId: null,
  agentId: ATLAS_ID,
  runId: "r-atlas",
  status: "waiting_input",
  computer: "queued",
});

function setup() {
  const state = seedState();
  const me = state.me?.user.id ?? "";
  const base = state.agents[0] as Agent;
  state.agents.push(
    { ...base, id: NOVA_ID, name: "Nova", handle: "nova" },
    { ...base, id: RIO_ID, name: "Rio", handle: "rio" },
  );
  state.channelMembers[ENG_ID]?.push({ type: "agent", id: NOVA_ID }, { type: "agent", id: RIO_ID });
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  const studio = machines?.pair({
    name: "Studio",
    agents: [ADA_ID, ATLAS_ID, NOVA_ID, RIO_ID].map((id) => ({ id, name: id, handle: id })),
  });
  const machineId = studio?.id ?? "";
  const where = { channelId: ENG_ID, threadId: null };
  const queue: ComputerQueue = {
    machineId,
    name: "Studio",
    working: [
      {
        runId: "r-ada",
        agentId: ADA_ID,
        purpose: { kind: "agent", agentId: NOVA_ID },
        where,
        startedAt: in_(-6),
        estimatedEndAt: in_(2),
      },
    ],
    waiting: [
      {
        runId: "r-atlas",
        agentId: ATLAS_ID,
        purpose: { kind: "person", userId: me },
        where,
        people: true,
        position: 1,
        estimatedStartAt: in_(2),
        after: [ADA_ID],
      },
      {
        runId: "r-rio",
        agentId: RIO_ID,
        purpose: { kind: "agent", agentId: NOVA_ID },
        where,
        people: false,
        position: 2,
        estimatedStartAt: null,
        after: [ATLAS_ID],
      },
    ],
  };
  machines?.setQueue(queue);
  return { state, api, me, machines, queue };
}

const said = (over: Partial<Message>) =>
  ({
    id: "m-ask",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-joao" },
    body: "@atlas olha o deploy",
    mentionedAgentIds: [ATLAS_ID],
    agentRunId: null,
    meta: {},
    createdAt: new Date().toISOString(),
    ...over,
  }) as Message;

describe("a computer's line", () => {
  test("an agent's picture in it opens its details beside the conversation, and the dialog closes", async () => {
    const { api } = setup();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    await click(screen().getByRole("button", { name: "Computador · 2 aguardando" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Fila de Studio" });
    await click(within(dialog).getByRole("button", { name: "Perfil de Atlas" }));
    await settle(6);
    const panel = screen().getByRole("complementary", { name: "Perfil do Atlas" });
    expect(screen().queryByRole("dialog", { name: "Fila de Studio" })).toBeNull();
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  test("the header says who waits and opens the line in place: working now, in line, my request first", async () => {
    const { api } = setup();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const button = screen().getByRole("button", { name: "Computador · 2 aguardando" });
    await click(button);
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Fila de Studio" });
    const text = dialog.textContent ?? "";
    expect(text).toContain("Cheio · o próximo começa em cerca de 2 min");
    expect(text).toContain("Trabalhando agora · 1");
    expect(text).toContain("a pedido de Nova · #eng · 6 min");
    expect(text).toContain("faltam ~2 min");
    expect(text).toContain("Na fila · 2");
    expect(text).toContain("respondendo você · #eng");
    expect(text).toContain("começa em ~2 min");
    // No estimate behind the head: no time, never a made-up one.
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows.at(-1)?.textContent).not.toContain("~");
    const mine = rows.find((r) => r.hasAttribute("data-mine"));
    expect(mine?.textContent).toContain("Você vai primeiro");
    expect(mine?.textContent).toContain("Atlas");
    expect(text).toContain("Pessoas vão primeiro.");
  });

  test("the waiting agent's turn after my message says where it is in line, and See queue opens the line", async () => {
    const { api, state, me } = setup();
    state.messages.push(
      said({
        author: { type: "person", id: me },
        receipts: {
          seenBy: [ATLAS_ID],
          pickedBy: [ATLAS_ID],
          handled: [{ agentId: ATLAS_ID, runId: "r-atlas", status: "waiting_input", computer: "queued" }],
          blocked: [],
        },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    // The receipt under my message keeps its words; the agent's turn is its own row, where "thinking" shows.
    const foot = row("m-ask").querySelector(".ac-msg__foot") as HTMLElement;
    expect(foot.textContent).toContain("Atlas está na fila do computador · é o próximo");
    const [turn, ...more] = turns();
    expect(more).toEqual([]);
    expect(turn?.closest(".ac-receipt")).toBeNull();
    expect(turn?.querySelector(".ac-msg__avatar")).not.toBeNull();
    expect(turn?.textContent).toContain("Atlas");
    expect(turn?.textContent).toContain("Aguardando o computador. É o próximo, em cerca de 2 min");
    expect(turn?.textContent).toContain("Você vai primeiro");
    await click(within(turn as HTMLElement).getByRole("button", { name: "Ver fila" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Fila de Studio" })).toBeTruthy();
  });

  test("an agent further back names who is ahead", async () => {
    const { api, state } = setup();
    state.messages.push(
      said({
        body: "@rio confere",
        mentionedAgentIds: [RIO_ID],
        receipts: {
          seenBy: [RIO_ID],
          pickedBy: [RIO_ID],
          handled: [{ agentId: RIO_ID, runId: "r-rio", status: "waiting_input", computer: "queued" }],
          blocked: [],
        },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const foot = row("m-ask").querySelector(".ac-msg__foot") as HTMLElement;
    expect(foot.textContent).toContain("Rio está na fila do computador");
    expect(foot.textContent).not.toContain("próximo");
    expect(turns()[0]?.textContent).toContain("Na fila, 2º. Depois de Atlas");
    expect(turns()[0]?.textContent).not.toContain("Você vai primeiro");
  });

  test("two agents in line: one receipt line, a turn each, none repeating the receipt", async () => {
    const { api, state } = setup();
    state.messages.push(
      said({
        body: "@atlas @rio confiram",
        mentionedAgentIds: [ATLAS_ID, RIO_ID],
        receipts: {
          seenBy: [ATLAS_ID, RIO_ID],
          pickedBy: [ATLAS_ID, RIO_ID],
          handled: [
            { agentId: ATLAS_ID, runId: "r-atlas", status: "waiting_input", computer: "queued" },
            { agentId: RIO_ID, runId: "r-rio", status: "waiting_input", computer: "queued" },
          ],
          blocked: [],
        },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const foot = row("m-ask").querySelector(".ac-msg__foot") as HTMLElement;
    expect(foot.textContent?.match(/estão na fila do computador/g)).toHaveLength(1);
    expect(turns().map((t) => t.querySelector(".ac-msg__head")?.textContent)).toEqual([
      expect.stringContaining("Atlas"),
      expect.stringContaining("Rio"),
    ]);
  });

  test("an agent's message that called several agents gets one strip: each agent's state, live", async () => {
    const { api, state, machines, queue } = setup();
    state.messages.push(
      said({
        author: { type: "agent", id: NOVA_ID },
        body: "@ada @atlas @rio cada um olha uma parte",
        mentionedAgentIds: [ADA_ID, ATLAS_ID, RIO_ID],
        agentRunId: "r-nova",
        receipts: {
          seenBy: [ADA_ID, ATLAS_ID, RIO_ID],
          pickedBy: [],
          handled: [
            { agentId: ADA_ID, runId: "r-ada", status: "running" },
            { agentId: ATLAS_ID, runId: "r-atlas", status: "waiting_input", computer: "queued" },
            { agentId: RIO_ID, runId: "r-rio", status: "waiting_input", computer: "queued" },
          ],
          blocked: [],
        },
      }),
    );
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    const strip = row("m-ask").querySelector(".cq-fan") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toContain("3 agentes chamados · 1 trabalhando · 2 na fila");
    const chips = [...strip.querySelectorAll(".cq-fan__chip")].map((c) => c.textContent);
    expect(chips).toEqual(["Ada trabalhando", "Atlas 1º", "Rio 2º"]);
    // One strip, no turn per agent in line.
    expect(turns()).toEqual([]);
    expect(within(strip).getByRole("button", { name: "Ver fila" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Computador · 2 aguardando" })).toBeTruthy();

    // Atlas got the computer: the line says so and everyone's app reads it again.
    const [atlas, rio] = queue.waiting;
    machines?.setQueue({
      ...queue,
      working: [
        ...queue.working,
        {
          runId: "r-atlas",
          agentId: ATLAS_ID,
          purpose: atlas?.purpose ?? { kind: "routine" },
          where: atlas?.where ?? { channelId: ENG_ID, threadId: null },
          startedAt: in_(0),
          estimatedEndAt: in_(3),
        },
      ],
      waiting: rio ? [{ ...rio, position: 1, after: [ADA_ID] }] : [],
    });
    await act(async () => socket.push(orgEvent({ type: "computer.queue", machineId: queue.machineId })));
    await settle(6);
    const live = row("m-ask").querySelector(".cq-fan") as HTMLElement;
    expect([...live.querySelectorAll(".cq-fan__chip")].map((c) => c.textContent)).toEqual([
      "Ada trabalhando",
      "Atlas trabalhando",
      "Rio 1º",
    ]);
    expect(screen().getByRole("button", { name: "Computador · 1 aguardando" })).toBeTruthy();
  });

  test("the dialog stays open as the line empties, live", async () => {
    const { api, machines, queue } = setup();
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    await click(screen().getByRole("button", { name: "Computador · 2 aguardando" }));
    await settle(4);
    machines?.setQueue({ ...queue, working: [], waiting: [] });
    await act(async () => socket.push(orgEvent({ type: "computer.queue", machineId: queue.machineId })));
    await settle(6);
    const dialog = screen().getByRole("dialog", { name: "Fila de Studio" });
    expect(dialog.textContent).toContain("Ninguém na fila");
    expect(screen().queryByRole("button", { name: /aguardando/ })).toBeNull();
  });

  test("in an agent's DM one Computer button says who waits, and the line goes on to the computer", async () => {
    const { api, machines, queue } = setup();
    localStorage.setItem(`${STORAGE_KEYS.dmSidebar}.u-walter.${ORG_ID}`, "0");
    const r = await renderApp(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    const header = document.querySelector(".channel__header") as HTMLElement;
    const computers = () => within(header).queryAllByRole("button", { name: /^Computador/ });
    expect(computers().map((b) => b.textContent)).toEqual(["Computador · 2 aguardando2"]);
    await click(computers()[0] as Element);
    await settle(4);
    const line = screen().getByRole("dialog", { name: "Fila de Studio" });
    await click(within(line).getByRole("button", { name: "Abrir o computador" }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: "Fila de Studio" })).toBeNull();
    expect(screen().getAllByRole("dialog").length).toBe(1);
    // Nobody waits: the plain Computer button, the one way to the computer.
    machines?.setQueue({ ...queue, working: [], waiting: [] });
    await act(async () => socket.push(orgEvent({ type: "computer.queue", machineId: queue.machineId })));
    await settle(6);
    // (Behind the computer's dialog, so read from the page itself.)
    expect(header.querySelectorAll(".brw-dm")).toHaveLength(1);
    expect(header.querySelector(".cq-btn")).toBeNull();
  });
});

describe("a wait in the conversation holds still", () => {
  const waitingReceipt = {
    seenBy: [ATLAS_ID],
    pickedBy: [ATLAS_ID],
    handled: [{ agentId: ATLAS_ID, runId: "r-atlas", status: "waiting_input" as const, computer: "queued" as const }],
    blocked: [],
  };
  const lineWithout = (q: ComputerQueue, runId: string) => ({
    ...q,
    waiting: q.waiting.filter((w) => w.runId !== runId),
  });

  test("two messages from one person to an agent in line show one wait, after the latest", async () => {
    const { api, state, me } = setup();
    const author = { type: "person" as const, id: me };
    state.messages.push(
      said({ author, receipts: waitingReceipt }),
      said({ id: "m-again", author, body: "?", mentionedAgentIds: [], receipts: waitingReceipt }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    expect(turns()).toHaveLength(1);
    const place = row("m-again").compareDocumentPosition(turns()[0] as HTMLElement);
    expect(place & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each message keeps its own receipt, and they say the same.
    for (const id of ["m-ask", "m-again"])
      expect(row(id).querySelector(".ac-msg__foot")?.textContent).toContain("é o próximo");
  });

  test("a second message arrives live: the wait stays one, and the message gets the same receipt", async () => {
    const { api, state, me } = setup();
    const author = { type: "person" as const, id: me };
    state.messages.push(said({ author, receipts: waitingReceipt }));
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    const message = said({ id: "m-again", author, body: "?", mentionedAgentIds: [] });
    const channelEvent = (event: Record<string, unknown>) => ({ type: "event", channelId: ENG_ID, event });
    await act(async () => {
      socket.push(channelEvent({ type: "message.created", channelId: ENG_ID, message }));
      socket.push(
        channelEvent({
          type: "agent.run.steered",
          channelId: ENG_ID,
          threadId: null,
          runId: "r-atlas",
          agentId: ATLAS_ID,
          messageId: "m-again",
          computer: "queued",
        }),
      );
    });
    await settle(6);
    expect(turns()).toHaveLength(1);
    expect(row("m-again").querySelector(".ac-msg__foot")?.textContent).toContain("é o próximo");
    expect(thinking()).not.toContain("pensando");
  });

  test("a read of the line that lacks the run takes nothing away: the row stays, in plain words", async () => {
    const { api, state, machines, queue, me } = setup();
    state.messages.push(said({ author: { type: "person", id: me }, receipts: waitingReceipt }));
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    expect(turns()[0]?.textContent).toContain("É o próximo, em cerca de 2 min");

    machines?.setQueue(lineWithout(queue, "r-atlas"));
    await act(async () => socket.push(orgEvent({ type: "computer.queue", machineId: queue.machineId })));
    await settle(6);
    expect(turns()).toHaveLength(1);
    expect(turns()[0]?.textContent).toContain("Aguardando o computador");

    machines?.setQueue(queue);
    await act(async () => socket.push(orgEvent({ type: "computer.queue", machineId: queue.machineId })));
    await settle(6);
    expect(turns()[0]?.textContent).toContain("É o próximo, em cerca de 2 min");
  });

  test("the run goes from thinking to the line: its wait shows before the line is read", async () => {
    const { api, state, machines, queue, me } = setup();
    machines?.setQueue(lineWithout(queue, "r-atlas"));
    state.messages.push(
      said({
        author: { type: "person", id: me },
        receipts: { ...waitingReceipt, handled: [{ agentId: ATLAS_ID, runId: "r-atlas", status: "running" }] },
      }),
    );
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: atlasWaits() }));
    await settle(6);
    expect(turns()).toHaveLength(1);
    expect(turns()[0]?.textContent).toContain("Aguardando o computador");
  });

  test("back on a hidden tab, the run asking the computer again: one wait, no thinking row", async () => {
    const { api, state, me, machines, queue } = setup();
    state.messages.push(said({ author: { type: "person", id: me }, receipts: waitingReceipt }));
    state.activeRuns = {
      [ENG_ID]: [
        {
          runId: "r-atlas",
          agentId: ATLAS_ID,
          channelId: ENG_ID,
          threadId: null,
          status: "waiting_input",
          triggerMessageId: "m-ask",
          startedAt: in_(-11),
          heartbeatAt: null,
          createdAt: in_(-11),
          pendingMessageIds: [],
          background: false,
        } as unknown as ActiveRun,
      ],
    };
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    expect(turns()).toHaveLength(1);
    machines?.setQueue(lineWithout(queue, "r-atlas"));
    const visible = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const tab = (state: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const realNow = Date.now;
    await act(async () => tab("hidden"));
    Date.now = () => realNow() + 60_000;
    await act(async () => tab("visible"));
    await settle(8);
    Date.now = realNow;
    if (visible) Object.defineProperty(document, "visibilityState", visible);
    expect(turns()).toHaveLength(1);
    expect(thinking()).not.toContain("pensando");
  });

  const backOnTheTab = async () => {
    const visible = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const tab = (state: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const realNow = Date.now;
    await act(async () => tab("hidden"));
    Date.now = () => realNow() + 60_000;
    await act(async () => tab("visible"));
    await settle(8);
    Date.now = realNow;
    if (visible) Object.defineProperty(document, "visibilityState", visible);
  };

  test("the computer took its turn while the tab was hidden: its live row comes back, the wait goes", async () => {
    const { api, state, machines, queue, me } = setup();
    const running = {
      ...waitingReceipt,
      handled: [{ agentId: ATLAS_ID, runId: "r-atlas", status: "running" as const }],
    };
    const asked = said({ author: { type: "person", id: me }, receipts: running });
    state.messages.push(asked);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    const channelEvent = (event: Record<string, unknown>) => ({ type: "event", channelId: ENG_ID, event });
    const where = { channelId: ENG_ID, threadId: null, agentId: ATLAS_ID, runId: "r-atlas" };
    await act(async () => socket.push(channelEvent({ type: "agent.thinking", ...where })));
    await settle(4);
    expect(thinking()).toContain("pensando");
    await act(async () => socket.push(channelEvent(atlasWaits())));
    await settle(4);
    expect(turns()).toHaveLength(1);
    expect(thinking()).not.toContain("pensando");

    // Every event of the run starting is lost: only the reads say it.
    state.messages[state.messages.indexOf(asked)] = { ...asked, receipts: { ...running } };
    state.activeRuns = {
      [ENG_ID]: [
        {
          ...where,
          status: "running",
          triggerMessageId: "m-ask",
          startedAt: in_(-1),
          heartbeatAt: in_(0),
          createdAt: in_(-11),
          pendingMessageIds: [],
          background: false,
        } as unknown as ActiveRun,
      ],
    };
    machines?.setQueue(lineWithout(queue, "r-atlas"));
    await backOnTheTab();
    expect(turns()).toHaveLength(0);
    expect(thinking()).toContain("pensando");
  });

  test("a receipt that says the line beside the run's live row is no second row", async () => {
    const { api, state, me } = setup();
    const running = {
      ...waitingReceipt,
      handled: [{ agentId: ATLAS_ID, runId: "r-atlas", status: "running" as const }],
    };
    const author = { type: "person" as const, id: me };
    state.messages.push(said({ author, receipts: running }));
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(10);
    const channelEvent = (event: Record<string, unknown>) => ({ type: "event", channelId: ENG_ID, event });
    const where = { channelId: ENG_ID, threadId: null, agentId: ATLAS_ID, runId: "r-atlas" };
    const message = said({ id: "m-again", author, body: "?", mentionedAgentIds: [] });
    await act(async () => {
      socket.push(channelEvent({ type: "agent.thinking", ...where }));
      socket.push(channelEvent({ type: "message.created", channelId: ENG_ID, message }));
      // Read while it asked, told just after the computer took the turn.
      socket.push(channelEvent({ type: "agent.run.steered", ...where, messageId: "m-again", computer: "queued" }));
    });
    await settle(6);
    expect(thinking()).toContain("pensando");
    expect(turns()).toHaveLength(0);
  });
});

describe("an offline computer's note", () => {
  test("the time away is a pill on the author line, not in the card's text", async () => {
    const { api, state } = setup();
    const machineId = fakeMachinesOf.get(api)?.all()[0]?.id ?? "";
    fakeMachinesOf.get(api)?.setOutages({
      outages: [
        {
          machineId,
          name: "Studio",
          platform: "linux",
          offlineSince: new Date(Date.now() - 3 * 60_000).toISOString(),
          agents: [{ agentId: ADA_ID, name: "Ada", brain: "claude_code", waiting: { routines: 0, conversations: 1 } }],
          waitingRuns: 1,
        },
      ],
      targets: [],
    });
    state.messages.push(
      said({
        id: "m-wait",
        author: { type: "agent", id: ADA_ID },
        body: "Claude Code is offline.",
        mentionedAgentIds: [],
        meta: {
          bodyCode: "brain_unavailable",
          bodyParams: { brain: "Claude Code" },
          brainUnavailable: { brain: "claude_code", code: "machine_offline", machineId, agentId: ADA_ID },
        },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const pill = row("m-wait").querySelector(".ac-msg__head .cq-away");
    expect(pill?.textContent).toBe("Fora há 3 min");
    expect(row("m-wait").querySelector(".rq-open")?.textContent).not.toContain("3 min");
  });
});

test("pills never wrap; the pair row before a reply is one 26px line that wraps whole, its names never cut", async () => {
  const css = await builtCss("src/styles.css", "src/components/computer-queue.css");
  const value = (selector: string, property: string) =>
    declarations(css, selector).findLast(([p]) => p === property)?.[1];
  expect(value(".ac-chip", "white-space")).toBe("nowrap");
  expect(value(".cq-link", "white-space")).toBe("nowrap");
  // One centred sentence: 26 tall on one line, names too long for it wrap at their spaces, each face with its first word.
  expect(value(".consult-pair__row", "white-space")).toBeUndefined();
  expect(value(".consult-pair__row", "min-height")).toBe("26px");
  expect(value(".consult-pair__row", "overflow-wrap")).toBe("anywhere");
  expect(value(".consult-pair__who", "white-space")).toBe("nowrap");
  expect(value(".consult-pair__who>.consult-pair__name", "white-space")).toBe("normal");
  expect(value(".consult-pair__name", "text-overflow")).toBeUndefined();
});

test("a narrow header fits: the waiting count alone beside the computer, the names give way before any button", async () => {
  const css = await builtCss(
    "src/styles.css",
    "src/components/channel-header.css",
    "src/components/computer-queue.css",
    "src/components/browser/browser.css",
  );
  const value = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector).findLast(([p]) => p === property)?.[1];
  // Wide: the words, no badge.
  const wide = topLevel(css);
  expect(value(wide, ".cq-btn .cq-btn__count", "display")).toBe("none");
  expect(value(wide, ".cq-btn.ac-btn", "white-space")).toBe("nowrap");
  // At 390 and 360 (under 640): the words go to screen readers only, the count shows.
  const phone = atRule(css, "@media (max-width: 640px)");
  expect(value(phone, ".cq-btn .cq-btn__label", "position")).toBe("absolute");
  expect(value(phone, ".cq-btn .cq-btn__label", "width")).toBe("1px");
  expect(value(phone, ".cq-btn .cq-btn__count", "display")).toBe("inline-block");
  expect(value(phone, ".brw-dm .brw-dm__label", "position")).toBe("absolute");
  // Buttons keep their size; the title and its line wrap whole, never cut, and the glyphs go under them instead.
  const narrow = atRule(css, "@media (max-width: 760px)");
  expect(value(narrow, ".channel__header", "flex-wrap")).toBe("nowrap");
  expect(value(narrow, ".channel__header>.ac-btn", "flex")).toBe("none");
  expect(value(narrow, ".channel__header>.ac-acts", "flex")).toBe("none");
  expect(value(narrow, ".channel__header>.channel__acts", "column-gap")).toBeUndefined();
  expect(value(narrow, ".channel__title", "text-overflow")).toBeUndefined();
  expect(value(narrow, ".channel__title", "overflow-wrap")).toBe("anywhere");
  expect(value(narrow, ".channel__title", "min-width")).toBe("0");
  expect(value(narrow, ".channel__topic", "text-overflow")).toBeUndefined();
});
