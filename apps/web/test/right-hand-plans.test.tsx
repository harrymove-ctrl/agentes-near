import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { openAiSelect, payWith } from "./ai-picker";
import { createFakeApi, fakeAgentBrain, LODI_ID, NOW, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The team's right hand on a Claude plan (ADR 0137 §1, §7): the line its DM shows, and the plans Connect offers it. */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const line = (reason: string): Message => ({
  id: "m-line",
  channelId: `dm-${LODI_ID}`,
  threadId: null,
  author: { type: "agent", id: LODI_ID },
  body: "I can't answer now: the computer my plan is signed in on is away.",
  mentionedAgentIds: [],
  agentRunId: "r-line",
  meta: {
    bodyCode: "no_ai",
    noAi: { agentId: LODI_ID, forUserId: "u-walter", reason, intent: "task", runId: "r-line" },
  },
  createdAt: NOW.toISOString(),
});

const lodiOnPlan = (reason: string) => {
  const state = withRightHand(
    seedState({ aiStatus: { any: true, agents: [{ agentId: LODI_ID, state: "waiting" }] } }),
    { brain: { kind: "claude_code", model: "Sonnet" } },
  );
  seedDm(state, { type: "agent", id: LODI_ID });
  state.messages.push(line(reason));
  return state;
};

test("its plan's computer away: one plain line in its DM, and Usar uma chave de API opens Connect on the key", async () => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(lodiOnPlan("computer_away")) });
  await settle(8);
  const card = document.querySelector(".rq-open") as HTMLElement;
  expect(card.textContent).toContain("Lodi não consegue responder agora: o computador do plano está fora do ar.");
  // Never a spinner, never "Conectar" as if it had no AI.
  expect(card.querySelector(".ac-spinner")).toBeNull();
  expect(within(card).queryByRole("button", { name: "Conectar" })).toBeNull();
  await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Usar uma chave de API" })));
  await settle(6);
  const dialog = screen().getByRole("dialog", { name: /Lodi/ });
  // Every plan, as for any agent: Codex's and Cursor's too (ADR 0137 §4, the owner's accepted risk).
  await act(async () => fireEvent.click(payWith(dialog, "Com um plano")));
  await settle(4);
  const plans = (await openAiSelect(dialog)).map((o) => o.textContent);
  expect(plans).toEqual(expect.arrayContaining(["Claude", "ChatGPT", "Cursor", "OpenCode"]));
});

test("the workspace's plan serves only its owner: the line says so, and Conectar meu plano opens Connect", async () => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(lodiOnPlan("plan_not_shared")) });
  await settle(8);
  const card = document.querySelector(".rq-open") as HTMLElement;
  expect(card.textContent).toContain(
    "Conecte o seu plano para conversar com Lodi: o plano do workspace só atende o próprio dono.",
  );
  expect(within(card).queryByRole("button", { name: "Usar uma chave de API" })).toBeNull();
  await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Conectar meu plano" })));
  await settle(6);
  expect(screen().getByRole("dialog", { name: /Lodi/ })).toBeTruthy();
});

test("its computer's runner too old: the line says to update it, never that it has no AI", async () => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(lodiOnPlan("runner_outdated")) });
  await settle(8);
  const card = document.querySelector(".rq-open") as HTMLElement;
  expect(card.textContent).toContain(
    "Lodi não consegue responder agora: o programa no computador do plano precisa ser atualizado.",
  );
  expect(card.textContent).not.toContain("nenhuma IA");
  expect(within(card).getByRole("button", { name: "Usar uma chave de API" })).toBeTruthy();
});

test("Settings › Lodi on someone else's OpenCode plan: an admin may still let other people's DMs use it", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "opencode", model: "opencode/glm-5.3" } });
  const api = createFakeApi(state);
  api.agents.brain = async () =>
    fakeAgentBrain(LODI_ID, {
      brain: "opencode",
      account: "acc-ana",
      accounts: [
        {
          id: "acc-ana",
          kind: "opencode",
          label: "Zen da Ana",
          ownerId: "u-ana",
          status: "active",
          shared: true,
          usedBy: [],
        } as never,
      ],
      onlyOwner: true,
      canUsePlans: false,
      canEdit: true,
    });
  await renderApp(`/org/${ORG_ID}/settings/right_hand`, { api });
  await settle(8);
  const body = document.querySelector(".page") as HTMLElement;
  expect(
    within(body)
      .getByRole("button", { name: /^IA de quem não tem plano próprio/ })
      .querySelector(".settings-row__status")?.textContent,
  ).toBe("Plano Zen da Ana");
  const share = within(body).getByRole("switch", { name: "Emprestar este plano a quem não tem um" });
  expect(share.hasAttribute("disabled")).toBe(false);
  await act(async () => fireEvent.click(share));
  await settle(4);
  expect(state.calls.find((c) => c.method === "agents.setBrain")?.args.slice(1)).toEqual([
    LODI_ID,
    { scope: "workspace", onlyOwner: false },
  ]);
});

test("Connect for it, with a ChatGPT plan another agent already thinks with: that plan first, and no endless spinner", async () => {
  const state = withRightHand(seedState({ aiStatus: { any: true, agents: [{ agentId: LODI_ID, state: "no_ai" }] } }), {
    ownerUserId: "u-walter",
  });
  seedDm(state, { type: "agent", id: LODI_ID });
  const api = createFakeApi(state);
  api.agents.brain = async (_orgId, agentId) =>
    fakeAgentBrain(agentId, {
      accounts: [
        {
          id: "acc-chatgpt",
          kind: "codex",
          label: "ChatGPT",
          email: null,
          plan: "plus",
          status: "active",
          ownerId: "u-walter",
          ownerName: "Walter",
          mine: true,
          shared: true,
          usedBy: ["Ada"],
          usage: null,
          provider: null,
          keyHint: null,
        } as never,
      ],
    });
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api });
  await settle(8);
  const card = [...document.querySelectorAll<HTMLElement>(".rq-open")].find((c) =>
    c.textContent?.includes("Conectar uma IA para o time"),
  ) as HTMLElement;
  await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Conectar" })));
  await settle(8);
  // The narrow dialog under the sky, for the right hand alone: what the person already has comes first.
  const dialog = screen().getByRole("dialog", { name: "Conectar uma IA para o Lodi" });
  expect(dialog.querySelector(".arrival-hero")).not.toBeNull();
  expect(dialog.querySelector(".ai-picker")).toBeNull();
  expect(dialog.textContent).toContain("ChatGPT · Plus");
  // Another AI's steps can be pressed now, never a button loading for good; Back returns to the plan it has.
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Conectar outra IA" })));
  await settle(4);
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /^ChatGPT/ })));
  await settle(10);
  expect(within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" })).toBeTruthy();
  expect(dialog.querySelector('[aria-busy="true"]')).toBeNull();
  for (const _ of [1, 2]) {
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Voltar" })));
    await settle(4);
  }
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /^Usar ChatGPT · Plus/ })));
  await settle(6);
  expect(state.calls.find((c) => c.method === "agents.setBrain")?.args.slice(1)).toEqual([
    LODI_ID,
    { brain: "codex", account: "acc-chatgpt" },
  ]);
});
