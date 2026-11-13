import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { TeamCheck } from "@agenteschat/client";
import { act, cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const BODY = "Revisei o PR #212: resolve. Deixei 1 ajuste pequeno.";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const check = (over: Partial<TeamCheck["matches"][number]> = {}): TeamCheck => ({
  id: "chk-1",
  tool: "open_pull_request",
  targets: ["acme/app@fix/login"],
  matches: [
    {
      agentId: "agent-theo",
      agentName: "Theo",
      channelId: ENG_ID,
      channelName: "eng",
      summary: "GitHub · Corrige login com Google",
      at: ago(2 * 3600_000),
      ...over,
    },
  ],
});

const open = async (teamChecks: TeamCheck[]) => {
  const state = seedState();
  state.messages.push({
    id: "m-chk",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: BODY,
    mentionedAgentIds: [],
    agentRunId: "r-chk",
    createdAt: ago(1_000),
    meta: { teamChecks },
  });
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  await act(async () => r.sockets.last().open());
  await settle(2);
};

const article = () =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes("Revisei o PR")) as HTMLElement;
const group = () => within(article()).getByRole("group", { name: "O que o agente não repetiu" });

describe("what the agent didn't repeat, under its reply (ADR 0064)", () => {
  test("a teammate's action: who, with what, when, where, and Ver opens that conversation", async () => {
    await open([check()]);
    const row = group().querySelector(".ag-rc") as HTMLElement;
    expect(row.textContent).toContain("Não repeti: Theo já tinha feito isso com acme/app@fix/login");
    expect(row.textContent).toContain("GitHub · Corrige login com Google · em #eng");
    const link = within(row).getByRole("link", { name: "Ver" });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });

  test("outside the agent's view: only someone on the team, and no link", async () => {
    await open([check({ agentId: null, agentName: null, channelId: null, channelName: null, summary: null })]);
    const row = group().querySelector(".ag-rc") as HTMLElement;
    expect(row.textContent).toContain("Não repeti: alguém do time já tinha feito isso com acme/app@fix/login");
    expect(within(row).queryByRole("link")).toBeNull();
  });

  test("nothing held: no group", async () => {
    await open([]);
    expect(within(article()).queryByRole("group", { name: "O que o agente não repetiu" })).toBeNull();
  });
});
