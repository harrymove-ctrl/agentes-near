import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, AgentAction, Message, MissionPlan } from "@agenteschat/client";
import { AGENT_ACTION_KINDS, keys } from "@agenteschat/client";
import { en, ptBR } from "@agenteschat/i18n";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { RECEIPT_ICONS } from "@/components/AgentActions";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let untouch: (() => void) | undefined;
afterEach(() => {
  cleanup();
  untouch?.();
  untouch = undefined;
});

/** A phone until the test ends: a finger, no hover, touch points (the message's own touch menu is on). */
const onTouch = () => {
  const media = spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("pointer: coarse") || query.includes("hover: none"),
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const points = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
  untouch = () => {
    media.mockRestore();
    if (points) Object.defineProperty(navigator, "maxTouchPoints", points);
    else delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
  };
};

const BODY = "Olhei o código: o prompt dispara em ReviewPrompt.swift:41.";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const action = (over: Partial<AgentAction> = {}): AgentAction => ({
  id: "act-1",
  kind: "issue.created",
  agentId: ADA_ID,
  messageId: "m-act",
  requestedByUserId: "u-walter",
  target: { type: "issue", id: "iss-23", number: 23, title: "Prompt de avaliação após a assinatura" },
  params: { number: 23, title: "Prompt de avaliação após a assinatura" },
  createdAt: inMs(-2_000),
  undoableUntil: inMs(298_000),
  undoneAt: null,
  undoneByUserId: null,
  redoneAt: null,
  ...over,
});

const priority = (over: Partial<AgentAction> = {}) =>
  action({
    id: "act-2",
    kind: "issue.updated",
    params: { number: 23, title: "Prompt", fields: ["priority"], priority: "high" },
    ...over,
  });
const memory = (over: Partial<AgentAction> = {}) =>
  action({
    id: "act-3",
    kind: "memory.saved",
    target: { type: "memory", id: "mem-9" },
    params: { text: "o prompt é por evento" },
    ...over,
  });

const withActions = (actions: AgentAction[], patch: (s: FakeState) => void = () => {}) => {
  const state = seedState();
  state.messages.push({
    id: "m-act",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: BODY,
    mentionedAgentIds: [],
    agentRunId: "r-act",
    createdAt: inMs(-3_000),
    actions,
  });
  patch(state);
  return state;
};

const open = async (state: FakeState) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};

const article = () =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes("Olhei o código")) as HTMLElement;
const receipts = () => within(article()).getByRole("group", { name: "Mudanças de Ada" });
const click = async (el: HTMLElement) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

describe("receipts under the agent's reply", () => {
  test("one change: a quiet row, one line whole in its tip, the target links to the issue, nothing else", async () => {
    // Who sees the task is the task's own: the receipt says nothing of it.
    await open(withActions([action({ params: { ...action().params, audience: "everyone" } })]));
    const group = receipts();
    const row = group.querySelector(".ag-rc") as HTMLElement;
    expect(row.textContent).toBe("Criei a tarefa #23 · Prompt de avaliação após a assinatura");
    const line = row.querySelector(".ag-rc__sentence") as HTMLElement;
    expect(line.className).toContain("ag-rc__line");
    expect(line.title).toBe("Criei a tarefa #23 · Prompt de avaliação após a assinatura");
    const link = within(group).getByRole("link", { name: "#23" });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/23`);
    expect(within(group).queryAllByRole("button")).toHaveLength(0);
    // A single receipt has no group header.
    expect(group.querySelector(".ag-rcg__hd")).toBeNull();
  });

  test("tasks made together are one line: 'Criei as tarefas #58, #59 e #60', each number its own task, each whole in the tip", async () => {
    const made = (n: number) => {
      const title = `Página de preços: o botão Assinar não responde no tablet ${n}`;
      return action({
        id: `act-${n}`,
        target: { type: "issue", id: `iss-${n}`, number: n, title },
        params: { number: n, title, audience: "everyone" },
      });
    };
    await open(withActions([made(58), memory(), made(59), made(60)]));
    const group = receipts();
    expect(group.querySelector(".ag-rcg__hd")?.textContent).toBe("4 mudanças · agora");
    const rows = [...group.querySelectorAll<HTMLElement>(".ag-rcg__it")];
    expect(rows.map((r) => r.textContent)).toEqual([
      "Criei as tarefas #58, #59 e #60",
      "Guardei na memória: o prompt é por evento",
    ]);
    const tasks = rows[0] as HTMLElement;
    expect(
      within(tasks)
        .getAllByRole("link")
        .map((l) => [l.textContent, l.getAttribute("href")]),
    ).toEqual([58, 59, 60].map((n) => [`#${n}`, `/org/${ORG_ID}/issues/${n}`]));
    expect(tasks.querySelector<HTMLElement>(".ag-rc__line")?.title).toBe(
      [58, 59, 60]
        .map((n) => `Criei a tarefa #${n} · Página de preços: o botão Assinar não responde no tablet ${n}`)
        .join("\n"),
    );
    expect(group.textContent).not.toContain("Quem vê");
  });

  test("a created routine says what it does on its own, without asking", async () => {
    await open(
      withActions([
        action({
          kind: "routine.created",
          target: { type: "routine", id: "rt-1", title: "Resumo da semana" },
          params: { name: "Resumo da semana", ownActions: ["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"] },
        }),
      ]),
    );
    const row = receipts().querySelector(".ag-rc") as HTMLElement;
    expect(row.textContent).toContain("Criei a rotina Resumo da semana");
    expect(row.textContent).toContain("Faz sozinha, sem pedir: Enviar mensagem (Slack) e Enviar e-mail (Gmail)");
  });

  test("a changed routine: its tile icon at the 14px text's 16px, a real space before its bold name", async () => {
    await open(
      withActions([
        action({
          kind: "routine.updated",
          target: { type: "routine", id: "rt-1", title: "Resumo da semana" },
          params: { name: "Resumo da semana", fields: ["prompt"] },
        }),
      ]),
    );
    const row = receipts().querySelector(".ag-rc") as HTMLElement;
    const sentence = row.querySelector(".ag-rc__sentence") as HTMLElement;
    // The sentence is its words alone: nothing ends it.
    expect(sentence.textContent).toBe("Mudei o pedido da rotina Resumo da semana");
    expect(sentence.querySelector(".ag-rc__target")?.previousSibling?.textContent).toEndWith("rotina ");
    expect((row.querySelector(".ag-rc__ic svg") as SVGElement).style.width).toBe("16px");
  });

  test("several: 'N mudanças · agora' and one row each, with no Desfazer anywhere", async () => {
    await open(withActions([action(), priority(), memory()]));
    const group = receipts();
    expect(group.querySelector(".ag-rcg__hd")?.textContent).toBe("3 mudanças · agora");
    expect(within(group).queryAllByRole("button")).toHaveLength(0);
    expect(group.textContent).not.toContain("Desfazer");
    expect(group.textContent).toContain("Prioridade alta na #23");
    expect(group.textContent).toContain("Guardei na memória: o prompt é por evento");
  });

  test("a memory's link opens that memory: its page at the item, and in a conversation Memória beside it, landed on it", async () => {
    await open(withActions([memory({ target: { type: "memory", id: "mem-5" } })]));
    const link = within(receipts()).getByRole("link", { name: "memória" });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/agents/${ADA_ID}/memory?item=mem-5`);
    await click(link);
    await settle(6);
    const panel = document.querySelector(".thread-panel") as HTMLElement;
    expect(
      within(panel)
        .getByRole("tab", { name: /Memória/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    const landed = [...panel.querySelectorAll<HTMLElement>(".is-landed")];
    expect(landed.map((el) => el.dataset.itemId)).toEqual(["mem-5"]);
    expect(landed[0]?.textContent).toContain("O login usa tokens de 15 minutos");
  });

  test("a skill's link opens the skill in Skills for who manages agents", async () => {
    await open(
      withActions([
        action({
          kind: "skill.updated",
          target: { type: "skill", id: "sk-1", title: "deploy" },
          params: { name: "deploy" },
        }),
      ]),
    );
    const link = receipts().querySelector("a.ag-rc__target") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/settings/skills?skill=sk-1`);
  });

  test("one undone before stays as history: struck through, 'Desfeito por …', nothing to press", async () => {
    await open(
      withActions([
        action({ undoableUntil: inMs(200_000) }),
        memory({ undoneAt: inMs(-60_000), undoneByUserId: "u-joao" }),
      ]),
    );
    const group = receipts();
    expect(within(group).queryAllByRole("button")).toHaveLength(0);
    const rows = [...group.querySelectorAll(".ag-rcg__it")] as HTMLElement[];
    expect(rows.map((r) => r.className.includes("is-undone"))).toEqual([false, true]);
    expect(rows[1]?.textContent).toContain("Desfeito por João");
    // The line under a row is one line too, cut with "…", whole in its tip.
    const by = rows[1]?.querySelector(".ag-rc__by") as HTMLElement;
    expect(by.className).toContain("ag-rc__line");
    expect(by.title).toBe("Desfeito por João");
  });

  test("the files a change brought: one line of their own under it", async () => {
    await open(withActions([action({ params: { ...action().params, files: ["print.png", "registro.txt"] } })]));
    const row = receipts().querySelector(".ag-rc") as HTMLElement;
    const files = row.querySelector(".ag-rc__by") as HTMLElement;
    expect(files.textContent).toBe("Anexei print.png e registro.txt");
    expect(files.className).toContain("ag-rc__line");
  });

  test("on a phone, a tap on a row's words lists each change whole, each opening its own; the message's menu stays shut", async () => {
    onTouch();
    const issues = (await createFakeApi(seedState()).issues.list(ORG_ID)).slice(0, 2);
    const made = (i: { id: string; number: number; title: string }) =>
      action({
        id: `act-${i.number}`,
        target: { type: "issue", id: i.id, number: i.number, title: i.title },
        params: { number: i.number, title: i.title },
      });
    const merged = action({
      id: "act-pr",
      kind: "pr.merged",
      target: { type: "repository", id: "acme/loja", title: "acme/loja" },
      params: { repo: "acme/loja", number: 12 },
    });
    await open(withActions([...issues.map(made), merged]));
    const rows = [...receipts().querySelectorAll<HTMLElement>(".ag-rcg__it")];
    const words = rows[0]?.querySelector(".ag-rc__sentence") as HTMLElement;
    // No tip with no hover: the words are the list's button instead.
    expect(words.title).toBe("");
    expect(words.getAttribute("role")).toBe("button");
    expect(words.tabIndex).toBe(0);
    await click(words);
    const list = screen().getByRole("dialog", { name: "Mudanças de Ada" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((l) => [l.textContent, l.getAttribute("href")]),
    ).toEqual(issues.map((i) => [`Criei a tarefa #${i.number} · ${i.title}`, `/org/${ORG_ID}/issues/${i.number}`]));
    expect(screen().queryAllByRole("menu")).toHaveLength(0);
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(3);
    expect(screen().queryByRole("dialog", { name: "Mudanças de Ada" })).toBeNull();
    // Closed, the focus is back on the words that opened it.
    expect(document.activeElement).toBe(words);
    // Enter opens it from the keys too.
    await act(async () => fireEvent.keyDown(words, { key: "Enter" }));
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Mudanças de Ada" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(3);
    // A change with nothing to open is said whole there too, as words.
    await click(rows[1]?.querySelector(".ag-rc__sentence") as HTMLElement);
    const merge = screen().getByRole("dialog", { name: "Mudanças de Ada" });
    expect(within(merge).queryAllByRole("link")).toHaveLength(0);
    expect(merge.textContent).toContain("Fiz o merge do PR #12 em acme/loja");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(3);
  });

  test("on a phone, a tap on a number opens its task: neither the list nor the message's menu", async () => {
    onTouch();
    const issues = (await createFakeApi(seedState()).issues.list(ORG_ID)).slice(0, 2);
    await open(
      withActions(
        issues.map((i) =>
          action({
            id: `act-${i.number}`,
            target: { type: "issue", id: i.id, number: i.number, title: i.title },
            params: { number: i.number, title: i.title },
          }),
        ),
      ),
    );
    const second = issues[1] as { number: number; title: string };
    const number = within(receipts()).getByRole("link", { name: `#${second.number}` });
    // Enter on the number, from the keys, is the number's own: it never opens the list around it.
    number.focus();
    await act(async () => fireEvent.keyDown(number, { key: "Enter" }));
    await settle(3);
    expect(screen().queryByRole("dialog", { name: "Mudanças de Ada" })).toBeNull();
    await click(number);
    expect(screen().queryByRole("dialog", { name: "Mudanças de Ada" })).toBeNull();
    expect(screen().queryAllByRole("menu")).toHaveLength(0);
    expect(screen().getByRole("dialog", { name: second.title })).toBeTruthy();
  });

  test("several memories saved: each one's words open that memory", async () => {
    await open(
      withActions([
        memory({ id: "m-a", target: { type: "memory", id: "mem-a" }, params: { text: "a regra do deploy" } }),
        memory({ id: "m-b", target: { type: "memory", id: "mem-b" }, params: { text: "o prazo do relatório" } }),
      ]),
    );
    const row = receipts().querySelector(".ag-rcg__it") as HTMLElement;
    expect(row.textContent).toBe("Guardei na memória: a regra do deploy e o prazo do relatório");
    expect(
      within(row)
        .getAllByRole("link")
        .map((l) => [l.textContent, l.getAttribute("href")]),
    ).toEqual([
      ["memória", `/org/${ORG_ID}/agents/${ADA_ID}/memory?item=mem-a`],
      ["a regra do deploy", `/org/${ORG_ID}/agents/${ADA_ID}/memory?item=mem-a`],
      ["o prazo do relatório", `/org/${ORG_ID}/agents/${ADA_ID}/memory?item=mem-b`],
    ]);
  });

  test("live: message.actions replaces the receipts for everyone", async () => {
    const { socket } = await open(withActions([action()]));
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "message.actions",
          channelId: ENG_ID,
          threadId: null,
          messageId: "m-act",
          actions: [action({ undoneAt: inMs(-500), undoneByUserId: "u-joao" }), memory()],
        },
      }),
    );
    await settle(3);
    const group = receipts();
    expect(group.textContent).toContain("2 mudanças");
    const first = group.querySelector(".ag-rcg__it") as HTMLElement;
    expect(first.className).toContain("is-undone");
    expect(first.textContent).toContain("Desfeito por João");
    expect(within(group).queryAllByRole("button")).toHaveLength(0);
  });

  test("no receipts: nothing under the message", async () => {
    await open(withActions([]));
    expect(within(article()).queryByRole("group", { name: "Mudanças de Ada" })).toBeNull();
  });
});

describe("receipts this build doesn't expect", () => {
  test("every kind the app knows has its icon and its sentence in pt-BR and en", () => {
    expect(Object.keys(RECEIPT_ICONS).sort()).toEqual([...AGENT_ACTION_KINDS].sort());
    const sentence = (strings: { agentActions: object }, kind: string) => {
      const [group = "", name = ""] = kind.split(".");
      return (strings.agentActions as Record<string, Record<string, unknown> | undefined>)[group]?.[name];
    };
    for (const strings of [ptBR, en])
      expect(AGENT_ACTION_KINDS.filter((kind) => typeof sentence(strings, kind) !== "string")).toEqual([]);
  });

  test("a kind from a newer server: 'Fiz uma mudança' with the plain check", async () => {
    await open(withActions([action({ kind: "something.new" as AgentAction["kind"] })]));
    const row = receipts().querySelector(".ag-rc") as HTMLElement;
    expect(row.textContent).toContain("Fiz uma mudança");
    expect(row.querySelector(".ag-rc__ic svg")).not.toBeNull();
  });

  test("receipts that throw: one quiet line in their place, the reply's text and the rest of the message stay; reported once a draw; fixed live, they are back", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = action({ params: null as never });
      const { socket } = await open(withActions([broken]));
      const reports = () => logged.mock.calls.filter((args) => args.some((a) => a instanceof TypeError));
      const unshown = () => within(article()).queryAllByText("Parte desta mensagem não pôde ser exibida");
      expect(unshown()).toHaveLength(1);
      expect(article().textContent).toContain("Olhei o código");
      expect(within(article()).getByRole("toolbar", { name: "Ações da mensagem de Ada" })).toBeTruthy();
      expect(within(article()).queryByRole("group", { name: "Mudanças de Ada" })).toBeNull();
      expect(screen().queryByText("Esta mensagem não pôde ser exibida")).toBeNull();
      expect(reports()).toHaveLength(1);
      const receiptsLive = async (actions: AgentAction[]) => {
        await act(async () =>
          socket.push({
            type: "event",
            channelId: ENG_ID,
            event: { type: "message.actions", channelId: ENG_ID, threadId: null, messageId: "m-act", actions },
          }),
        );
        await settle(3);
      };
      // They change live and still break: drawn again, still one line, reported again.
      await receiptsLive([broken, memory()]);
      expect(unshown()).toHaveLength(1);
      expect(reports()).toHaveLength(2);
      // Fixed live: the receipts are back.
      await receiptsLive([memory()]);
      expect(unshown()).toHaveLength(0);
      expect(receipts().textContent).toContain("Guardei na memória: o prompt é por evento");
      expect(reports()).toHaveLength(2);
      // Broken again: one line, reported once (the change that broke them is not tried a second time at once).
      await receiptsLive([broken]);
      expect(unshown()).toHaveLength(1);
      expect(reports()).toHaveLength(3);
    } finally {
      logged.mockRestore();
    }
  });

  test("a message that throws outside its parts: one quiet line in its place, reported once; the channel, the sidebar, the other messages and the composer stay; fixed live, it is back", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      // A body that isn't text: the row itself can't draw, not one of its parts.
      const { socket, state } = await open(
        withActions([action()], (s) => {
          for (const m of s.messages) if (m.id === "m-act") m.body = null as never;
          seedDm(s, { type: "agent", id: ATLAS_ID });
        }),
      );
      const reports = () => logged.mock.calls.filter((args) => args.some((a) => a instanceof TypeError));
      expect(screen().getAllByText("Esta mensagem não pôde ser exibida")).toHaveLength(1);
      expect(document.body.textContent).not.toContain("Criei a tarefa #23");
      expect(screen().getByRole("heading", { name: "eng" })).toBeTruthy();
      const messages = within(screen().getByRole("region", { name: "Mensagens" })).getAllByRole("article");
      expect(messages.some((a) => a.textContent?.includes("o login está devolvendo 401"))).toBe(true);
      const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
      expect(within(nav).getAllByText("general").length).toBeGreaterThan(0);
      expect(within(nav).getAllByText("Atlas").length).toBeGreaterThan(0);
      expect(screen().getByRole("combobox", { name: "Mensagem para #eng" })).toBeTruthy();
      expect(reports()).toHaveLength(1);
      // The same message again, now with its text: it is back.
      const fixed = { ...state.messages.find((m) => m.id === "m-act"), body: BODY } as Message;
      await act(async () =>
        socket.push({
          type: "event",
          channelId: ENG_ID,
          event: { type: "message.created", channelId: ENG_ID, messageId: "m-act", message: fixed },
        }),
      );
      await settle(3);
      expect(screen().queryByText("Esta mensagem não pôde ser exibida")).toBeNull();
      expect(article().textContent).toContain("Criei a tarefa #23");
      expect(reports()).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("the message after a quiet line keeps its own header, not read as the words of whoever wrote above", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      // João, then Ada's message that can't draw, then Ada's next one a moment later (grouped with it).
      await open(
        withActions([action()], (s) => {
          const row = { channelId: ENG_ID, threadId: null, mentionedAgentIds: [], agentRunId: null };
          s.messages.push(
            {
              ...row,
              id: "m-joao",
              author: { type: "person", id: "u-joao" },
              body: "Viu o login?",
              createdAt: inMs(-6_000),
            },
            {
              ...row,
              id: "m-broken",
              author: { type: "agent", id: ADA_ID },
              body: null as never,
              createdAt: inMs(-5_000),
            },
          );
        }),
      );
      expect(screen().getAllByText("Esta mensagem não pôde ser exibida")).toHaveLength(1);
      expect(article().className).not.toContain("ac-msg--grouped");
      expect(article().querySelector(".ac-msg__head")?.textContent).toContain("Ada");
    } finally {
      logged.mockRestore();
    }
  });

  test("a sidebar row that throws is one quiet row: the other rows and the conversation stay; fixed, it is back", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { services } = await open(
        withActions([action()], (s) => {
          // An object where the row draws text: React refuses it while drawing Atlas's row.
          for (const a of s.agents) if (a.id === ATLAS_ID) a.role = { unexpected: true } as never;
          seedDm(s, { type: "agent", id: ATLAS_ID });
          seedDm(s, { type: "agent", id: ADA_ID });
        }),
      );
      const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
      expect(within(nav).getAllByText("Não pôde ser exibido")).toHaveLength(1);
      expect(within(nav).getAllByText("Ada").length).toBeGreaterThan(0);
      expect(within(nav).getAllByText("general").length).toBeGreaterThan(0);
      expect(screen().getByRole("heading", { name: "eng" })).toBeTruthy();
      expect(article().textContent).toContain("Criei a tarefa #23");
      // Atlas comes back fixed: its row is back.
      await act(async () =>
        services.queryClient.setQueryData<Agent[]>(keys.agents(ORG_ID), (list) =>
          list?.map((a) => (a.id === ATLAS_ID ? { ...a, role: "Infra" } : a)),
        ),
      );
      await settle(2);
      expect(within(nav).queryByText("Não pôde ser exibido")).toBeNull();
      expect(within(nav).getAllByText("Atlas").length).toBeGreaterThan(0);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("mission proposed already investigated", () => {
  test("findings with icons per kind, refs as code chips linked to the repo, the decision highlighted, plan, Ajustar / Começar and the note", async () => {
    const state = seedState();
    state.agentRepos = { [ADA_ID]: ["acme/loja-ios"] };
    const api = createFakeApi(state);
    const mission = await api.missions.create(ORG_ID, {
      agentId: ADA_ID,
      goal: "Mostrar o pedido de avaliação no momento certo",
      title: "Mostrar o pedido de avaliação no momento certo",
      channelId: ENG_ID,
      folder: "/Users/ada/code/loja-ios",
    });
    const get = api.missions.get;
    api.missions.get = async (o, id) => ({
      ...(await get(o, id)),
      findings: [
        {
          kind: "read",
          text: "Li 6 arquivos. O prompt dispara logo depois da assinatura.",
          refs: ["ReviewPrompt.swift:41", "App/SubscriptionFlow.swift:88"],
        },
        { kind: "data", text: "No analytics: 9 de 11 negativos vieram logo depois da assinatura." },
        { kind: "decision", text: "depois de quantas viagens concluídas?" },
      ],
      openQuestion: "depois de quantas viagens concluídas?",
    });
    api.missions.plan = async (_o, missionId) =>
      ({
        missionId,
        current: {
          items: [
            { id: "p1", title: "Tirar o gatilho de subscription_completed", status: "todo" },
            { id: "p2", title: "Disparar após a 1ª viagem concluída", status: "todo" },
            { id: "p3", title: "Teste e PR para revisão", status: "todo" },
          ],
        },
        history: [],
      }) as unknown as MissionPlan;
    state.messages.push({
      id: "m-plan",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-plan",
      meta: {
        missionPlan: {
          missionId: mission.id,
          title: mission.title,
          goal: mission.goal,
          computer: "MacBook",
          executor: "claude",
        },
      },
      createdAt: new Date().toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const card = document.querySelector(".mi-plan--investigated") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Missão proposta · já investigada");
    const list = within(card).getByRole("list", { name: "O que Ada encontrou" });
    const items = [...list.querySelectorAll(".mi-finding")] as HTMLElement[];
    expect(items.map((i) => i.dataset.kind)).toEqual(["read", "data", "decision"]);
    expect(within(items[0] as HTMLElement).getByRole("img", { name: "Leu" })).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByRole("img", { name: "Dados" })).toBeTruthy();
    expect(items[2]?.className).toContain("mi-finding--decision");
    expect(items[2]?.textContent).toContain("Falta decidir: depois de quantas viagens concluídas?");
    const refs = [...(items[0] as HTMLElement).querySelectorAll(".mi-ref")] as HTMLAnchorElement[];
    expect(refs.map((r) => r.textContent)).toEqual(["ReviewPrompt.swift:41", "App/SubscriptionFlow.swift:88"]);
    expect(refs[1]?.getAttribute("href")).toBe(
      "https://github.com/acme/loja-ios/blob/HEAD/App/SubscriptionFlow.swift#L88",
    );
    expect(refs[0]?.getAttribute("href")).toContain("https://github.com/search?q=");
    expect(card.textContent).toContain("Plano · 3 itens");
    expect(card.textContent).toContain("Disparar após a 1ª viagem concluída");
    expect(within(card).getByRole("button", { name: "Começar" })).toBeTruthy();
    expect(card.textContent).toContain("Começar libera escrever: branch, código e PR. Investigar não precisou de ok.");
  });
});
