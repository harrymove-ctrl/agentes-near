import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ManagedTask } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

// The geometry check lays these screens out at 1280, 390 and 320: what a request card must survive.
const LONG_ADDRESS = "financeiro.contas-a-receber.filial-norte-sul-leste@comercial-distribuidora.example.com";
const LONG_VALUE =
  "Seu reembolso do pedido 4821 foi aprovado hoje e cai na conta cadastrada em até cinco dias úteis, sem custo.";

/** The seed's request in #eng at its worst: an address that never breaks on its own, code in its why, a long value. */
function worst(status: "pending" | "approved") {
  const state = seedState();
  const first = state.approvals[0];
  if (!first) throw new Error("no approval");
  Object.assign(first, {
    why: "Rodei `bun test apps/web/test/request-card.test.tsx` e o deploy precisa de **aprovação** antes de `main`.",
    detail: "send_email · to=cliente@example.com",
    params: { to: LONG_ADDRESS, body: LONG_VALUE },
    ...(status === "pending"
      ? {}
      : {
          status: "approved",
          canDecide: false,
          canCancel: true,
          runAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
          decidedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
          decidedByUserId: "u-joao",
        }),
  });
  return state;
}

describe("a request card at its worst", () => {
  test("its why draws code as code, Ver detalhes under its words, a long value on a row of its own", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(worst("pending")) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.querySelector(".rq__lead code.ac-inlinecode")?.textContent).toBe(
      "bun test apps/web/test/request-card.test.tsx",
    );
    expect(card.querySelector(".rq__lead strong")?.textContent).toBe("aprovação");
    const more = card.querySelector(".rq__wt > .rq__more") as HTMLElement;
    expect(more).toBeTruthy();
    await act(async () => fireEvent.click(more));
    await settle(3);
    const rows = [...card.querySelectorAll(".ap-exact__rows > div")] as HTMLElement[];
    expect(rows.find((r) => r.textContent?.includes(LONG_VALUE))?.hasAttribute("data-long")).toBe(true);
  });

  test("approved ahead: when it runs is a quiet line under the pill, never the pill's time", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(worst("approved")) });
    await settle(4);
    const pill = screen().getByRole("group", { name: "Aprovação concluída" });
    expect(pill.querySelector(".rq-done__note")?.textContent).toMatch(/^Agendado para /);
    expect(pill.querySelector(".ac-eventpill__time")?.textContent).not.toMatch(/Agendado/);
    expect(within(pill).getByRole("button", { name: "Cancelar" })).toBeTruthy();
  });
});

/** The seed's request in #eng as one that offers Aprovar sempre: three buttons and the time left in its footer. */
function always(state = worst("pending")) {
  const first = state.approvals[0];
  if (!first) throw new Error("no approval");
  Object.assign(first, {
    tool: "composio_COMPOSIO_MULTI_EXECUTE_TOOL",
    scope: "custom:conn-composio:write",
    connector: "custom:conn-composio",
    approveAlways: { tool: "COMPOSIO_MULTI_EXECUTE_TOOL", actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"] },
  });
  return state;
}

describe("an email to an address that never breaks on its own", () => {
  test("the well's title gets the card's width under the mark, the address breaks only where it must", async () => {
    const state = seedState();
    const first = state.approvals[0];
    if (!first) throw new Error("no approval");
    first.email = {
      verb: "send",
      mailbox: "suporte@acme.example.com",
      provider: "Gmail",
      from: "suporte@acme.example.com",
      to: [LONG_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Seu reembolso foi aprovado",
      body: LONG_VALUE,
      original: null,
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.querySelector(".rq__wt b")?.textContent).toContain(LONG_ADDRESS);
  });
});

describe("a request card's footer in long languages", () => {
  test("three buttons and the time left, in German and Japanese: 32 tall, 8 apart, wrapping at their own widths", async () => {
    const { services } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(always()) });
    await settle(4);
    const foot = () => document.querySelector('.rq[data-ask-kind="approval"] .rq__foot');
    expect(foot()?.querySelectorAll(":scope > .ac-btn")).toHaveLength(3);
    await showIn(services, "de");
    expect(foot()?.querySelectorAll(":scope > .ac-btn")).toHaveLength(3);
    await showIn(services, "ja");
    expect(foot()?.querySelectorAll(":scope > .ac-btn")).toHaveLength(3);
  });
});

describe("heads at their worst", () => {
  test("a task's 96-character title: #131 inline before it, ⋯ and × beside its first line", async () => {
    const api = createFakeApi(seedState());
    const long = "Confirmação do agendamento por WhatsApp para pacientes da filial norte com lembrete na véspera";
    const { list, get } = api.issues;
    api.issues.list = async (orgId, filters) =>
      (await list(orgId, filters)).map((i) => (i.number === 131 ? { ...i, title: long } : i));
    api.issues.get = async (orgId, number) => {
      const i = await get(orgId, number);
      return i.number === 131 ? { ...i, title: long } : i;
    };
    await renderApp(`/org/${ORG_ID}/issues?open=131`, { api });
    await settle(6);
    const bar = screen().getByRole("dialog", { name: long }).querySelector(".ac-details__bar") as HTMLElement;
    expect(bar.querySelector(".issue-bartitle__number + .issue-inplace")).not.toBeNull();
    expect(
      [...(bar.querySelector(".ac-details__close")?.children ?? [])].map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Mais opções", "Fechar"]);
  });

  test("a review's long Onde: each fact whole on its line, the undo trait a chip after the title", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge) throw new Error("no approval");
    Object.assign(merge, {
      params: { ...merge.params, repo: "agentes-chat/integracao-de-pagamentos-recorrentes-com-checkout", number: 4821 },
    });
    await renderApp(`/org/${ORG_ID}/approvals?open=ap-merge`, { api: createFakeApi(state) });
    await settle(8);
    const pane = document.querySelector(".ap-review") as HTMLElement;
    expect(pane.querySelector(".ap-review__title + .ap-review__undo")?.textContent).toBe("Reversível");
    expect([...pane.querySelectorAll(".ac-facts__label")].map((l) => l.textContent)).not.toContain("Desfazer");
  });
});

// Names too long to share a phone's line with the header's glyphs.
const LONG_PERSON = "Maria Eduarda Albuquerque de Figueiredo";
const LONG_AGENT = "Assistente de Atendimento ao Cliente";
const LONG_CHANNEL = "atendimento-ao-cliente-filial-norte";

/** A header's name and its glyphs: an action line, the glyphs one group after the words (`.channel__acts`). */
const lineOf = () => {
  const header = document.querySelector(".channel__header") as HTMLElement;
  const line = header.querySelector(":scope > .ac-actline") as HTMLElement;
  expect(line).not.toBeNull();
  const acts = line.querySelector(":scope > .channel__acts") as HTMLElement;
  expect(acts).not.toBeNull();
  return { header, line, acts };
};

describe("headers at their worst: the name wraps whole, the glyphs go under it as one group", () => {
  test("a DM with a person: the face and the name, then the search", async () => {
    const state = seedState();
    state.members.push({
      userId: "u-maria",
      name: LONG_PERSON,
      email: "maria.eduarda@example.com",
      image: null,
      role: "member",
      joinedAt: new Date(Date.now() - 86_400_000).toISOString(),
      handle: "maria",
      timezone: "America/Sao_Paulo",
    });
    await renderApp(`/org/${ORG_ID}/dm/person/u-maria`, { api: createFakeApi(state) });
    await settle(8);
    const { header, line, acts } = lineOf();
    expect(line.firstElementChild?.matches(".dm-who")).toBe(true);
    expect(within(header).getByRole("heading", { level: 1, name: LONG_PERSON })).toBeTruthy();
    expect(within(acts).getByRole("combobox", { name: "Buscar" })).toBeTruthy();
  });

  test("a DM with an agent: its tasks, the search and the side panel's toggle in one group", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (!ada) throw new Error("no Ada");
    ada.name = LONG_AGENT;
    const at = new Date(Date.now() - 6 * 60_000).toISOString();
    const task: ManagedTask = {
      runId: "r-long",
      agentId: ADA_ID,
      channelId: ENG_ID,
      channelKind: "channel",
      channelName: "eng",
      threadId: null,
      status: "running",
      startedAt: at,
      createdAt: at,
      label: "Responder os chamados da fila de reembolso",
      background: false,
      routine: null,
      plan: null,
      requester: { userId: "u-walter", name: "Walter" },
      brain: "model",
      machine: null,
      now: null,
      steps: 1,
      pendingMessageIds: [],
      canStop: true,
    };
    state.taskManager = { tasks: [task], ended: [], activity: {} };
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const { header, line, acts } = lineOf();
    expect(line.firstElementChild?.matches(".dm-who")).toBe(true);
    expect(within(header).getByRole("heading", { level: 1, name: LONG_AGENT })).toBeTruthy();
    expect(acts.querySelector(".tm-pill")).not.toBeNull();
    expect(within(acts).getByRole("combobox", { name: "Buscar" })).toBeTruthy();
    expect(acts.lastElementChild?.matches(".dm-side-toggle")).toBe(true);
  });

  test("a channel: the # and its name, then threads, pins, settings, members and the search", async () => {
    const state = seedState();
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (!eng) throw new Error("no #eng");
    eng.name = LONG_CHANNEL;
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const { header, line, acts } = lineOf();
    expect(line.firstElementChild?.matches(".channel__head-text")).toBe(true);
    expect(within(header).getByRole("heading", { level: 1, name: LONG_CHANNEL })).toBeTruthy();
    expect(within(acts).getByRole("button", { name: "Configurações do canal" })).toBeTruthy();
  });
});
