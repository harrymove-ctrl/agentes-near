import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import i18next, { type TFunction } from "i18next";
import type { Approval, Proposal } from "../src/api/types";
import { actionCardOf } from "../src/lib/action-cards";
import { serverBody } from "../src/lib/message-body";
import {
  appliesInBulk,
  type TeamWeekCard,
  type TeamWeekNames,
  teamWeekOn,
  teamWeekRowMessage,
  teamWeekRowState,
  teamWeekRowText,
  teamWeekTitleKey,
  teamWeekWhen,
  weekDay,
} from "../src/lib/team-week";

/** Lodi's weekly card (ADR 0137 §9): parsed, its rows' state from live data, and its words in every language. */

const tOf = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as unknown as TFunction;
};

const card: TeamWeekCard = {
  kind: "team_week",
  forUserId: "u1",
  from: "2026-10-30",
  to: "2026-11-06",
  timezone: "America/Sao_Paulo",
  stats: { done: 46, stuck: 3, waiting: 2, spentNanoUsd: 41e9, budgetNanoUsd: 80e9 },
  worked: [],
  rows: [
    {
      id: "approvals:caio",
      kind: "approvals",
      agentId: "caio",
      approvalIds: ["ap1", "ap2"],
      since: "2026-11-02T12:00:00Z",
    },
    { id: "budget:ada", kind: "budget", agentId: "ada", proposalId: "p1", stops: 2, from: 20e9, to: 30e9 },
    { id: "channel:theo", kind: "channel", agentId: "theo", proposalId: "p2", channelId: "c-general" },
    { id: "unanswered:c", kind: "unanswered", channelId: "c-atd", count: 6 },
    {
      id: "stalled:t",
      kind: "stalled",
      issueId: "t",
      number: 10,
      title: "Skills",
      steps: [12, 13, 14],
      onNumber: 11,
      hours: 4,
      agentId: "ada",
    },
  ],
  proposalIds: ["p1", "p2"],
  done: { "unanswered:c": { byUserId: "u1", at: "2026-11-06T21:00:00Z" } },
  dismissedAt: null,
};

const names: TeamWeekNames = {
  agent: (id) => ({ caio: "Caio", ada: "Ada", theo: "Theo" })[id ?? ""] ?? "?",
  handle: (id) => (id === "ada" ? "ada" : null),
  channel: (id) => ({ "c-general": "general", "c-atd": "atendimento" })[id] ?? "?",
  usd: (n) => `US$ ${Math.round(n / 1e9)}`,
  join: (list) => list.join(", "),
  since: () => "seg., 09:00",
};

test("the card is an action card, read whatever its meta lacks", () => {
  expect(actionCardOf({ actionCard: card })?.kind).toBe("team_week");
  const bare = actionCardOf({ actionCard: { ...card, done: undefined, worked: undefined } });
  expect(bare && "done" in bare ? bare.done : null).toEqual({});
  expect(actionCardOf({ actionCard: { kind: "team_week" } })).toBeNull();
});

test("each row's state comes from live data: proposals, approvals, or what was applied on the card", () => {
  const proposal = (id: string, status: Proposal["status"]) => ({ id, status, stale: false }) as Proposal;
  const approval = (id: string, status: Approval["status"]) => ({ id, status }) as Approval;
  const live = {
    proposals: [proposal("p1", "accepted"), proposal("p2", "pending")],
    approvals: [approval("ap1", "approved"), approval("ap2", "pending")],
  };
  const states = card.rows.map((r) => teamWeekRowState(card, r, live));
  expect(states).toEqual(["open", "done", "open", "done", "open"]);
  const decided = { ...live, approvals: [approval("ap1", "approved"), approval("ap2", "refused")] };
  expect(teamWeekRowState(card, card.rows[0] as never, decided)).toBe("done");
  const refused = { ...live, proposals: [proposal("p2", "refused")] };
  expect(teamWeekRowState(card, card.rows[2] as never, refused)).toBe("gone");
  // Approvals are read and decided one by one, never in "Aplicar as N".
  expect(card.rows.filter(appliesInBulk).map((r) => r.kind)).toEqual(["budget", "channel", "unanswered", "stalled"]);
});

test("its words in pt-BR, with the agent's gender", () => {
  const t = tOf("pt-BR");
  const text = card.rows.map((r) => teamWeekRowText(t, "pt-BR", r, names));
  expect(text[0]).toEqual({
    title: "2 pedidos de Caio esperam você",
    line: "Esperando desde seg., 09:00.",
    action: "Ver e aprovar",
  });
  expect(text[1]?.title).toBe("Orçamento da Ada: US$ 20 → US$ 30");
  expect(text[1]?.line).toBe("Parou 2 vezes no limite do mês.");
  expect(text[2]?.title).toBe("Colocar o Theo em #general");
  expect(text[3]?.line).toBe("6 perguntas ficaram sem resposta em #atendimento esta semana.");
  expect(text[4]?.line).toBe("Os passos #12, #13, #14 estão parados há 4 h esperando o #11.");
  expect(teamWeekRowMessage(t, card.rows[4] as never, names)).toBe(
    "@ada os passos #12, #13, #14 não precisam esperar o #11. Pode seguir com eles em paralelo.",
  );
  expect(teamWeekWhen(t, "pt-BR", { day: 5, hour: 17 })).toBe("Toda sexta às 17:00");
  expect(teamWeekWhen(t, "pt-BR", { day: 6, hour: 9 })).toBe("Todo sábado às 9:00");
  expect(weekDay("pt-BR", "2026-11-06")).toBe("6 de nov.");
  expect(serverBody(t, "Sua semana", { bodyCode: "team_week", bodyParams: card }, "pt-BR")).toBe(
    "Como foi a semana do time, de 30 de out. a 6 de nov.",
  );
  // A list without the locale keeps the body the server wrote in the person's language.
  expect(serverBody(t, "Sua semana da equipe está pronta", { bodyCode: "team_week" })).toBe(
    "Sua semana da equipe está pronta",
  );
});

test("every language says every row, with no key left showing", () => {
  for (const lng of LOCALE_CODES) {
    const t = tOf(lng);
    for (const r of card.rows) {
      const { title, line, action } = teamWeekRowText(t, lng, r, names);
      for (const s of [title, line, action]) expect([lng, s.includes("teamWeek.")]).toEqual([lng, false]);
    }
    expect([lng, teamWeekWhen(t, lng, { day: 1, hour: 9 }).includes("teamWeek.")]).toEqual([lng, false]);
  }
});

test("Resumo do dia: its title, its hour, its line, and who gets it", () => {
  const t = tOf("pt-BR");
  expect(teamWeekTitleKey({ period: "day" })).toBe("teamWeek.dayTitle");
  expect(teamWeekTitleKey({})).toBe("teamWeek.title");
  expect(t(teamWeekTitleKey({ period: "day" }))).toBe("Resumo do dia");
  expect(teamWeekWhen(t, "pt-BR", { day: 5, hour: 9, daily: true })).toBe("Todo dia às 9:00");
  expect(serverBody(t, "Seu resumo", { bodyCode: "team_week", bodyParams: { ...card, period: "day" } }, "pt-BR")).toBe(
    "Como foi o dia do time, até 6 de nov.",
  );
  // An admin's weekly card comes unless off; anyone else's only once they asked for it daily.
  expect(teamWeekOn({ off: false }, true)).toBe(true);
  expect(teamWeekOn({ off: false }, false)).toBe(false);
  expect(teamWeekOn({ off: false, daily: true }, false)).toBe(true);
  expect(teamWeekOn({ off: true, daily: true }, true)).toBe(false);
  for (const lng of LOCALE_CODES) {
    const tl = tOf(lng);
    expect([lng, teamWeekWhen(tl, lng, { day: 1, hour: 9, daily: true }).includes("teamWeek.")]).toEqual([lng, false]);
    expect([lng, tl("teamWeek.dayTitle").includes("teamWeek.")]).toEqual([lng, false]);
  }
});
