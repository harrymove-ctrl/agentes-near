import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentAction, LiveWork, Message, Run } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { LiveTools, SavedTools } from "@/components/ToolCalls";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 13, 0, s)).toISOString();
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const click = async (el: Element, init: MouseEventInit = {}) => {
  await act(async () => fireEvent.click(el, init));
  await settle(4);
};
const call = (id: string, tool: string, over: Partial<LiveWork> = {}): LiveWork =>
  ({
    kind: "call",
    id,
    tool,
    connector: null,
    detail: null,
    code: null,
    output: [],
    running: false,
    ms: 900,
    ...over,
  }) as LiveWork;

/** A live block whose work the test moves on (`show`), inside the page's providers. */
let show: (work: LiveWork[], done: boolean) => void = () => {};
function Live({ work, done }: { work: LiveWork[]; done: boolean }) {
  const [now, setNow] = useState({ work, done });
  show = (w, d) => setNow({ work: w, done: d });
  return <LiveTools work={now.work} agentName="Ada" done={now.done} />;
}
const rerender = (work: LiveWork[], done = false) => act(async () => show(work, done));

describe("one call is its own line, with no 'Usou 1 ferramenta' to open", () => {
  test("live: the call's own line (its phrase, time and mark); a second call brings the block back", async () => {
    const api = createFakeApi(seedState());
    await renderPage(<Live work={[call("1", "create_routine")]} done />, { api, org: true });
    const block = document.querySelector(".ac-tools") as HTMLElement;
    expect(block.querySelector(".ac-tools__head")).toBeNull();
    expect(block.textContent).not.toContain("Usou 1 ferramenta");
    const row = block.querySelector(".ac-tools__row") as HTMLElement;
    expect(row.querySelector("b")?.textContent).toBe("Criou uma rotina");
    expect(row.querySelector(".ac-tools__time")?.textContent).toBe("900 ms");
    expect(row.querySelector(".ac-pixdone")).not.toBeNull();
    // Still at work: the same line says what it does now.
    await rerender([call("1", "create_routine", { running: true })]);
    await settle(2);
    expect(document.querySelector(".ac-tools__row b")?.textContent).toBe("Criando uma rotina…");
    expect(document.querySelector(".ac-tools__head")).toBeNull();
    await rerender([call("1", "create_routine"), call("2", "create_issue")], true);
    await settle(2);
    expect(document.querySelector(".ac-tools__head .ac-tools__text")?.textContent).toBe("Usou 2 ferramentas");
  });

  test("saved: its line from meta.work, the call's own time and outcome; opening it loads what it got and gave", async () => {
    const api = createFakeApi(seedState());
    const asked: string[] = [];
    api.agents.run = async (_orgId, runId) => {
      asked.push(runId);
      return {
        run: { id: runId, createdAt: at(0), finishedAt: at(4) } as Run,
        steps: [
          {
            seq: 1,
            kind: "tool_call",
            data: { toolUseId: "t1", name: "create_routine", input: { name: "Relatório semanal" } },
            createdAt: at(1),
          },
          {
            seq: 2,
            kind: "tool_result",
            data: { toolUseId: "t1", isError: false, content: "Rotina criada." },
            createdAt: at(2),
          },
        ],
      };
    };
    const work = { steps: 1, calls: [{ name: "create_routine" }], durationMs: 4000, ms: 870 };
    await renderPage(<SavedTools runId="r-1" meta={{ work }} agentName="Ada" />, { api, org: true });
    await settle(2);
    const block = document.querySelector(".ac-tools") as HTMLElement;
    expect(block.querySelector(".ac-tools__head")).toBeNull();
    const row = block.querySelector("button.ac-tools__row") as HTMLElement;
    expect(row.querySelector("b")?.textContent).toBe("Criou uma rotina");
    expect(row.querySelector(".ac-tools__time")?.textContent).toBe("870 ms");
    expect(asked).toEqual([]);
    await click(row);
    expect(asked).toEqual(["r-1"]);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const detail = block.querySelector(".ac-tools__detail") as HTMLElement;
    expect(detail.textContent).toContain("Relatório semanal");
    expect(detail.textContent).toContain("Rotina criada.");
  });

  test("saved: a lone call that failed says so; one saved before meta.work had its time reads the reply's", async () => {
    const api = createFakeApi(seedState());
    await renderPage(
      <>
        <SavedTools
          runId="r-1"
          meta={{ work: { steps: 1, calls: [{ name: "create_routine" }], durationMs: 4000, ms: 300, failed: true } }}
          agentName="Ada"
        />
        <SavedTools
          runId="r-2"
          meta={{ work: { steps: 1, calls: [{ name: "create_issue" }], durationMs: 4000 } }}
          agentName="Ada"
        />
        <SavedTools
          runId="r-3"
          meta={{ work: { steps: 2, calls: [{ name: "create_issue" }], durationMs: 4000 } }}
          agentName="Ada"
        />
      </>,
      { api, org: true },
    );
    await settle(2);
    const [failed, old, two] = [...document.querySelectorAll<HTMLElement>(".ac-tools")];
    expect(failed?.querySelector(".ac-tools__row b")?.textContent).toBe("Deu erro criando uma rotina");
    expect(failed?.querySelector(".ac-pixfail")).not.toBeNull();
    expect(old?.querySelector(".ac-tools__row b")?.textContent).toBe("Criou uma tarefa");
    expect(old?.querySelector(".ac-tools__time")?.textContent).toBe("4 s");
    expect(two?.querySelector(".ac-tools__head .ac-tools__text")?.textContent).toBe("Usou 2 ferramentas");
  });
});

describe("a lone quick read that only fed the answer shows no card", () => {
  test("live: checking its usage shows while it runs, then goes; a second step brings the block", async () => {
    const api = createFakeApi(seedState());
    await renderPage(<Live work={[call("1", "get_my_usage", { running: true })]} done={false} />, { api, org: true });
    expect(document.querySelector(".ac-tools__row b")?.textContent).toBe("Conferindo o próprio uso…");
    await rerender([call("1", "get_my_usage", { ms: 33 })], true);
    await settle(2);
    expect(document.querySelector(".ac-tools")).toBeNull();
    expect(document.body.textContent).not.toContain("Conferiu o próprio uso");
    await rerender([call("1", "get_my_usage", { ms: 33 }), call("2", "search_context")], true);
    await settle(2);
    expect(document.querySelector(".ac-tools__head .ac-tools__text")?.textContent).toBe("Usou 2 ferramentas");
    // One that failed, or took long, keeps its line.
    await rerender([call("1", "get_my_usage", { failed: true })], true);
    await settle(2);
    expect(document.querySelector(".ac-tools__row b")?.textContent).toBe("Deu erro conferindo o próprio uso");
    await rerender([call("1", "get_my_usage", { ms: 6000 })], true);
    await settle(2);
    expect(document.querySelector(".ac-tools__row b")?.textContent).toBe("Conferiu o próprio uso");
  });

  test("saved: the run's lone quick read is no card; one that failed or changed something is", async () => {
    const api = createFakeApi(seedState());
    await renderPage(
      <>
        <SavedTools
          runId="r-1"
          meta={{ work: { steps: 1, calls: [{ name: "get_my_usage" }], durationMs: 2000, ms: 33 } }}
          agentName="Ada"
        />
        <SavedTools
          runId="r-2"
          meta={{ work: { steps: 1, calls: [{ name: "get_my_usage" }], durationMs: 2000, ms: 40, failed: true } }}
          agentName="Ada"
        />
        <SavedTools
          runId="r-3"
          meta={{ work: { steps: 1, calls: [{ name: "create_routine" }], durationMs: 2000, ms: 40 } }}
          agentName="Ada"
        />
      </>,
      { api, org: true },
    );
    await settle(2);
    expect([...document.querySelectorAll(".ac-tools__row b")].map((b) => b.textContent)).toEqual([
      "Deu erro conferindo o próprio uso",
      "Criou uma rotina",
    ]);
  });
});

describe("the browser's card says what it did: no 'Ver o que ele fez' that opens on nothing", () => {
  test("only browser steps (on their card): no block; besides them, the one call left is its own line", async () => {
    const api = createFakeApi(seedState());
    const asked: string[] = [];
    api.agents.run = async (_orgId, runId) => {
      asked.push(runId);
      return {
        run: { id: runId, createdAt: at(0), finishedAt: at(43) } as Run,
        steps: [1, 2, 3].flatMap((i) => [
          {
            seq: i * 2 - 1,
            kind: "tool_call" as const,
            data: { toolUseId: `t${i}`, name: "browser_navigate", input: {} },
            createdAt: at(i),
          },
          {
            seq: i * 2,
            kind: "tool_result" as const,
            data: { toolUseId: `t${i}`, isError: false, content: "ok" },
            createdAt: at(i),
          },
        ]),
      };
    };
    await renderPage(
      <>
        <SavedTools
          runId="r-1"
          meta={{ work: { steps: 3, calls: [{ name: "browser_navigate" }], durationMs: 43_000 } }}
          agentName="Ada"
          skipScreens={["browser"]}
        />
        <SavedTools
          runId="r-2"
          meta={{
            work: {
              steps: 4,
              calls: [
                { name: "browser_navigate", n: 3 },
                { name: "create_issue", n: 1 },
              ],
              durationMs: 43_000,
            },
          }}
          agentName="Ada"
          skipScreens={["browser"]}
        />
      </>,
      { api, org: true },
    );
    await settle(2);
    const blocks = [...document.querySelectorAll<HTMLElement>(".ac-tools")];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.querySelector(".ac-tools__head")).toBeNull();
    expect(blocks[0]?.querySelector(".ac-tools__row b")?.textContent).toBe("Criou uma tarefa");
    expect(document.body.textContent).not.toContain("Ver o que");
    expect(document.body.textContent).not.toContain("sem usar ferramentas");
    expect(asked).toEqual([]);
  });
});

describe("beside the browser's card, a lone quick read shows nothing, kept or saved", () => {
  test("saved: the call left beside the browser's steps is quiet when the server timed it", async () => {
    const api = createFakeApi(seedState());
    const meta = (extra: Record<string, unknown>) => ({
      work: {
        steps: 4,
        calls: [
          { name: "browser_navigate", n: 3 },
          { name: "get_my_usage", n: 1, ...extra },
        ],
        durationMs: 43_000,
      },
    });
    await renderPage(
      <>
        <SavedTools runId="r-1" meta={meta({ ms: 33 })} agentName="Ada" skipScreens={["browser"]} />
        <SavedTools runId="r-2" meta={meta({ ms: 33, failed: true })} agentName="Ada" skipScreens={["browser"]} />
      </>,
      { api, org: true },
    );
    await settle(2);
    expect([...document.querySelectorAll(".ac-tools__row b")].map((b) => b.textContent)).toEqual([
      "Deu erro conferindo o próprio uso",
    ]);
  });
});

/** Ada's answer with what it changed (a routine) and its one call, as the channel shows it. */
const ANSWER = "Pronto: toda segunda às 9h eu posto o relatório de pagamentos aqui.";
function answer(routineId: string, actions: Partial<AgentAction>[] = [{}]): Message {
  return {
    id: "m-answer",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: ANSWER,
    mentionedAgentIds: [],
    agentRunId: "r-answer",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    meta: { work: { steps: 1, calls: [{ name: "create_routine" }], durationMs: 2400, ms: 800 } },
    actions: actions.map((over, i) => ({
      id: `act-${i}`,
      kind: "routine.created",
      agentId: ADA_ID,
      messageId: "m-answer",
      requestedByUserId: "u-walter",
      target: { type: "routine", id: routineId, title: "Relatório de pagamentos" },
      params: { name: "Relatório de pagamentos" },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      undoableUntil: inMs(240_000),
      undoneAt: null,
      undoneByUserId: null,
      redoneAt: null,
      ...over,
    })) as AgentAction[],
  };
}

async function openChannel(messages: (routineId: string, issue: { number: number; title: string }) => Message[]) {
  const state = seedState();
  const api = createFakeApi(state);
  const routine = await api.routines.create(ORG_ID, {
    name: "Relatório de pagamentos",
    agentId: ADA_ID,
    prompt: "Poste o relatório de pagamentos.",
    target: { type: "channel", channelId: ENG_ID },
    trigger: { type: "schedule", phrase: "toda segunda às 9h" },
  } as never);
  const [issue] = await api.issues.list(ORG_ID);
  state.messages = messages(routine.id, { number: issue?.number ?? 0, title: issue?.title ?? "" });
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, routine, state, api };
}

/** The parts of a reply, top to bottom: its words, what it changed, its tools. */
const order = (row: HTMLElement) =>
  [...row.querySelectorAll(".ac-msg__text, .ag-rcs, .ac-tools")].map((el) =>
    el.classList.contains("ac-msg__text") ? "text" : el.classList.contains("ag-rcs") ? "receipts" : "tools",
  );

describe("the tools sit last, the moment it lands and once reloaded", () => {
  test("nothing while it works; the moment it lands and when opened later: its words, what it changed, its tools", async () => {
    const { socket, routine } = await openChannel(() => []);
    const ids = { threadId: null, runId: "r-answer", agentId: ADA_ID };
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.tool", ...ids, tool: "create_routine", toolUseId: "t1" });
    await ev({ type: "agent.tool", ...ids, tool: null, toolUseId: "t1" });
    await ev({ type: "agent.typing", ...ids });
    await settle(3);
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
    const saved = answer(routine.id);
    await ev({ type: "message.created", messageId: saved.id, message: saved });
    await ev({ type: "run.finished", ...ids, status: "done" });
    await settle(6);
    const landed = document.querySelector('[data-message-id="m-answer"]') as HTMLElement;
    expect(order(landed)).toEqual(["text", "receipts", "tools"]);
    cleanup();

    await openChannel((id) => [answer(id)]);
    const reloaded = document.querySelector('[data-message-id="m-answer"]') as HTMLElement;
    expect(order(reloaded)).toEqual(["text", "receipts", "tools"]);
  });
});

describe("what waits for a person's click comes last", () => {
  test("a question the reply asks sits under the tools it kept from watching it work", async () => {
    const { socket, routine } = await openChannel(() => []);
    const ids = { threadId: null, runId: "r-answer", agentId: ADA_ID };
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.tool", ...ids, tool: "create_routine", toolUseId: "t1" });
    await ev({ type: "agent.tool", ...ids, tool: null, toolUseId: "t1" });
    await ev({ type: "agent.typing", ...ids });
    await settle(3);
    const m = answer(routine.id, []);
    const asking = {
      ...m,
      meta: {
        ...m.meta,
        question: {
          id: "q-1",
          agentId: ADA_ID,
          channelId: ENG_ID,
          threadId: null,
          messageId: "m-answer",
          text: "Posto às 9h ou às 10h?",
          choices: ["9h", "10h"],
          status: "open",
          answer: null,
          answeredByUserId: null,
        },
      },
    } as Message;
    await ev({ type: "message.created", messageId: asking.id, message: asking });
    await ev({ type: "run.finished", ...ids, status: "done" });
    await settle(6);
    const row = document.querySelector('[data-message-id="m-answer"]') as HTMLElement;
    const parts = [...row.querySelectorAll(".ac-msg__text, .ac-tools, .rq")].map((el) =>
      el.classList.contains("rq") ? "card" : el.classList.contains("ac-tools") ? "tools" : "text",
    );
    expect(parts).toEqual(["text", "tools", "card"]);
  });
});

describe("a question for one person", () => {
  const card = (requestedForUserId: string | null) => {
    const m = answer("q-owner", []);
    return {
      ...m,
      meta: {
        ...m.meta,
        question: {
          id: "q-1",
          agentId: ADA_ID,
          channelId: ENG_ID,
          threadId: null,
          messageId: m.id,
          text: "Posto às 9h ou às 10h?",
          choices: ["9h", "10h"],
          requestedForUserId,
          status: "open",
          answer: null,
          answeredByUserId: null,
        },
      },
    } as Message;
  };

  test("for someone else: who it waits for, and nothing to press", async () => {
    await openChannel(() => [card("u-joao")]);
    const rq = document.querySelector(".rq") as HTMLElement;
    expect(rq.textContent).toContain("esperando João");
    expect(rq.textContent).not.toContain("esperando você");
    expect(within(rq).queryAllByRole("button")).toEqual([]);
    expect(rq.hasAttribute("data-ask-mine")).toBe(false);
  });

  test("for the viewer, or for anyone here: it waits on them, with its actions", async () => {
    for (const asked of [seedState().me?.user.id ?? "", null]) {
      await openChannel(() => [card(asked)]);
      const rq = document.querySelector(".rq") as HTMLElement;
      // It waits on them: no words for it on the card, its actions say it.
      expect(rq.hasAttribute("data-ask-mine")).toBe(true);
      expect(rq.textContent).not.toContain("esperando você");
      expect(within(rq).getByRole("button", { name: "9h" })).toBeTruthy();
      expect(within(rq).getByRole("button", { name: "Pular" })).toBeTruthy();
      cleanup();
    }
  });
});

describe("a receipt's words stay whole", () => {
  test("a receipt is its sentence alone: no Desfazer, no time, no room kept for one", async () => {
    await openChannel((id) => [answer(id, [{ undoableUntil: inMs(200_000) }])]);
    const receipt = document.querySelector(".ag-rc") as HTMLElement;
    expect(within(receipt).queryByRole("button")).toBeNull();
    expect(receipt.querySelector(".ag-rc__sentence")?.children).toHaveLength(1);
  });
});

describe("what a reply names opens over the conversation", () => {
  const channel = `/org/${ORG_ID}/c/${ENG_ID}`;

  test("the routine in a receipt: its dialog over the channel, the address the same; closing leaves the channel", async () => {
    const { router } = await openChannel((id) => [answer(id)]);
    const link = screen().getByRole("link", { name: "Relatório de pagamentos" });
    expect(link.getAttribute("href")).toContain("/routines?open=");
    await click(link);
    expect(router.state.location.pathname).toBe(channel);
    const dialog = screen().getByRole("dialog", { name: "Relatório de pagamentos" });
    expect(dialog.textContent).toContain("Poste o relatório de pagamentos.");
    expect(document.querySelector('[data-message-id="m-answer"]')).not.toBeNull();
    await click(within(dialog).getByRole("button", { name: "Fechar detalhes" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(router.state.location.pathname).toBe(channel);
    // A click with ⌘ leaves the link to the browser (a new tab): no dialog here.
    await click(link, { metaKey: true });
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("moving to another channel closes what was open over the last one", async () => {
    const { router } = await openChannel((id) => [answer(id)]);
    await click(screen().getByRole("link", { name: "Relatório de pagamentos" }));
    expect(screen().getByRole("dialog", { name: "Relatório de pagamentos" })).toBeTruthy();
    await act(async () => {
      await router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: GENERAL_ID } });
    });
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("the routine's tag on its message, a task and the memory in receipts open in place too", async () => {
    let task = { number: 0, title: "" };
    const { router } = await openChannel((id, issue) => {
      task = issue;
      return [
        {
          ...answer(id, [
            {
              kind: "issue.created",
              target: { type: "issue", id: "iss-1", number: issue.number, title: issue.title },
              params: { number: issue.number, title: issue.title },
            },
            { id: "act-mem", kind: "memory.saved", target: { type: "memory", id: "mem-1" }, params: { text: "x" } },
          ]),
          meta: { routine: { id, name: "Relatório de pagamentos" } },
        },
      ];
    });
    await click(screen().getByRole("link", { name: `#${task.number}` }));
    expect(router.state.location.pathname).toBe(channel);
    expect(screen().getByRole("dialog", { name: task.title })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(3);
    expect(screen().queryByRole("dialog")).toBeNull();

    await click(screen().getByRole("link", { name: /^Rotina «Relatório de pagamentos»/ }));
    expect(router.state.location.pathname).toBe(channel);
    expect(screen().getByRole("dialog", { name: "Relatório de pagamentos" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(3);

    await click(screen().getByRole("link", { name: "memória" }));
    expect(router.state.location.pathname).toBe(channel);
    const panel = screen().getByRole("complementary", { name: "Perfil da Ada" });
    expect(
      within(panel)
        .getByRole("tab", { name: /^Memória/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("a webhook routine the agent made", () => {
  test("its line copies the address, kept out of the message; a routine on a schedule has no such button", async () => {
    let clip = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clip = text;
        },
      },
    });
    const state = seedState();
    const api = createFakeApi(state);
    const hooked = await api.routines.create(ORG_ID, {
      name: "Avisar no general",
      agentId: ADA_ID,
      prompt: "Poste works no #general.",
      target: { type: "channel", channelId: ENG_ID },
      trigger: { type: "webhook" },
    });
    const made = (id: string, params: AgentAction["params"], n: string): Message => ({
      ...answer(id, [{ id: `act-${n}`, messageId: `m-${n}`, params }]),
      id: `m-${n}`,
    });
    state.messages = [
      made(hooked.id, { name: "Avisar no general", trigger: "webhook" }, "hook"),
      made("rt-schedule", { name: "Relatório", trigger: "schedule" }, "schedule"),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const buttons = screen().getAllByRole("button", { name: "Copiar endereço do webhook" });
    expect(buttons).toHaveLength(1);
    expect(document.querySelector('[data-message-id="m-schedule"]')?.textContent).not.toContain("Copiar endereço");
    await click(buttons[0] as HTMLElement);
    await settle(4);
    expect(clip).toBe((await api.routines.hook(ORG_ID, hooked.id)).url);
    expect(screen().getByText("URL do webhook copiada.")).toBeTruthy();
  });
});
