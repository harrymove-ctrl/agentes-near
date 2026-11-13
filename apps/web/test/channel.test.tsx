import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(4);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  return { ...r, socket, state };
};

/**
 * Every request card reads as out of view once it is observed (happy-dom's IntersectionObserver never answers), so
 * the activity bar speaks for it. Returns the undo.
 */
function asksOutOfView() {
  const native = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    answer: IntersectionObserverCallback;
    constructor(answer: IntersectionObserverCallback) {
      this.answer = answer;
    }
    observe(target: Element) {
      if (target.matches("[data-ask-id]"))
        this.answer([{ isIntersecting: false, target } as IntersectionObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  return () => {
    globalThis.IntersectionObserver = native;
  };
}

/** Waits, in real time, until `at` has passed: a request's own timer, with no event from the server. */
const until = (at: number) => act(() => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now()) + 50)));

describe("Canal", () => {
  test("header, messages with agent replies inline, neutral mentions and code", async () => {
    await open();
    expect(screen().getByRole("heading", { name: "eng" })).toBeTruthy();
    // The topic beside the name; who answers here is the members list's to say.
    expect(screen().getByText("Código, erros e deploys")).toBeTruthy();
    expect(screen().queryByText(/respondem aqui/)).toBeNull();
    const log = screen().getByRole("region", { name: "Mensagens" });
    const articles = within(log).getAllByRole("article");
    const ask = articles.find((a) => a.textContent?.includes("o login está devolvendo 401"));
    expect(ask?.textContent).toContain("João");
    expect(ask?.querySelector(".ac-mention")?.textContent).toBe("@Ada");
    // Ada was asked in the channel, so her reply is in the channel.
    const reply = articles.find((a) => a.textContent?.includes("Achei a causa"));
    expect(reply?.querySelector(".ac-avatar--agent")).not.toBeNull();
    expect(reply?.querySelector("code")?.textContent).toBe("expires_at");
    // No standing footer under the composer: the hint only shows while an agent works (or the channel is locked).
    expect(document.querySelector(".ac-composer__hint")).toBeNull();
  });

  test("subscribes to the channel over the WebSocket", async () => {
    const { socket } = await open();
    expect(socket.url).toBe(`ws://localhost:3000/api/ws?orgId=${ORG_ID}`);
    expect(socket.sent).toContainEqual({ type: "subscribe", channelId: ENG_ID });
  });

  test("the composer posts with Enter and the message appears once (HTTP + event)", async () => {
    const { socket, state } = await open();
    const box = screen().getByRole("combobox", { name: "Mensagem para #eng" });
    expect(box.getAttribute("placeholder")).toBe("Mensagem para #eng · use @ para chamar um agente");
    await act(async () => fireEvent.change(box, { target: { value: "@atlas acompanha o deploy?" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.post")?.args[2]).toMatchObject({
      body: "@atlas acompanha o deploy?",
    });
    const posted = state.messages[state.messages.length - 1];
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "message.created", channelId: ENG_ID, messageId: posted?.id, message: posted },
      }),
    );
    await settle();
    expect(screen().getAllByText("acompanha o deploy?", { exact: false })).toHaveLength(1);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  test("an agent at work: the bar and the running ring say it, none of its words; then its final message, whole", async () => {
    const withDm = seedState();
    seedDm(withDm, { type: "agent", id: ATLAS_ID });
    const { socket } = await open(withDm);
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    // Asked in the channel: it answers there, its events carry no thread.
    const run = { threadId: null, runId: "r-9", agentId: ATLAS_ID };
    await ev({ type: "agent.run", ...run, status: "running" });
    await ev({ type: "agent.typing", ...run });
    await ev({ type: "agent.delta", ...run, seq: 1, text: "Os 401 no Sentry caíram de 312 para" });
    await settle();
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
    expect(document.body.textContent).not.toContain("Os 401 no Sentry caíram de 312 para");
    const bar = document.querySelector('.ac-typing[data-active="true"]') as HTMLElement;
    expect(bar.textContent).toContain("Atlas");
    expect(bar.textContent).toContain("escrevendo…");
    expect(bar.querySelector(".ac-avatar--running")).not.toBeNull();
    // Its DM in the sidebar shows the ring too.
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(nav.querySelector(".ac-avatar--running")).not.toBeNull();

    await ev({
      type: "message.created",
      messageId: "m-final",
      message: {
        id: "m-final",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ATLAS_ID },
        body: "Os 401 no Sentry caíram de 312 para 4.",
        mentionedAgentIds: [],
        agentRunId: "r-9",
        createdAt: new Date().toISOString(),
      },
    });
    await ev({ type: "agent.run", ...run, status: "done" });
    await settle();
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
    expect(screen().getByText("Os 401 no Sentry caíram de 312 para 4.")).toBeTruthy();
  });

  test("a failed run explains why", async () => {
    const { socket } = await open();
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.run",
          channelId: ENG_ID,
          threadId: null,
          runId: "r-x",
          agentId: ATLAS_ID,
          status: "failed",
          error: "budget_exceeded",
        },
      }),
    );
    await settle();
    expect(screen().getByRole("alert").textContent).toContain("Atlas não conseguiu responder: budget_exceeded");
  });

  test("a connector's request says its values in words, waiting and decided, so two calls of one tool differ", async () => {
    const state = seedState();
    const [first] = state.approvals;
    if (!first) throw new Error("no approval");
    Object.assign(first, {
      tool: "goal_upsert",
      title: "Painel: Goal upsert",
      detail: "panel.goal_upsert · role=seller · month=2026-10 · revenue_goal=97000",
      connector: "panel",
      params: { role: "seller", month: "2026-10", revenue_goal: 97000 },
    });
    await open(state);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.textContent).toContain("Role: seller · Month: 2026-10 · Revenue goal: 97.000");
    // The raw call stays under "Ver detalhes" only.
    expect(card.textContent).not.toContain("role=seller");
    const approve = within(card)
      .getAllByRole("button")
      .find((b) => /^Aprovar/.test(b.textContent ?? "") && !/sempre/.test(b.textContent ?? ""));
    if (!approve) throw new Error("no approve button");
    await act(async () => fireEvent.click(approve));
    await settle(4);
    const done = screen().getByRole("group", { name: "Aprovação concluída" });
    expect(done.textContent).toContain("Aprovado por você");
    expect(done.textContent).toContain("Month: 2026-10");
  });

  test("several requests of one kind on one card: one run, 'Aprovar todos' for exactly those listed, a new one joining live", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const goal = (id: string, month: string, minutes: number) => ({
      ...merge,
      id,
      tool: "goal_upsert",
      title: "Painel: Goal upsert",
      detail: `panel.goal_upsert · month=${month}`,
      connector: "panel",
      params: { month },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(0, 1, goal("ap-g1", "2026-11", 4), goal("ap-g2", "2026-12", 3), goal("ap-g3", "2027-01", 2));
    const cardMessage = state.messages.find((m) => m.id === "msg-card");
    if (cardMessage) cardMessage.meta = { ...cardMessage.meta, approvalId: "ap-g1" };
    const { socket } = await open(state);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(screen().getAllByRole("group", { name: "Pedido de aprovação" })).toHaveLength(1);
    // Folded: the run said as one, its buttons in the footer.
    const head = card.querySelector(".rq__well b")?.textContent ?? "";
    expect(head).toMatch(/^3 pedidos de Ada para /);
    expect(card.querySelectorAll(".rq__item")).toHaveLength(0);
    expect([...(card.querySelector(".rq__foot")?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Aprovar todos",
      "Agora não para todos",
    ]);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Ver cada um" })));
    expect(card.querySelectorAll(".rq__item")).toHaveLength(3);
    expect(card.textContent).toContain("Month: 2026-12");
    // A fourth joins the open card over realtime, not a card of its own.
    const fourth = { ...goal("ap-g4", "2027-02", 0), canDecide: false };
    state.approvals.push(fourth);
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "approval.created", channelId: ENG_ID, approval: fourth },
      }),
    );
    await settle();
    expect(card.querySelectorAll(".rq__item")).toHaveLength(4);
    expect(card.querySelector(".rq__well b")?.textContent).toMatch(/^4 pedidos de Ada para /);
    expect(card.textContent).toContain("Month: 2027-02");
    // Ana may decide three of the four (only an admin decides the new one): it says so.
    expect(card.textContent).toContain("Você pode decidir 3 de 4");
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Aprovar todos" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-g1", "ap-g2", "ap-g3"],
      "approve",
    ]);
    // Decided ones fold into the card with how they ended; the one still waiting keeps it open.
    const after = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(after.querySelectorAll(".rq__item--done")).toHaveLength(3);
    expect(after.textContent).toContain("Aprovado por você");
  });

  test("a mixed card: each item's buttons in a row under its values, a run among them with its own", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const goal = (id: string, month: string, minutes: number) => ({
      ...merge,
      id,
      tool: "goal_upsert",
      title: "Painel: Goal upsert",
      detail: `panel.goal_upsert · month=${month}`,
      connector: "panel",
      params: { month },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    const close = { ...goal("ap-c1", "2026-10", 1), tool: "ticket_close", title: "Painel: Ticket close" };
    state.approvals.splice(0, 1, goal("ap-g1", "2026-11", 4), goal("ap-g2", "2026-12", 3), close);
    const cardMessage = state.messages.find((m) => m.id === "msg-card");
    if (cardMessage) cardMessage.meta = { ...cardMessage.meta, approvalId: "ap-g1" };
    await open(state);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    const [run, single] = [...card.querySelectorAll(".rq__items > .rq__item")] as HTMLElement[];
    if (!run || !single) throw new Error("no items");
    expect(run.classList.contains("rq__run")).toBe(true);
    expect(run.querySelector(".rq__well b")?.textContent).toMatch(/^2 pedidos de Ada para /);
    // The buttons sit under the values, never squeezed beside them in the well.
    for (const item of [run, single]) {
      expect(item.querySelector(".rq__well button:not(.rq__more)")).toBeNull();
      expect(item.querySelector(":scope > .rq__well + .rq__item-acts")).not.toBeNull();
    }
    const labels = (el: Element | null) =>
      [...(el?.querySelectorAll(":scope > button") ?? [])].map((b) => b.textContent);
    expect(labels(run.querySelector(".rq__item-acts"))).toEqual(["Aprovar todos", "Agora não para todos"]);
    expect(labels(single.querySelector(".rq__item-acts")).at(-1)).toBe("Agora não");
    // The card's own footer decides all three.
    expect(labels(card.querySelector(".rq__foot"))).toEqual(["Aprovar tudo", "Agora não para todos"]);
    await act(async () => fireEvent.click(within(run).getByRole("button", { name: "Aprovar todos" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-g1", "ap-g2"],
      "approve",
    ]);
  });

  test("a run that offers 'Aprovar sempre': once, in its footer, approving the run's like ones with it", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const goal = (id: string, month: string, why: string, minutes: number) => ({
      ...merge,
      id,
      tool: "goal_upsert",
      scope: "",
      title: "Painel: Goal upsert",
      detail: `panel.goal_upsert · month=${month}`,
      connector: "panel",
      params: { month },
      why,
      approveAlways: { tool: "goal_upsert", actions: [] },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(
      0,
      1,
      goal("ap-g1", "2026-11", "Pedido do time de vendas.", 4),
      goal("ap-g2", "2026-12", "Pedido do time de vendas.", 3),
      goal("ap-g3", "2027-01", "Branch velha, já mergeada.", 2),
    );
    const cardMessage = state.messages.find((m) => m.id === "msg-card");
    if (cardMessage) cardMessage.meta = { ...cardMessage.meta, approvalId: "ap-g1" };
    await open(state);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    const foot = card.querySelector(".rq__foot") as HTMLElement;
    expect([...foot.querySelectorAll(":scope > button")].map((b) => b.textContent)).toEqual([
      "Aprovar todos",
      "Aprovar sempre",
      "Agora não para todos",
    ]);
    // Only buttons: what it covers is the button's tip and description.
    expect([...foot.children].every((el) => el.matches("button, .rq__end"))).toBe(true);
    expect(within(foot).getByRole("button", { name: "Aprovar sempre" }).getAttribute("aria-description")).toContain(
      "de agora em diante",
    );
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Ver cada um" })));
    const items = [...card.querySelectorAll(".rq__item")] as HTMLElement[];
    expect(items).toHaveLength(3);
    // The lead's why is the card's; the one asked for another reason says its own on its line.
    expect(items[1]?.querySelector(".rq__item-why")).toBeNull();
    expect(items[2]?.querySelector(".rq__item-why")?.textContent).toBe("Branch velha, já mergeada.");
    for (const item of items) expect(within(item).queryByRole("button", { name: /Aprovar sempre/ })).toBeNull();
    await act(async () => fireEvent.click(within(foot).getByRole("button", { name: "Aprovar sempre" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args).toEqual([ORG_ID, "ap-g1", undefined, true]);
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-g2", "ap-g3"],
      "approve",
    ]);
  });

  test("a card older than the approvals list reaches still lists all its requests, fetched by the card", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const goal = (id: string, month: string, days: number) => ({
      ...merge,
      id,
      status: "approved" as const,
      canDecide: false,
      decidedByUserId: state.me?.user.id ?? null,
      decidedAt: new Date(Date.now() - days * 86_400_000).toISOString(),
      tool: "goal_upsert",
      title: "Painel: Goal upsert",
      detail: `panel.goal_upsert · month=${month}`,
      connector: "panel",
      params: { month },
      createdAt: new Date(Date.now() - days * 86_400_000).toISOString(),
    });
    // A newer request elsewhere fills the list's window: the card's own fall outside it.
    const newer = { ...merge, id: "ap-newer", messageId: null, createdAt: new Date().toISOString() };
    state.approvals.splice(0, 1, goal("ap-g1", "2026-11", 3), goal("ap-g2", "2026-12", 2.9), newer);
    state.approvalsWindow = 1;
    const cardMessage = state.messages.find((m) => m.id === "msg-card");
    if (cardMessage) cardMessage.meta = { ...cardMessage.meta, approvalId: "ap-g1" };
    await open(state);
    await settle(4);
    expect(state.calls.some((c) => c.method === "approvals.list" && JSON.stringify(c.args).includes("msg-card"))).toBe(
      true,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Month: 2026-11");
    expect(text).toContain("Month: 2026-12");
  });

  test("a request in the conversation: approve calls the API, shrinks to one line; events update it", async () => {
    const r0 = await open();
    const { state, socket } = r0;
    // It lives on the agent message with meta.approvalId: the agent asking, the action in one line.
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.closest("article")?.textContent).toContain("Ada");
    expect(card.textContent).toContain("Preciso do seu ok para seguir:");
    expect(card.textContent).toContain("Fazer um merge");
    // Its text isn't repeated above it ("Pedido de aprovação: …").
    expect(card.closest("article")?.querySelector(".ac-msg__text")).toBeNull();
    expect(within(card).getByRole("button", { name: "Agora não" })).toBeTruthy();
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Aprovar merge" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args).toEqual([ORG_ID, "ap-merge", undefined]);
    const done = screen().getByRole("group", { name: "Aprovação concluída" });
    expect(done.textContent).toContain("Aprovado por você: Fazer um merge");
    expect(done.querySelector(".rq-done__text b")?.textContent).toBe("Fazer um merge");
    expect(done.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    // Nothing behind the line: no reason to show.
    expect(within(done).queryByRole("button")).toBeNull();
    // Someone else refuses another approval: the event updates the card live.
    const deploy = {
      ...state.approvals[1],
      status: "refused",
      decidedByUserId: "u-joao",
      decidedAt: new Date().toISOString(),
    };
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "approval.decided", channelId: ENG_ID, approval: deploy },
      }),
    );
    await settle();
    const list = (await r0.services.queryClient.getQueryData(["org", ORG_ID, "approvals"])) as {
      id: string;
      status: string;
    }[];
    expect(list.find((a) => a.id === "ap-deploy")?.status).toBe("refused");
  });

  test("a request waiting for you out of view: the activity bar says so, and Ver brings it back", async () => {
    const undo = asksOutOfView();
    try {
      const { socket, state } = await open();
      // The card registers with the conversation as it comes (its approval loads after the page).
      await settle(2);
      const card = screen().getByRole("group", { name: "Pedido de aprovação" });
      expect(card.getAttribute("data-ask-id")).toBe("ap-merge");
      const bar = document.querySelector(".ac-typing") as HTMLElement;
      expect(bar.hasAttribute("data-ask")).toBe(true);
      expect(bar.textContent).toContain("Ada espera sua aprovação");
      expect(bar.textContent).toContain("Fazer um merge");
      await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Ver" })));
      expect(card.classList.contains("rq--flash")).toBe(true);
      // Ada at work meanwhile: the line still says the request, and keeps her stop at its end.
      const run = { type: "agent.run", channelId: ENG_ID, threadId: null, runId: "r-live", agentId: ADA_ID };
      await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { ...run, status: "running" } }));
      await settle(2);
      expect(bar.textContent).toContain("Ada espera sua aprovação");
      const stop = within(bar).getByRole("button", { name: "Parar" });
      expect(bar.lastElementChild?.contains(stop)).toBe(true);
      await act(async () => fireEvent.click(stop));
      await settle(2);
      expect(state.calls.some((c) => c.method === "agents.cancelRun")).toBe(true);
    } finally {
      undo();
    }
  });

  test("what a request says reaches the bar as written, never read as markup", async () => {
    const undo = asksOutOfView();
    try {
      const state = seedState();
      const merge = state.approvals.find((a) => a.id === "ap-merge");
      if (merge)
        Object.assign(merge, { tool: "request_approval", params: { action: "merge", target: "<b>PR</b> #42" } });
      await open(state);
      await settle(2);
      const line = document.querySelector(".ac-typing__text") as HTMLElement;
      expect(line.textContent).toBe("Ada espera sua aprovação · Fazer merge de <b>PR</b> #42");
      // Only the agent's name is bold.
      expect(Array.from(line.querySelectorAll("b"), (b) => b.textContent)).toEqual(["Ada"]);
    } finally {
      undo();
    }
  });

  // Real time passes in it (the request's own timer), so it gets more than the default 5 s.
  test("an approval past its time with no event: it stops waiting for you and reads as expired", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    const expiresAt = Date.now() + 3_000;
    if (merge) merge.expiresAt = new Date(expiresAt).toISOString();
    await open(state);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.hasAttribute("data-ask-mine")).toBe(true);
    await until(expiresAt);
    await settle(2);
    expect(document.querySelector('[data-ask-id="ap-merge"]')).toBeNull();
    const expired = screen().getByRole("group", { name: "Pedido expirado" });
    expect(expired.textContent).toContain("Expirou");
    expect(expired.querySelector(".rq-done__mark[data-done]")).toBeNull();
  }, 15_000);

  test("a refused request is one line: 'Ver detalhes' opens its reason under the line and closes it", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (merge)
      Object.assign(merge, {
        status: "refused",
        decidedByUserId: "u-walter",
        decidedAt: new Date().toISOString(),
        reason: "Falta a revisão.",
      });
    await open(state);
    await settle(2);
    const line = screen().getByRole("group", { name: "Pedido recusado" });
    expect(line.textContent).toContain("Recusado por você: Fazer um merge");
    expect(line.querySelector(".rq-done__mark[data-done]")).toBeNull();
    expect(line.textContent).not.toContain("Falta a revisão.");
    const see = within(line).getByRole("button", { name: "Ver detalhes" });
    expect(see.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(see));
    expect(see.getAttribute("aria-expanded")).toBe("true");
    expect(line.querySelector(".rq__details")?.textContent).toBe("Motivo: Falta a revisão.");
    await act(async () => fireEvent.click(see));
    expect(see.getAttribute("aria-expanded")).toBe("false");
    expect(line.querySelector(".rq__details")).toBeNull();
  });

  test("a request whose run stopped reads as canceled, not as refused by no one", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (merge) Object.assign(merge, { status: "canceled", decidedAt: new Date().toISOString() });
    await open(state);
    await settle(2);
    const line = screen().getByRole("group", { name: "Pedido cancelado" });
    expect(line.textContent).toContain("Cancelado: Fazer um merge");
    expect(line.querySelector(".rq-done__mark[data-done]")).toBeNull();
  });

  test("not a member of a public channel: join instead of the composer", async () => {
    const state = seedState();
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) eng.isMember = false;
    await open(state);
    expect(screen().queryByRole("textbox", { name: "Mensagem para #eng" })).toBeNull();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Entrar no #eng" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "chat.join")).toBe(true);
    expect(screen().getByRole("combobox", { name: "Mensagem para #eng" })).toBeTruthy();
  });

  test("channel details: agents and people in groups, no search on a short list", async () => {
    await open();
    await act(async () =>
      fireEvent.click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" })),
    );
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    // Who manages it lands on Visão geral (ADR 0134): its people and agents are under Membros.
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Membros" })));
    await settle(2);
    expect(dialog.textContent).toContain("Agentes");
    expect(dialog.textContent).toContain("Pessoas");
    expect(dialog.textContent).toContain("João");
    expect(dialog.textContent).toContain("Entra na conversa por conta própria");
    expect(within(dialog).queryByRole("searchbox", { name: "Buscar pessoa ou agente" })).toBeNull();
  });

  test("counts read as the person's language writes them, on the reply's bar and in its pills: 1.284", async () => {
    const state = seedState();
    const reply = state.messages.find((m) => m.id === "m-2") as { reactions?: unknown };
    reply.reactions = [
      { reaction: "+1", count: 1284, userIds: ["u-walter"] },
      { reaction: "-1", count: 37, userIds: ["u-x"] },
    ];
    await open(state);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Achei a causa")) as HTMLElement;
    const bar = within(row).getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    const counts = [...bar.querySelectorAll(".ac-msg__reaction-count")].map((c) => c.textContent);
    expect(counts).toEqual(["1.284", "37"]);
    const pills = [...row.querySelectorAll(".ac-reacts .ac-react .tabular")].map((c) => c.textContent);
    expect(pills).toEqual(["1.284", "37"]);
  });

  test("agent replies: 👍/👎 toggle with the API and Corrigir resposta sends a correction", async () => {
    const { state } = await open();
    const reply = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Achei a causa")) as HTMLElement;
    await act(async () => fireEvent.mouseEnter(reply));
    const bar = within(reply).getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    const up = within(bar).getByRole("button", { name: "Útil" });
    expect(up.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(up));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.react")?.args).toEqual([ORG_ID, "m-2", "+1"]);
    const pressed = within(bar).getByRole("button", { name: "Útil" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    // Pressed with its count: one plate around the icon and the "1", never the square of an icon alone.
    expect(pressed.querySelector(".ac-msg__reaction-count")?.textContent).toBe("1");
    expect(pressed.classList.contains("ac-btn--icon")).toBe(false);
    // 👎 replaces 👍.
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Não ajudou" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.unreact")?.args).toEqual([ORG_ID, "m-2", "+1"]);
    expect(state.calls.filter((c) => c.method === "chat.react").at(-1)?.args[2]).toBe("-1");
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Corrigir resposta" })));
    const dialog = screen().getByRole("dialog", { name: "Corrigir a resposta da Ada" });
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Como deveria ser"), {
        target: { value: "O token expira em 15 min." },
      }),
    );
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Enviar correção" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.correct")?.args).toEqual([
      ORG_ID,
      "m-2",
      "O token expira em 15 min.",
    ]);
    expect(document.body.textContent).toContain("Correção enviada. A Ada vai aprender com ela.");
  });

  test("people's messages have no feedback buttons: Reagir, Responder and '…'", async () => {
    await open();
    const ask = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("o login está devolvendo 401")) as HTMLElement;
    const bar = within(ask).getByRole("toolbar", { name: "Ações da mensagem de João" });
    expect(within(bar).queryByRole("button", { name: "Útil" })).toBeNull();
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Reagir", "Responder", "Mais ações da mensagem"]);
  });

  test("admins edit the channel topic from the details", async () => {
    const { state } = await open();
    await act(async () =>
      fireEvent.click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" })),
    );
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Descrição"), { target: { value: "Código e deploys" } }),
    );
    // Saves on blur, without a button.
    await act(async () => fireEvent.blur(within(dialog).getByLabelText("Descrição")));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.update")?.args[2]).toEqual({ topic: "Código e deploys" });
  });
});
