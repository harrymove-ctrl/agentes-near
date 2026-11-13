import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentAction, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, createFakeApi, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const DM = `dm-${LODI_ID}`;
const ROOT = "00000000-0000-4000-8000-0000000000f1";
const TASK = "00000000-0000-4000-8000-0000000000f2";

test("Lodi's reply carries the task it handed on as a chip that opens the task's conversation (ADR 0137 §14)", async () => {
  const state = withRightHand(seedState());
  seedDm(state, { type: "agent", id: LODI_ID });
  const created: AgentAction = {
    id: "act-1",
    kind: "issue.created",
    agentId: LODI_ID,
    messageId: "m-handed",
    requestedByUserId: "u-walter",
    target: { type: "issue", id: TASK, number: 131, title: "Campanha de Natal" },
    params: { number: 131, title: "Campanha de Natal", audience: "people" },
    createdAt: new Date().toISOString(),
    undoableUntil: new Date(Date.now() + 300_000).toISOString(),
    undoneAt: null,
    undoneByUserId: null,
    redoneAt: null,
  };
  const reply: Message = {
    id: "m-handed",
    channelId: DM,
    threadId: null,
    author: { type: "agent", id: LODI_ID },
    body: "Passei para a @ada, te aviso quando terminar.",
    mentionedAgentIds: [],
    agentRunId: "r-handed",
    meta: {
      tasks: [
        { issueId: TASK, number: 131, title: "Campanha de Natal", agentId: ADA_ID, channelId: "c-task", rootId: ROOT },
      ],
    },
    actions: [created],
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  };
  state.messages.push(reply);
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  await act(async () => r.sockets.last().open());
  await settle(3);

  const chip = screen().getByRole("link", { name: "Abrir a conversa da tarefa #131, Campanha de Natal" });
  expect(chip.textContent).toContain("#131");
  expect(chip.textContent).toContain("Ada");
  // The task is its chip: no "created the task" receipt under it.
  expect(document.querySelector(".ag-rc")).toBeNull();
  const went: unknown[] = [];
  const stop = r.router.subscribe("onBeforeNavigate", (e) => went.push(e.toLocation.search));
  await act(async () => fireEvent.click(chip));
  await settle(6);
  stop();
  // The conversation opens beside the chat, at the task's thread.
  expect(went).toContainEqual(expect.objectContaining({ thread: ROOT }));
});
