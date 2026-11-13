import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import type { TeamWeekCard } from "@agenteschat/client/lib/team-week";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { ADA_ID, createFakeApi, GENERAL_ID, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(cleanup);

const card = (over: Partial<TeamWeekCard> = {}): TeamWeekCard => ({
  kind: "team_week",
  forUserId: "u-walter",
  from: "2026-10-30",
  to: "2026-11-06",
  timezone: "America/Sao_Paulo",
  stats: { done: 46, stuck: 3, waiting: 0, spentNanoUsd: 41_000_000_000, budgetNanoUsd: 80_000_000_000 },
  worked: [{ kind: "runs", agentId: ADA_ID, channelId: GENERAL_ID, count: 38 }],
  rows: [
    {
      id: "routine:ada",
      kind: "routine",
      agentId: ADA_ID,
      channelId: "dm",
      dm: true,
      text: "Manda o resumo do dia",
      count: 3,
      hour: 18,
    },
    {
      id: "stalled:t",
      kind: "stalled",
      issueId: "t-10",
      number: 10,
      title: "Skills do time",
      steps: [12, 13, 14],
      onNumber: 11,
      hours: 4,
      agentId: ADA_ID,
    },
  ],
  proposalIds: [],
  done: {},
  dismissedAt: null,
  ...over,
});

function lodiWeek(c: TeamWeekCard) {
  const s = withRightHand(seedState());
  const ch = seedDm(s, { type: "agent", id: LODI_ID });
  s.messages = s.messages.filter((m) => m.channelId !== ch);
  s.messages.push({
    id: "m-week",
    channelId: ch,
    threadId: null,
    author: { type: "agent", id: LODI_ID },
    body: "Sua semana da equipe está pronta",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
    meta: { bodyCode: "team_week", bodyParams: { from: c.from, to: c.to }, actionCard: c },
  } as Message);
  return s;
}

test("the week's card: its numbers, what worked, a row per fix and the schedule; rows apply as the person", async () => {
  const s = lodiWeek(card());
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Semana da equipe" });
  expect(group.textContent).toContain("46");
  expect(group.textContent).toContain("tarefas feitas");
  expect(group.textContent).toContain("2 sugestões");
  expect(group.textContent).toContain("trabalhos em #");
  expect(group.textContent).toContain("Os passos #12, #13 e #14 estão parados há 4 h esperando o #11.");
  expect(group.textContent).toContain("Toda sexta às 17:00");
  // Its week is the message's words, in a bubble in a DM, with the card under them: never a line of the card's own.
  const week = screen.getAllByRole("article").find((a) => a.contains(group)) as HTMLElement;
  expect(week.querySelector(".ac-msg__text")?.textContent).toContain("Como foi a semana do time");
  expect(group.textContent).not.toContain("Como foi a semana do time");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Criar rotina" }));
  });
  await settle(4);
  expect(s.calls.find((c) => c.method === "orgs.actOnTeamWeek")?.args).toEqual([
    ORG_ID,
    "m-week",
    { rowId: "routine:ada" },
  ]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Liberar em paralelo" }));
  });
  await settle(4);
  const sent = s.calls.filter((c) => c.method === "orgs.actOnTeamWeek").at(-1)?.args[2] as { text: string };
  expect(sent.text).toStartWith("@");
  expect(sent.text).toContain("#12, #13 e #14");
});

test("applied rows read how they ended, and a card put away keeps only its numbers", async () => {
  const at = new Date().toISOString();
  const s = lodiWeek(
    card({ done: { "routine:ada": { byUserId: "u-walter", at, routineId: "r1" } }, dismissedAt: null }),
  );
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Semana da equipe" });
  expect(group.textContent).toContain("Rotina criada");
  expect(group.textContent).toContain("1 sugestão");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
  });
  await settle(4);
  expect(s.calls.find((c) => c.method === "orgs.actOnTeamWeek")?.args).toEqual([ORG_ID, "m-week", { dismiss: true }]);
});
