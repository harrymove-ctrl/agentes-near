import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentDraft, AgentInput, AgentProposalCard, MailAccount, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { aiSelect } from "./ai-picker";
import { ATLAS_ID, createFakeApi, ENG_ID, fakeMailOf, meWithRole, NOW, ORG_ID, seedState } from "./fake-api";
import { railStep, title, typeIn } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

type State = ReturnType<typeof seedState>;
const HOUR = 3_600_000;
const DESIGN_ID = "00000000-0000-4000-8000-0000000000c9";

/** Atlas's proposal of Nina in #eng (`meta.actionCard`), as `propose_agent` posts it. */
const proposal = (
  id: string,
  card: Partial<AgentProposalCard> = {},
  draft: Partial<AgentDraft> = {},
  minute = 0,
): Message => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent", id: ATLAS_ID },
  body: "Proposed a new agent, Nina: server text",
  mentionedAgentIds: [],
  agentRunId: `r-${id}`,
  meta: {
    bodyCode: "agent_proposal",
    bodyParams: { name: "Nina" },
    actionCard: {
      kind: "agent_proposal",
      forUserId: "u-walter",
      params: {
        draft: {
          name: "Nina",
          handle: "nina",
          role: "Designer",
          instructions: "Desenha as telas.",
          appearance: { color: "rose", eyes: "happy", accessory: "bow" },
          channelIds: [ENG_ID],
          access: [],
          ai: { kind: "model" },
          ...draft,
        },
        why: "Você pediu alguém para o design.",
      },
      state: "pending",
      agentId: null,
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
      ...card,
    } satisfies AgentProposalCard,
  },
  createdAt: new Date(NOW.getTime() + minute * 60_000).toISOString(),
});

const click = async (el: HTMLElement, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
/** The proposal in its message: the request card while it is open, then the line that says what was decided. */
const cardOf = (text: string) =>
  screen()
    .getAllByRole("article")
    .map((a) => a.querySelector<HTMLElement>(".rq, .rq-done"))
    .filter((card): card is HTMLElement => Boolean(card?.textContent?.includes(text)));
const asMember = (state: State) => {
  const org = state.me?.organizations[0];
  if (org) org.role = "member";
};

describe("an agent's proposal of a new agent, in the chat", () => {
  test("a request card: its reason, the draft in the well; Revisar opens Criar agente over the conversation, Recusar says no", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const card = screen().getByRole("group", { name: "Atlas propõe um novo agente" });
    // Waiting for who may create agents, like every other request (the bar can bring it back).
    expect(card.getAttribute("data-ask-kind")).toBe("agent");
    expect(card.hasAttribute("data-ask-mine")).toBe(true);
    // Waiting for me needs no words on the card (its buttons say it).
    expect(card.textContent).not.toContain("esperando você");
    for (const shown of [
      "Você pediu alguém para o design.",
      "Nina",
      "@nina · Designer · Pensa pela API",
      "para decidir",
    ])
      expect(card.textContent).toContain(shown);
    expect(card.querySelector(".ac-expiry-fuse")).not.toBeNull();
    expect(card.textContent).not.toContain("server text");
    // Its name on one line, the handle and role on the next: never run together.
    const who = card.querySelector(".rq__wt");
    expect(who?.querySelector(":scope > b")?.textContent).toBe("Nina");
    expect(who?.querySelector(":scope > small")?.textContent).toBe("@nina · Designer · Pensa pela API");
    // Revisar: the review in a dialog over the conversation, which stays as it was.
    await click(within(card).getByRole("button", { name: "Revisar" }), 10);
    const dialog = screen().getByRole("dialog", { name: "Revisar Nina" });
    expect(within(dialog).getByRole("heading", { name: "Tudo certo com a Nina?" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    await click(within(dialog).getByRole("button", { name: "Sair sem criar" }));
    expect(screen().queryByRole("dialog", { name: "Revisar Nina" })).toBeNull();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    await click(within(card).getByRole("button", { name: "Recusar" }));
    expect(state.calls.some((c) => c.method === "agents.denyProposal" && c.args[1] === "p-1")).toBe(true);
    // Decided: one line says what was decided.
    const after = screen().getByRole("group", { name: "Atlas propõe um novo agente" });
    expect(after.textContent).toContain("Recusada: Nina");
    expect(after.querySelector(".rq-done__mark[data-done]")).toBeNull();
    expect(within(after).queryByRole("button", { name: "Recusar" })).toBeNull();
    expect(document.querySelector('[data-ask-id="p-1"]')).toBeNull();
  });

  // Real time passes in it (the request's own timer), so it gets more than the default 5 s.
  test("open until its time, even with no event: then it reads as expired", async () => {
    const state = seedState();
    const expiresAt = Date.now() + 3_000;
    state.messages.push(proposal("p-1", { expiresAt: new Date(expiresAt).toISOString() }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    expect(document.querySelector('[data-ask-id="p-1"]')?.hasAttribute("data-ask-mine")).toBe(true);
    // Nothing comes from the server: the card's own timer closes it at that moment.
    await act(() => new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 50)));
    await settle(2);
    expect(document.querySelector('[data-ask-id="p-1"]')).toBeNull();
    const [card] = cardOf("Nina");
    expect(card?.textContent).toContain("Expirou");
    expect(within(card as HTMLElement).queryByRole("link", { name: "Revisar" })).toBeNull();
  }, 15_000);

  test("read-only for who can't create agents; created links to the agent; expired after a day", async () => {
    const state = seedState();
    asMember(state);
    state.messages.push(
      proposal(
        "p-open",
        {},
        { ai: { kind: "account", brain: "claude_code", machineId: "m-1", accountId: "a-1", label: "Claude Max" } },
      ),
      proposal(
        "p-made",
        { state: "created", agentId: ATLAS_ID },
        { name: "Otto", handle: "otto", ai: { kind: "none" } },
        1,
      ),
      proposal("p-old", { expiresAt: new Date(Date.now() - HOUR).toISOString() }, { name: "Vera", handle: "vera" }, 2),
    );
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const [open] = cardOf("@nina");
    expect(open?.textContent).toContain("Pensa com Claude Max");
    expect(open?.textContent).toContain("Aguardando um admin");
    // Not the viewer's to decide: the bar never brings it back.
    expect(open?.hasAttribute("data-ask-mine")).toBe(false);
    expect(within(open as HTMLElement).queryByRole("link", { name: "Revisar" })).toBeNull();
    expect(within(open as HTMLElement).queryByRole("button", { name: "Recusar" })).toBeNull();
    const [made] = cardOf("Otto");
    expect(made?.textContent).toContain("Criado");
    expect(made?.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    // The draft and the way to the agent are behind "Ver detalhes".
    expect(made?.textContent).not.toContain("@otto");
    await click(within(made as HTMLElement).getByRole("button", { name: "Ver detalhes" }));
    expect(made?.textContent).toContain("@otto");
    expect(made?.textContent).toContain("Sem IA ainda. Conecte uma depois de criar");
    expect(
      within(made as HTMLElement)
        .getByRole("link", { name: "Abrir perfil" })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
    const [old] = cardOf("Vera");
    expect(old?.textContent).toContain("Expirou");
    expect(old?.querySelector(".rq-done__mark[data-done]")).toBeNull();
    // Refused or expired there is no agent to go to.
    await click(within(old as HTMLElement).getByRole("button", { name: "Ver detalhes" }));
    expect(old?.textContent).toContain("@vera");
    expect(within(old as HTMLElement).queryByRole("link", { name: "Abrir perfil" })).toBeNull();
    // In the conversation, the profile opens in the panel beside it.
    await act(async () => fireEvent.click(within(made as HTMLElement).getByRole("link", { name: "Abrir perfil" })));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(screen().getByRole("complementary", { name: "Perfil do Atlas" })).toBeTruthy();
  });

  test("live: decided by someone else, the card changes in place (only the decision comes)", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.proposal.updated",
          channelId: ENG_ID,
          threadId: null,
          messageId: "p-1",
          state: "created",
          agentId: ATLAS_ID,
          decidedByUserId: "u-joao",
          decidedAt: new Date().toISOString(),
        },
      }),
    );
    await settle(3);
    const [card] = cardOf("Nina");
    expect(card?.textContent).toContain("Criado");
    expect(within(card as HTMLElement).queryByRole("link", { name: "Revisar" })).toBeNull();
    await click(within(card as HTMLElement).getByRole("button", { name: "Ver detalhes" }));
    expect(
      within(card as HTMLElement)
        .getByRole("link", { name: "Abrir perfil" })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
  });
});

describe("one request, one card: what it gets, created in one click", () => {
  const ROUTINE = {
    name: "E-mails do dia",
    prompt: "Lê a caixa de entrada e resume o que chegou.",
    schedule: "todo dia ao meio-dia",
    rule: { freq: "daily" as const, interval: 1, times: ["12:00"], timezone: "America/Sao_Paulo" },
    cron: "0 12 * * *",
    timezone: "America/Sao_Paulo",
    description: "Every day, at 12:00 (Brasília time)",
    report: "when_new" as const,
    access: "read" as const,
  };
  const withLines = (minute = 0) =>
    proposal(
      "p-1",
      {},
      {
        access: [{ connectionId: "conn-gh", level: "read" }],
        mail: [
          { accountId: "mb-w", address: "walter@acme.com.br", level: "read", ownerUserId: "u-walter" },
          { accountId: "mb-j", address: "joao@acme.com.br", level: "write", ownerUserId: "u-joao" },
        ],
        routine: ROUTINE,
      },
      minute,
    );
  // A line's own text (the routine's folded prompt apart).
  const lines = (card: HTMLElement) =>
    [...card.querySelectorAll(".waitcard__lines > li")].map((li) => {
      const line = li.cloneNode(true) as HTMLElement;
      line.querySelector(".waitcard__prompt")?.remove();
      return line.textContent?.replace(/\s+/g, " ").trim();
    });

  test("each line, with who gives it when I can't; Criar makes it as it is and the card says what it got", async () => {
    const state = seedState();
    state.messages.push(withLines());
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const [card] = cardOf("@nina");
    if (!card) throw new Error("no card");
    expect(lines(card)).toEqual([
      "eng",
      "GitHub · só consulta",
      "walter@acme.com.br · só consulta",
      "joao@acme.com.br · consulta e muda · só João libera",
      "E-mails do dia · Todos os dias, às 12:00 (horário de Brasília)",
    ]);
    // What each run is told, folded under its line: one click makes it under my name.
    expect(card.querySelector(".waitcard__prompt")?.textContent).toContain(ROUTINE.prompt);
    await click(within(card).getByRole("button", { name: "Criar Nina" }), 8);
    expect(state.calls.find((c) => c.method === "agents.createProposed")?.args).toEqual([ORG_ID, "p-1"]);
    expect(state.calls.some((c) => c.method === "agents.create")).toBe(false);
    const [made] = cardOf("Nina");
    if (!made) throw new Error("no card");
    expect(made.textContent).toContain("Criado");
    // What it got is behind "Ver detalhes", with the way to the agent.
    await click(within(made).getByRole("button", { name: "Ver detalhes" }));
    expect(within(made).getByRole("link", { name: "Abrir perfil" })).toBeTruthy();
    // What it got takes a check; João's mailbox waits for him.
    const given = [...made.querySelectorAll(".waitcard__lines > li")].map((li) => li.getAttribute("data-given"));
    expect(given).toEqual(["true", "true", "true", "false", "true"]);
    expect(lines(made)[3]).toBe("joao@acme.com.br · consulta e muda · só João libera");
  });

  test("a routine one click couldn't make waits for an admin, and its card makes it once the agent can report", async () => {
    const state = seedState();
    state.messages.push(
      proposal(
        "p-1",
        {
          state: "created",
          agentId: ATLAS_ID,
          decidedByUserId: "u-walter",
          applied: { channelIds: [], connectionIds: [], mailAccountIds: [] },
          routineId: null,
        },
        { routine: { ...ROUTINE, reportsIn: ENG_ID } },
      ),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const [card] = cardOf("Nina");
    if (!card) throw new Error("no card");
    await click(within(card).getByRole("button", { name: "Ver detalhes" }));
    expect(lines(card).at(-1)).toBe(
      "E-mails do dia · Todos os dias, às 12:00 (horário de Brasília) · um admin libera · não criada",
    );
    await click(within(card).getByRole("button", { name: "Criar a rotina E-mails do dia" }), 6);
    expect(state.calls.find((c) => c.method === "agents.proposalRoutine")?.args).toEqual([ORG_ID, "p-1"]);
    const [made] = cardOf("Nina");
    expect(within(made as HTMLElement).queryByRole("button", { name: "Criar a rotina E-mails do dia" })).toBeNull();
  });

  test("Criar opens Connect when the agent got nothing to think with, whatever the card suggested", async () => {
    const state = seedState();
    state.messages.push(
      proposal(
        "p-1",
        {},
        { ai: { kind: "account", brain: "claude_code", machineId: "m-1", accountId: "a-1", label: "Claude Max" } },
      ),
    );
    // The asker's plan, but whoever clicks has no account of their own free.
    state.proposalAi = "none";
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const [card] = cardOf("@nina");
    if (!card) throw new Error("no card");
    await click(within(card).getByRole("button", { name: "Criar Nina" }), 8);
    expect(screen().getByRole("dialog", { name: /Conectar uma IA/ })).toBeTruthy();
  });

  test("Revisar, then Criar: the dialog closes on the conversation as it was, and the routine is made", async () => {
    const state = seedState();
    state.messages.push(withLines());
    const api = createFakeApi(state);
    const fakeMail = fakeMailOf.get(api);
    if (!fakeMail) throw new Error("no mail fake");
    const mailbox = (id: string, address: string): MailAccount => ({
      id,
      provider: "gmail",
      via: "composio",
      address,
      label: address,
      status: "active",
      lastError: null,
      preset: null,
      createdAt: NOW.toISOString(),
      offActions: [],
      askActions: [],
      aliases: [],
      defaultFrom: null,
      ownerUserId: id === "mb-w" ? "u-walter" : "u-joao",
      agents: [],
    });
    fakeMail.accounts = [mailbox("mb-w", "walter@acme.com.br"), mailbox("mb-j", "joao@acme.com.br")];
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const [card] = cardOf("@nina");
    if (!card) throw new Error("no card");
    await click(within(card).getByRole("button", { name: "Revisar" }), 10);
    const dialog = screen().getByRole("dialog", { name: "Revisar Nina" });
    // The routine is on the review, to keep or not; my own mailbox comes at its level, João's is his to give.
    const review = dialog.querySelector(".newag__review")?.textContent ?? "";
    expect(review).toContain("E-mails do dia");
    expect(review).toContain("walter@acme.com.br · só consulta");
    expect(review).not.toContain("joao@acme.com.br");
    expect(
      within(dialog).getByRole("switch", { name: "Criar a rotina E-mails do dia" }).getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(dialog).getByRole("button", { name: "Criar Nina" }), 12);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({ proposal: "p-1" });
    expect(state.calls.find((c) => c.method === "agents.proposalRoutine")?.args).toEqual([ORG_ID, "p-1"]);
    // My mailbox at its level; João's isn't mine to give.
    expect(state.calls.filter((c) => c.method === "mail.setAgent").map((c) => c.args.slice(2, 4))).toEqual([
      ["mb-w", expect.objectContaining({ level: "read" })],
    ]);
    expect(screen().queryByRole("dialog", { name: "Revisar Nina" })).toBeNull();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});

describe("Revisar: Criar agente filled in with the draft", () => {
  test("on its last step with the draft; creating sends the edits with the card, and no AI opens Connect for it", async () => {
    // No key and no plan: nothing to think with yet, so it is created and connected after.
    const state = seedState({ credentials: [], platformKey: false });
    state.messages.push(proposal("p-1", {}, { ai: { kind: "none" } }));
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    expect(title()).toBe("Tudo certo com a Nina?");
    const review = document.querySelector(".newag__review")?.textContent ?? "";
    for (const shown of ["Designer", "@nina", "Desenha as telas.", "eng", "Sem IA ainda"])
      expect(review).toContain(shown);
    // An edit on the way: the name.
    await click(railStep("Identidade"));
    await typeIn(screen().getByLabelText("Nome"), "Nina Simone");
    await settle(2);
    await click(railStep("Revisar e criar"));
    await click(screen().getByRole("button", { name: "Criar Nina Simone" }), 10);
    const created = state.calls.find((c) => c.method === "agents.create")?.args[1] as AgentInput | undefined;
    expect(created).toMatchObject({
      name: "Nina Simone",
      handle: "nina",
      role: "Designer",
      instructions: "Desenha as telas.",
      appearance: { color: "rose", eyes: "happy", accessory: "bow" },
      proposal: "p-1",
    });
    const connect = screen().getByRole("dialog", { name: /Conectar uma IA/ });
    // Another one starts empty, without the proposal.
    await click(within(connect).getByRole("button", { name: "Fechar" }));
    await click(screen().getByRole("button", { name: "Criar outro agente" }), 8);
    expect(title()).toBe("Qual vai ser o papel?");
  });

  test("no AI, and a coding plan to connect picked: Connect opens once, on that plan", async () => {
    const state = seedState({ credentials: [], platformKey: false });
    state.messages.push(proposal("p-1", {}, { ai: { kind: "none" } }));
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    await click(railStep("Modelo e orçamento"));
    await click(screen().getByRole("combobox", { name: "Quem pensa" }));
    await click(screen().getByRole("option", { name: /^Conectar OpenCode Go/ }));
    await click(railStep("Revisar e criar"));
    await click(screen().getByRole("button", { name: "Criar Nina" }), 10);
    const dialogs = screen().getAllByRole("dialog", { name: /Conectar uma IA/ });
    expect(dialogs).toHaveLength(1);
    expect(aiSelect(dialogs[0] as HTMLElement).textContent).toBe("OpenCode Go");
  });

  test("on an account of mine it suggests: created on that account, with no plan sign-in to open", async () => {
    const state = seedState();
    state.messages.push(
      proposal(
        "p-1",
        {},
        { ai: { kind: "account", brain: "claude_code", machineId: "m-1", accountId: "a-1", label: "Claude Max" } },
      ),
    );
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    await click(screen().getByRole("button", { name: "Criar Nina" }), 10);
    const agentId = state.agents.find((a) => a.handle === "nina")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code", account: "a-1" },
    ]);
    // It thinks with that account, not the computer's own sign-in: nothing to connect.
    expect(screen().queryByRole("dialog", { name: /^Conectar uma IA/ })).toBeNull();
  });

  test("a proposal already decided: no flow, a way back to the conversation", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1", { state: "denied" }));
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    expect(screen().getByText("Esta proposta já foi decidida ou expirou.")).toBeTruthy();
    expect(screen().getByRole("link", { name: "Voltar para a conversa" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/c/${ENG_ID}`,
    );
  });

  test("a proposal in a conversation I'm not in says so, not that it was decided", async () => {
    const state = seedState();
    state.channels.push({
      id: DESIGN_ID,
      name: "design",
      topic: "",
      visibility: "public",
      isMember: false,
      createdAt: NOW.toISOString(),
    });
    state.messages.push({ ...proposal("p-1"), channelId: DESIGN_ID });
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    expect(screen().getByText("Só quem está na conversa vê esta proposta.")).toBeTruthy();
    expect(screen().queryByText("Esta proposta já foi decidida ou expirou.")).toBeNull();
  });

  test("the channels it proposes, also public ones I'm not in when I arrange channels: shown, and the agent joins them", async () => {
    const state = seedState();
    state.channels.push({
      id: DESIGN_ID,
      name: "design",
      topic: "",
      visibility: "public",
      isMember: false,
      createdAt: NOW.toISOString(),
    });
    state.messages.push(proposal("p-1", {}, { channelIds: [ENG_ID, DESIGN_ID] }));
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    const review = document.querySelector(".newag__review")?.textContent ?? "";
    expect(review).toContain("eng");
    expect(review).toContain("design");
    await click(screen().getByRole("button", { name: "Criar Nina" }), 10);
    const joined = state.calls.find((c) => c.method === "agents.setChannels")?.args[2];
    expect(joined).toEqual([{ channelId: ENG_ID }, { channelId: DESIGN_ID }]);
  });

  test("with Create agents alone, a channel it proposes that I'm not in isn't offered: it joins the ones I'm in", async () => {
    const state = seedState();
    meWithRole(state, ["create_agents"]);
    state.channels.push({
      id: DESIGN_ID,
      name: "design",
      topic: "",
      visibility: "public",
      isMember: false,
      createdAt: NOW.toISOString(),
    });
    state.messages.push(proposal("p-1", {}, { channelIds: [ENG_ID, DESIGN_ID] }));
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    const chips = [...document.querySelectorAll(".newag__review .ac-chip")].map((c) => c.textContent);
    expect(chips).toContain("eng");
    expect(chips).not.toContain("design");
    await click(screen().getByRole("button", { name: "Criar Nina" }), 10);
    const joined = state.calls.find((c) => c.method === "agents.setChannels")?.args[2];
    expect(joined).toEqual([{ channelId: ENG_ID }]);
  });

  test("changing the role keeps the rest of the draft; its words are a field of their own", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    await click(screen().getByRole("button", { name: "Editar Papel" }));
    const custom = screen().getByRole("button", { name: /^Do zero/ });
    expect(custom.getAttribute("aria-pressed")).toBe("true");
    expect((screen().getByLabelText("Cargo") as HTMLInputElement).value).toBe("Designer");
    // Again on the role it has: nothing changes.
    await click(custom);
    expect((screen().getByLabelText("Cargo") as HTMLInputElement).value).toBe("Designer");
    await typeIn(screen().getByLabelText("Cargo"), "Design de produto");
    // Another role and back: the name, the instructions and the words stay.
    await click(screen().getByRole("button", { name: /^QA/ }));
    await click(screen().getByRole("button", { name: /^Do zero/ }));
    expect((screen().getByLabelText("Cargo") as HTMLInputElement).value).toBe("Design de produto");
    await click(railStep("Revisar e criar"));
    await click(screen().getByRole("button", { name: "Criar Nina" }), 10);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({
      name: "Nina",
      handle: "nina",
      role: "Design de produto",
      instructions: "Desenha as telas.",
      appearance: { color: "rose", eyes: "happy", accessory: "bow" },
      proposal: "p-1",
    });
  });

  test("Recusar on the review says no and goes back to the conversation", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    const { router } = await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    await click(screen().getByRole("button", { name: "Recusar" }), 8);
    expect(state.calls.some((c) => c.method === "agents.denyProposal" && c.args[1] === "p-1")).toBe(true);
    expect(state.calls.some((c) => c.method === "agents.create")).toBe(false);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});
