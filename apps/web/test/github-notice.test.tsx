import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

test("what a stranger wrote on GitHub is a quiet line with their words, and anyone here can ask the agent to reply", async () => {
  const state = seedState();
  const notice = (id: string, refs: Record<string, string>, minutesAgo: number) => ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ATLAS_ID },
    body: "drive-by commented on PR #12 (acme/app) on GitHub: Pode revisar o teste?",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {
      notice: {
        kind: "github_event",
        text: "Pode revisar o teste?",
        refs: {
          event: "comment",
          item: "pull_request",
          who: "drive-by",
          number: "12",
          repo: "acme/app",
          url: "https://github.com/acme/app/pull/12#issuecomment-1",
          ...refs,
        },
      },
    },
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  // The worst case the line must wrap, never cut: a long name and repository, and both of its actions.
  const long = {
    outside: "1",
    who: "Maria Aparecida dos Santos Figueiredo-Albuquerque",
    number: "123456",
    repo: "an-organization-with-a-long-name/a-repository-with-an-even-longer-name",
  };
  state.messages.push(
    notice("m-asked", { outside: "1", answeredBy: "u-joao" }, 3),
    notice("m-new", { outside: "1" }, 2),
    notice("m-long", long, 1),
  );
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);

  expect(screen().getAllByText("drive-by comentou no PR #12 (acme/app) no GitHub").length).toBe(2);
  expect(screen().getByText(`${long.who} comentou no PR #${long.number} (${long.repo}) no GitHub`)).toBeTruthy();
  // Only the ones nobody asked about yet.
  const ask = screen().getAllByRole("button", { name: "Pedir resposta" });
  expect(ask.length).toBe(2);
  await act(async () => fireEvent.click(ask[0] as HTMLElement));
  expect(state.calls.filter((c) => c.method === "chat.answerGitHub").map((c) => c.args)).toEqual([[ORG_ID, "m-new"]]);
});
