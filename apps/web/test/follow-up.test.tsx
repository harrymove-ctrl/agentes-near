import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { formatTime } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

test("an agent's follow-up shows as a quiet line with when it comes back, and anyone here can cancel it", async () => {
  const state = seedState();
  // Today, so the line needs no day.
  const at = new Date(new Date().setHours(12, 0, 0, 0)).toISOString();
  const line = (id: string, refs: Record<string, string>, minutesAgo: number) => ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ATLAS_ID },
    body: "Check CI run 42 and give the per-job times.",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { notice: { kind: "follow_up", text: "Check CI run 42 and give the per-job times.", refs } },
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  state.messages.push(
    line("m-set", { runId: "r1", at, about: "ver o CI", state: "pending" }, 3),
    line("m-old", { runId: "r0", at, about: "ver o deploy", state: "canceled" }, 2),
  );
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);

  const time = formatTime("pt-BR", at);
  expect(screen().getByText(new RegExp(`Atlas volta às ${time} para «ver o CI»`))).toBeTruthy();
  expect(screen().getByText(new RegExp(`Atlas não volta mais às ${time} para «ver o deploy»`))).toBeTruthy();
  // Only the one still to come can be canceled.
  const cancel = screen().getAllByRole("button", { name: "Cancelar" });
  expect(cancel.length).toBe(1);
  await act(async () => fireEvent.click(cancel[0] as HTMLElement));
  expect(state.calls.filter((c) => c.method === "chat.cancelFollowUp").map((c) => c.args)).toEqual([[ORG_ID, "m-set"]]);
});

test("a follow-up that came and a mention its message explains leave the conversation; what stays opens people's words", async () => {
  const state = seedState();
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const said = (id: string, minutesAgo: number, body: string, meta?: Record<string, unknown>) => ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ATLAS_ID },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    ...(meta ? { meta } : {}),
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  const agentText = "Check CI run 42 via github_actions_list and tell the channel.";
  const follow = (refs: Record<string, string>) => ({
    notice: { kind: "follow_up", text: agentText, refs: { runId: "r1", at, about: "ver o CI", ...refs } },
  });
  const skipped = (messageId: string, reason: string) => ({
    notice: {
      kind: "wake_skipped",
      text: "@ada wasn't woken by your mention: only certain people may talk to it.",
      refs: { runId: "r2", messageId, agentHandles: "ada", reason },
    },
  });
  state.messages.push(
    said("m-set", 30, agentText, follow({ state: "done" })),
    said("m-woke", 10, agentText, follow({ wake: "1", followUpId: "m-set" })),
    said("m-back", 9, "O CI passou, todos os jobs em verde."),
    said("m-named", 8, "@ada confere a loja?", {
      reach: [{ agentId: ADA_ID, handle: "ada", reason: "audience", userId: "u-joao" }],
    }),
    said("m-skip-folded", 8, "@ada wasn't woken", skipped("m-named", "audience")),
    said("m-skip", 7, "@ada wasn't woken", skipped("elsewhere", "callable")),
  );
  // Only some people may talk to Ada: the message that named her says so, with the way to let João in.
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.audience = { mode: "people", userIds: ["u-walter"] };
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);

  const text = () => document.body.textContent ?? "";
  expect(screen().getByRole("button", { name: /Deixar João falar com/ })).toBeTruthy();
  expect(text()).toContain("O CI passou");
  expect(text()).not.toContain("voltou");
  // One line for the mention no message here explains; the other folded into its message's own line.
  expect(screen().getAllByText(/A menção de Atlas não chamou Ada/).length).toBe(1);
  await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Ver$/ })));
  expect(text()).toContain("As configurações de Atlas não deixam chamar Ada");
  expect(text()).not.toContain("wasn't woken");
  expect(text()).not.toContain("github_actions_list");
});
