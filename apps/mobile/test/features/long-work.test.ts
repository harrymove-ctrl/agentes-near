import { describe, expect, test } from "bun:test";
import type { AgentStatusLine, WorkView } from "@agenteschat/client";
import {
  autoUpdateText,
  blockedText,
  workAnchorBody,
  workContinuable,
  workLine,
  workStatusText,
  workWaitsOnPerson,
} from "@agenteschat/client/lib/long-work";
import { serverBody } from "@agenteschat/client/lib/message-body";
import { workingNow } from "@agenteschat/client/lib/working";
import { translator } from "./fixtures";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const work = (over: Partial<WorkView> = {}): WorkView => ({
  id: "w1",
  agentId: "ada",
  channelId: "c1",
  title: "Migrar a cobrança",
  status: "live",
  state: "working",
  how: "agent",
  anchorMessageId: "a1",
  threadId: "a1",
  homeThreadId: null,
  runId: "r1",
  requestedByUserId: "me",
  startedAt: ago(12),
  finishedAt: null,
  nextUpdateAt: new Date(NOW.getTime() + 8 * 60_000).toISOString(),
  lastUpdate: { text: "Esquema lido; migrando as tabelas.", at: ago(2), seq: 1 },
  plan: [],
  issue: { id: "i42", number: 42 },
  resultMessageId: null,
  queuePosition: null,
  pausedUntil: null,
  canceledByUserId: null,
  errorCode: null,
  ...over,
});

const ctx = { locale: "pt-BR", now: NOW, meId: "me", agentName: "Ada", canStop: true, nameOf: () => "Bia" };

describe("the line under 'Vou cuidar disso' (phone and web share it)", () => {
  test("every state, in pt-BR", async () => {
    const t = await translator("pt-BR");
    const live = workLine(t, work(), ctx);
    expect(live.text).toBe("Em segundo plano · 12 min · próximo update em ~8 min");
    expect(live.update).toBe("Esquema lido; migrando as tabelas.");
    // Inside the thread its updates go to, they are the messages under it: the line doesn't repeat the last one.
    const inThread = workLine(t, work(), { ...ctx, inUpdatesThread: true });
    expect(inThread.update).toBeNull();
    expect(inThread.text).toBe(live.text);
    expect(live.task?.label).toBe("Tarefa #42");
    expect(live.stop).toEqual({ runId: "r1" });
    expect(workLine(t, work(), { ...ctx, canStop: false }).stop).toBeNull();
    expect(workLine(t, work({ state: "queued", status: "queued", queuePosition: 1 }), ctx).text).toBe(
      "Na fila · começa quando um dos trabalhos de Ada terminar (1º na fila)",
    );
    expect(workLine(t, work({ state: "waiting_approval" }), ctx).text).toBe("Aguardando sua aprovação");
    expect(workLine(t, work({ state: "waiting_approval", requestedByUserId: "bia" }), ctx).text).toBe(
      "Aguardando aprovação",
    );
    expect(workLine(t, work({ state: "paused", pausedUntil: null }), ctx).text).toBe("Pausado no limite do plano");
    const done = workLine(t, work({ status: "done", state: null, finishedAt: ago(-26), resultMessageId: "r" }), ctx);
    expect(done.text).toBe("Terminou em 38 min");
    expect(done.result?.label).toBe("Ver resultado");
    expect(done.stop).toBeNull();
    expect(workLine(t, work({ status: "failed", state: null, resultMessageId: "e" }), ctx).result?.label).toBe(
      "Ver o que aconteceu",
    );
    expect(
      workLine(t, work({ status: "canceled", state: null, finishedAt: NOW.toISOString(), canceledByUserId: "u" }), ctx)
        .text,
    ).toBe("Parado por Bia aos 12 min");
  });

  test("waiting on an answer: what it asks takes the update's place, and only then", async () => {
    const t = await translator("pt-BR");
    const question = { text: "Envio agora ou espero?", messageId: "q1" };
    const asks = workLine(t, work({ state: "waiting_input", question }), ctx);
    expect(asks.text).toBe("Aguardando sua resposta");
    expect(asks.question).toEqual(question);
    expect(asks.update).toBeNull();
    expect(asks.threadId).toBe("a1");
    // Back at work, an old question never lingers on the line.
    const back = workLine(t, work({ state: "working", question }), ctx);
    expect(back.question).toBeNull();
    expect(back.update).toBe("Esquema lido; migrando as tabelas.");
    // Its card draws the Markdown; the line says the same words without the marks.
    const marked = { text: "Envio **agora** ou [espero](https://a.co)?", messageId: "q1" };
    expect(workLine(t, work({ state: "waiting_input", question: marked }), ctx).question?.text).toBe(
      "Envio agora ou espero?",
    );
    // For one person: it waits on them, whoever asked for the work.
    const forThem = (requestedForUserId: string) => ({ ...question, requestedForUserId });
    expect(workLine(t, work({ state: "waiting_input", question: forThem("bia") }), ctx).text).toBe(
      "Aguardando resposta",
    );
    expect(workLine(t, work({ state: "waiting_input", question: forThem("me") }), ctx).text).toBe(
      "Aguardando sua resposta",
    );
    // Nothing to quote (a secret, a hand-off): the line alone, with its last update.
    expect(workLine(t, work({ state: "waiting_input" }), ctx).question).toBeNull();
  });

  test("its line opens the thread beside the thread's own link only while a person's move is in there", () => {
    expect(workWaitsOnPerson({ state: "waiting_input" })).toBe(true);
    expect(workWaitsOnPerson({ state: "waiting_approval" })).toBe(true);
    for (const state of ["working", "paused", "waiting_computer", "queued", null] as const)
      expect(workWaitsOnPerson({ state })).toBe(false);
  });

  test("in English, and a long work's hours", async () => {
    const t = await translator("en");
    expect(workLine(t, work({ startedAt: ago(80) }), { ...ctx, locale: "en" }).text).toBe(
      "In the background · 1 h 20 min · next update in about 8 min",
    );
  });

  test("the agent's status line and the card's blocked badge", async () => {
    const t = await translator("pt-BR");
    const line = (over: Partial<AgentStatusLine>): AgentStatusLine => ({
      by: "auto",
      text: null,
      kind: "work",
      subject: "Migrar a cobrança",
      emoji: null,
      until: null,
      since: ago(20),
      count: 1,
      ...over,
    });
    // The time leads: a line cut to fit loses the end of the title, never the time.
    expect(workStatusText(t, line({}), NOW)).toBe("Trabalhando há 20 min: Migrar a cobrança");
    expect(workStatusText(t, line({ since: ago(1315) }), NOW)).toBe("Trabalhando há 21 h 55 min: Migrar a cobrança");
    expect(workStatusText(t, line({ count: 2, second: "Relatório de churn" }), NOW)).toBe(
      "Em 2 trabalhos: Migrar a cobrança e Relatório de churn",
    );
    expect(workStatusText(t, line({ count: 3 }), NOW)).toBe("Em 3 trabalhos: Migrar a cobrança e mais 2");
    expect(workStatusText(t, line({ wait: "approval" }), NOW)).toBe("Aguardando aprovação: Migrar a cobrança");
    expect(workStatusText(t, line({ subject: null }), NOW)).toBe("Trabalhando há 20 min em segundo plano");
    expect(workStatusText(t, line({ since: undefined }), NOW)).toBe("Trabalhando em: Migrar a cobrança");
    expect(blockedText(t, { reason: "waiting_approval" })).toBe("Bloqueado · aguardando aprovação");
    expect(blockedText(t, { reason: "paused" })).toBe("Pausado · limite do plano");
    expect(blockedText(t, { reason: "failed", text: "run.budget_exceeded" })).toBe(
      "Bloqueado · não terminou: o orçamento do mês acabou",
    );
  });

  test("the server's own update and auto anchor, in the reader's words", async () => {
    const t = await translator("pt-BR");
    expect(autoUpdateText(t, { minutes: "22", kind: "coding" })).toBe(
      "Ainda trabalhando nisso (22 min). Agora: programando.",
    );
    expect(serverBody(t, "fallback", { bodyCode: "work_auto_moved", bodyParams: { minutes: "10" } })).toBe(
      "Isso vai levar um tempo, então sigo em segundo plano. Te aviso aqui. O próximo update deve sair em ~10 min.",
    );
    const en = await translator("en");
    expect(serverBody(en, "x", { bodyCode: "work_auto_update", bodyParams: { minutes: "22" } })).toBe(
      "Still on it (22 min).",
    );
  });

  test("a work that didn't finish or was stopped says why or by whom, and its last update", async () => {
    const t = await translator("pt-BR");
    const failed = {
      bodyCode: "work_end_failed",
      bodyParams: { minutes: "12", title: "Migrar a cobrança" },
      workEnd: {
        id: "w1",
        status: "failed",
        errorCode: "run.provider_unavailable",
        errorParams: { detail: "timeout" },
        lastUpdate: "Tabelas migradas.",
      },
    };
    expect(serverBody(t, "fallback", failed)).toBe(
      "Esse trabalho em segundo plano não terminou (12 min): o provedor do modelo não respondeu: timeout.\n\nÚltimo update: Tabelas migradas.",
    );
    const stuck = { ...failed, workEnd: { id: "w1", status: "failed", errorCode: "run.stuck" } };
    expect(serverBody(t, "fallback", stuck)).toBe(
      "Esse trabalho em segundo plano não terminou (12 min): parou porque travou.",
    );
    const stopped = {
      bodyCode: "work_end_canceled",
      bodyParams: { minutes: "12", title: "Migrar a cobrança", byName: "Bia" },
      workEnd: { id: "w1", status: "canceled", byUserId: "u" },
    };
    expect(serverBody(t, "fallback", stopped)).toBe("Parado por Bia aos 12 min.");
    const en = await translator("en");
    expect(serverBody(en, "fallback", stopped)).toBe("Stopped by Bia after 12 min.");
    expect(serverBody(en, "fallback", stuck)).toBe(
      "This background work didn't finish (12 min): stopped because it got stuck.",
    );
  });

  test("English names several at once as jobs", async () => {
    const t = await translator("en");
    const line: AgentStatusLine = {
      by: "auto",
      text: null,
      kind: "work",
      subject: "Migrate billing",
      emoji: null,
      until: null,
      since: ago(20),
      count: 2,
      second: "Churn report",
    };
    expect(workStatusText(t, line, NOW)).toBe("On 2 jobs: Migrate billing and Churn report");
    expect(
      workLine(t, work({ state: "queued", status: "queued", queuePosition: 1 }), { ...ctx, locale: "en" }).text,
    ).toBe("In line · starts when one of Ada's other jobs ends (#1 in line)");
  });

  test("Conversas and Agentes list a work by its title and plan", () => {
    const items = workingNow(
      [
        {
          runId: "r1",
          agentId: "ada",
          channelId: "c1",
          channelKind: "channel",
          channelName: "geral",
          threadId: "a1",
          status: "running",
          startedAt: ago(5),
          createdAt: ago(20),
          label: "@ada migra a cobrança",
          work: { id: "w1", title: "Migrar a cobrança", plan: { done: 1, total: 3 }, since: ago(20) },
        },
      ],
      [],
    );
    expect(items[0]).toMatchObject({ kind: "work", what: "Migrar a cobrança", plan: { done: 1, total: 3 } });
  });
});

describe("a finished work's anchor (ADR 0121, owner decisions)", () => {
  test("keeps no promise once it's over: the server's words and the agent's last sentence with a time", async () => {
    const t = await translator("pt-BR");
    const said = "Vou cuidar disso em segundo plano. Te aviso aqui. O próximo update deve sair em ~10 min.";
    const auto = { bodyCode: "work_auto_moved", bodyParams: { minutes: "10" } };
    expect(workAnchorBody(t, said, {}, work())).toBe(said);
    for (const status of ["done", "failed", "canceled"] as const) {
      expect(workAnchorBody(t, said, {}, work({ status, state: null }))).toBe(
        "Vou cuidar disso em segundo plano. Te aviso aqui.",
      );
      expect(workAnchorBody(t, serverBody(t, "x", auto), auto, work({ status, state: null }))).toBe(
        "Isso vai levar um tempo, então sigo em segundo plano. Te aviso aqui.",
      );
    }
    // Nothing else of the agent's words goes.
    expect(workAnchorBody(t, "Vou cuidar disso.", {}, work({ status: "done", state: null }))).toBe("Vou cuidar disso.");
    expect(workLine(t, work({ status: "done", state: null, finishedAt: ago(-26) }), ctx).text).toBe(
      "Terminou em 38 min",
    );
  });

  test("Continuar only under the end of a work its AI provider failed, until it was continued", () => {
    const end = (over: Record<string, unknown>) => ({ workEnd: { id: "w1", status: "failed", ...over } });
    expect(workContinuable(end({ errorCode: "run.provider_error" }))).toEqual({ continuedRunId: null });
    expect(workContinuable(end({ errorCode: "run.provider_no_credit" }))).toEqual({ continuedRunId: null });
    // On the server's own key it reads as ours, and it goes on all the same; an error of ours with no provider doesn't.
    expect(workContinuable(end({ errorCode: "run.our_error", errorParams: { provider: "Claude" } }))).toEqual({
      continuedRunId: null,
    });
    expect(workContinuable(end({ errorCode: "run.our_error" }))).toBeNull();
    expect(workContinuable(end({ errorCode: "run.provider_unavailable", continuedRunId: "r2" }))).toEqual({
      continuedRunId: "r2",
    });
    expect(workContinuable(end({ errorCode: "run.budget_exceeded" }))).toBeNull();
    expect(workContinuable({ workEnd: { id: "w1", status: "done" } })).toBeNull();
    expect(workContinuable({})).toBeNull();
  });
});
