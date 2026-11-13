import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState(), api = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
/**
 * The reply moved under João's post and that thread opened beside the channel: a thread view has no panel of its
 * own, so the card there opens in place (in the channel it opens the two agents' conversation in the panel).
 */
const openInThread = async (state: ReturnType<typeof seedState>) => {
  const reply = state.messages.at(-1) as (typeof state.messages)[number];
  reply.threadId = "m-1";
  const api = createFakeApi(state);
  await state.openThread?.(ORG_ID, "m-1", reply.createdAt);
  const r = await open(state, api);
  const channel = screen().getByRole("region", { name: /Mensagens/ });
  await act(async () => fireEvent.click(within(channel).getByRole("button", { name: /1 resposta/ })));
  await settle(6);
  return { ...r, thread: screen().getByRole("complementary", { name: "Thread" }) };
};
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>, channelId = ENG_ID) =>
  act(async () => socket.push({ type: "event", channelId, event: { channelId, ...event } }));
const rowWith = (text: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(text)) as HTMLElement;
const typingBar = () => document.querySelector(".ac-typing") as HTMLElement;
const bar = () => typingBar().querySelector(".ac-typing__text")?.textContent ?? "";

const QUESTION = "Como subo um fix em staging hoje?";
const ANSWER = "**Staging** sobe sozinho quando o PR entra.\n\nHoje use a fila reserva.";

function withReply(meta: Record<string, unknown>, body = "Já subi o fix em staging.") {
  const state = seedState();
  state.messages.push({
    id: "msg-reply",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body,
    mentionedAgentIds: [],
    agentRunId: "r-reply",
    meta,
    createdAt: new Date().toISOString(),
  });
  return state;
}

/** The pair row right before the reply carrying `text`. */
const pairOf = (text: string) => {
  const before = rowWith(text).previousElementSibling as HTMLElement | null;
  return before?.classList.contains("consult-pair") ? before : null;
};
const pairButton = (pair: HTMLElement | null) => pair?.querySelector("button") as HTMLElement;

describe("a reply's `meta.consulted`: the pair row before it", () => {
  test("in a channel: the two faces and names, no preview; a click opens the panel (a toggle), never in place", async () => {
    await open(
      withReply({
        consulted: [
          { agentId: ATLAS_ID, consultationId: "k1", status: "answered", question: QUESTION, answer: ANSWER },
        ],
      }),
    );
    const pair = pairOf("Já subi o fix") as HTMLElement;
    expect(pair).not.toBeNull();
    expect([...pair.querySelectorAll(".consult-pair__name")].map((n) => n.textContent)).toEqual(["Ada", "Atlas"]);
    expect(pair.textContent).not.toContain("Staging");
    // No times on `meta.consulted`: the row says nothing after the names.
    expect(pair.querySelector(".consult-pair__sep")).toBeNull();
    const button = pairButton(pair);
    expect(button.getAttribute("aria-expanded")).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(button));
    await settle(3);
    expect(pair.querySelector(".consult-pair__detail")).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  test("in a thread (no panel): the row opens in place to the question, the answer and who saw it", async () => {
    await openInThread(
      withReply({
        consulted: [
          { agentId: ATLAS_ID, consultationId: "k1", status: "answered", question: QUESTION, answer: ANSWER },
        ],
      }),
    );
    const pair = pairOf("Já subi o fix") as HTMLElement;
    expect(pair).not.toBeNull();
    expect(pair.textContent).not.toContain("Staging");
    const button = pairButton(pair);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(button));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const body = pair.querySelector(".consult-pair__detail") as HTMLElement;
    expect(body.textContent).toContain("Ada perguntou");
    expect(body.textContent).toContain(QUESTION);
    expect(body.textContent).toContain("Resposta do Atlas");
    expect(body.querySelector("strong")?.textContent).toBe("Staging");
    expect(body.querySelector(".ac-consult__foot")?.textContent).toBe("Conversa só entre Ada e Atlas");
    await act(async () => fireEvent.click(button));
    expect(pair.querySelector(".consult-pair__detail")).toBeNull();
  });

  test("expired: 'não respondeu' in the warning tone, the face dimmed; opened, the question and why", async () => {
    await openInThread(
      withReply(
        {
          consulted: [{ agentId: ATLAS_ID, consultationId: "k2", status: "expired", question: QUESTION, answer: null }],
        },
        "O Atlas não respondeu. Quer que eu suba do jeito de sempre?",
      ),
    );
    const pair = pairOf("do jeito de sempre") as HTMLElement;
    expect(pair.querySelector(".consult-pair__row--bad .consult-pair__word")?.textContent).toBe("não respondeu");
    expect(pair.querySelectorAll(".consult-pair__off")).toHaveLength(1);
    await act(async () => fireEvent.click(pairButton(pair)));
    const body = pair.querySelector(".consult-pair__detail") as HTMLElement;
    expect(body.textContent).toContain(QUESTION);
    expect(body.textContent).toContain("O Atlas não respondeu a tempo");
  });

  test("an old reply's question with no id of its own: no conversation to open, it opens in place", async () => {
    await open(
      withReply({ consulted: [{ agentId: ATLAS_ID, status: "answered", question: QUESTION, answer: ANSWER }] }),
    );
    const pair = pairOf("Já subi o fix") as HTMLElement;
    const button = pairButton(pair);
    expect(button.getAttribute("aria-pressed")).toBeNull();
    await act(async () => fireEvent.click(button));
    expect(document.querySelector("aside.thread-panel")).toBeNull();
    expect(pair.querySelector(".consult-pair__detail")?.textContent).toContain(QUESTION);
  });

  test("people never read the relay line the server opens a mention to an agent with", async () => {
    const relayed = `[@ada mentioned you in #engenharia, where you aren't a member, so it reaches you here]\n\n${QUESTION}`;
    await openInThread(
      withReply({
        consulted: [
          {
            agentId: ATLAS_ID,
            consultationId: "k1",
            kind: "note",
            status: "answered",
            question: relayed,
            answer: ANSWER,
          },
        ],
      }),
    );
    const pair = pairOf("Já subi o fix") as HTMLElement;
    await act(async () => fireEvent.click(pairButton(pair)));
    const body = pair.querySelector(".consult-pair__detail") as HTMLElement;
    expect(body.textContent).toContain(QUESTION);
    expect(body.textContent).not.toContain("mentioned you");
  });

  test("two questions to one agent, one failed: one row, '1 de 2 responderam'", async () => {
    await open(
      withReply({
        consulted: [
          { agentId: ATLAS_ID, consultationId: "k3", status: "failed", question: QUESTION, answer: null },
          {
            agentId: ATLAS_ID,
            consultationId: "k4",
            status: "answered",
            question: "E o banco?",
            answer: "Em manutenção.",
          },
        ],
      }),
    );
    expect(document.querySelectorAll(".consult-pair")).toHaveLength(1);
    const pair = pairOf("Já subi o fix") as HTMLElement;
    expect(pair.querySelector(".consult-pair__word")?.textContent).toBe("1 de 2 responderam");
    expect(pair.textContent).not.toContain("Em manutenção");
  });
});

describe("what came of work handed off (a `consult_reply` notice with `kind` `note`)", () => {
  /** Ada's conversation got what Atlas did with the work she handed it. */
  const withResult = (status: string, answer: string | null) => {
    const state = seedState();
    state.messages.push({
      id: "msg-result",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: answer ?? "",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        notice: {
          kind: "consult_reply",
          text: answer ?? "",
          from: "@atlas",
          refs: {
            kind: "note",
            consultationId: "k9",
            runId: "r-handed",
            askerAgentId: ADA_ID,
            agentId: ATLAS_ID,
            status,
            question: "Passa a pasta ao Diogo e confirma que ele abre.",
            ...(answer ? { answer } : {}),
          },
        },
      },
      createdAt: new Date().toISOString(),
    });
    return state;
  };

  test("its row opened in place says what Ada wrote, not what she asked", async () => {
    const { thread } = await openInThread(withResult("answered", "Passei a pasta; o Diogo abriu."));
    const pair = thread.querySelector(".consult-pair") as HTMLElement;
    expect(pair.textContent).not.toContain("Passei a pasta");
    await act(async () => fireEvent.click(pairButton(pair)));
    const body = pair.querySelector(".consult-pair__detail") as HTMLElement;
    expect(body.textContent).toContain("Ada escreveu");
    expect(body.textContent).not.toContain("Ada perguntou");
    expect(body.textContent).toContain("Passa a pasta ao Diogo");
  });

  test("one that couldn't be finished says so", async () => {
    await open(withResult("failed", null));
    expect(document.querySelector(".consult-pair__word")?.textContent).toBe("não terminou");
  });
});

describe("an agent that joined on its own (meta.joined)", () => {
  test("a faint 'entrou na conversa' next to the time, with a tip that says why", async () => {
    await open(withReply({ joined: true }, "Só um ponto: o vídeo fica pronto no dia 26."));
    const row = rowWith("o vídeo fica pronto");
    const note = row.querySelector(".ac-msg__note") as HTMLElement;
    expect(note.getAttribute("tabindex")).toBe("0");
    expect(note.textContent).toContain("entrou na conversa");
    expect(document.getElementById(note.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Ninguém chamou a Ada. Ela entrou para ajudar.",
    );
    // The glass tip that shows it to the eye opens over the page, as the time's details do.
    await act(async () => fireEvent.pointerEnter(note, { pointerType: "mouse" }));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    const tip = document.querySelector(".ac-tip.ac-msg__note-tip");
    expect(tip?.textContent).toBe("Ninguém chamou a Ada. Ela entrou para ajudar.");
    expect(tip?.parentElement).toBe(document.body);
    // Others' replies don't say it.
    expect(rowWith("Achei a causa")?.querySelector(".ac-msg__note") ?? null).toBeNull();
  });
});

describe("the working line while an agent asks another", () => {
  test("'Ada está perguntando para Atlas…' with both bodies and a clock → 'Atlas respondeu. Ada está escrevendo…' → the reply", async () => {
    const { socket } = await open();
    const run = { threadId: null, runId: "r-ask", agentId: ADA_ID };
    await push(socket, { type: "agent.thinking", ...run });
    await settle();
    expect(bar()).toBe("Ada pensando…");
    await push(socket, { type: "agent.tool", ...run, tool: "ask_agent" });
    await push(socket, { type: "agent.consulting", ...run, consultedAgentId: ATLAS_ID });
    // The asking run pauses while it waits.
    await push(socket, { type: "agent.idle", ...run });
    await push(socket, { type: "run.finished", ...run, status: "waiting_input" });
    await settle();
    expect(bar()).toBe("Ada está perguntando para Atlas…");
    expect(typingBar().querySelectorAll(".ac-typing__text b")).toHaveLength(2);
    expect(typingBar().querySelectorAll(".ac-typing__tok .ac-avatar--agent")).toHaveLength(2);
    expect(typingBar().querySelector(".ac-typing__to svg")).not.toBeNull();
    // The one asked is thinking.
    expect(typingBar().querySelectorAll(".ac-typing__tok")[1]?.querySelector(".ac-avatar--thinking")).not.toBeNull();
    const clock = typingBar().querySelector(".ac-typing__clock") as HTMLElement;
    expect(clock.className).toContain("ac-num");
    expect(clock.textContent).toMatch(/^\d+:\d\d$/);
    // Both faces open the pill: no pixel orbit beside them.
    expect(typingBar().querySelector(".ac-pixspin")).toBeNull();
    await push(socket, { type: "agent.consulted", ...run, consultedAgentId: ATLAS_ID, status: "answered" });
    await push(socket, { type: "agent.thinking", ...run });
    await settle();
    expect(bar()).toBe("Atlas respondeu. Ada está escrevendo…");
    expect(typingBar().querySelector(".ac-typing__clock")).toBeNull();
    await push(socket, { type: "agent.typing", ...run });
    await settle();
    // Writing now: the question is over; the card stays on while she works, her words waiting for her reply.
    expect(bar()).toBe("Ada escrevendo…");
    expect(typingBar().querySelector(".ac-typing__to")).toBeNull();
  });

  test("several agents: one line, stacked, 'Ada e Atlas estão trabalhando…'; it shrinks as each one finishes", async () => {
    const { socket } = await open();
    await push(socket, { type: "agent.thinking", threadId: null, runId: "r-a", agentId: ADA_ID });
    await push(socket, { type: "agent.thinking", threadId: null, runId: "r-b", agentId: ATLAS_ID });
    await settle();
    expect(bar()).toBe("Ada e Atlas estão trabalhando…");
    expect(typingBar().querySelectorAll(".ac-typing__tok")).toHaveLength(2);
    await push(socket, { type: "agent.idle", threadId: null, runId: "r-b", agentId: ATLAS_ID });
    await settle();
    expect(bar()).toBe("Ada pensando…");
    // Alone, at work with no row in the conversation: the bar keeps its face.
    expect(typingBar().querySelectorAll(".ac-typing__tok")).toHaveLength(1);
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    expect(typingBar().querySelectorAll(".ac-typing__tok")).toHaveLength(1);
  });
});
