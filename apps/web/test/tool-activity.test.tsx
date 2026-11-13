import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { LiveWork, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { LiveTools } from "@/components/ToolCalls";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const SECRET_ID = "00000000-0000-4000-8000-0000000000e7";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** An agent's reply that ran code and opened a task, then its secret request card. */
function messages(): Message[] {
  return [
    {
      id: "m-work",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "O que você queria ver nessa lista?",
      mentionedAgentIds: [],
      agentRunId: "r-work",
      createdAt: ago(120_000),
      meta: {
        work: { steps: 2, calls: [{ name: "run_code" }, { name: "create_issue" }], durationMs: 5000 },
        browser: {
          steps: [
            { tool: "browser_open", detail: "example.com/usage", at: ago(125_000), failed: false },
            { tool: "browser_click", detail: null, at: ago(124_000), failed: false },
          ],
        },
        desktop: { steps: [{ tool: "desktop_open", detail: "Terminal", at: ago(123_000), failed: false }] },
      },
    },
    {
      id: "m-secret",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Ada asked for a key: BILLING_API_KEY",
      mentionedAgentIds: [],
      agentRunId: "r-secret",
      createdAt: ago(60_000),
      meta: {
        bodyCode: "secret_request",
        bodyParams: { agent: "Ada", name: "BILLING_API_KEY" },
        secretRequestId: SECRET_ID,
        secretRequest: {
          id: SECRET_ID,
          agentId: ADA_ID,
          channelId: ENG_ID,
          threadId: null,
          messageId: "m-secret",
          requestedForUserId: "u-walter",
          name: "BILLING_API_KEY",
          purpose: "ler o uso da conta",
          target: { kind: "env" },
          machineId: null,
          publicKey: "pk",
          status: "pending",
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          deliveredAt: null,
          removed: false,
        },
      },
    },
  ] as Message[];
}

async function openChannel(showActivity: boolean | undefined) {
  const state = seedState();
  const org = state.me?.organizations[0];
  if (org) org.showActivity = showActivity;
  state.messages = messages();
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  await act(async () => r.sockets.last().open());
  await settle(2);
  return { ...r, state };
}

let finish: () => void = () => {};
function Live({ work }: { work: LiveWork[] }) {
  const [done, setDone] = useState(false);
  finish = () => setDone(true);
  return <LiveTools work={work} agentName="Ada" done={done} />;
}

describe("what agents did under each reply (a person's own setting, off by default)", () => {
  test("off: no tool block under the reply, its words and the secret request card stay, with no raw line", async () => {
    await openChannel(undefined);
    expect(screen().getByText("O que você queria ver nessa lista?")).toBeTruthy();
    expect(document.querySelector(".ac-tools")).toBeNull();
    expect(document.body.textContent).not.toContain("Usou 2 ferramentas");
    // Where it browsed and what it did on its desktop are step summaries (no picture): activity too.
    expect(document.querySelectorAll(".brw-trail").length).toBe(0);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(card.textContent).toContain("ler o uso da conta");
    expect(card.textContent).not.toContain("BILLING_API_KEY");
    // The card alone speaks: its fallback sentence is for previews and notifications.
    expect(document.body.textContent).not.toContain("pediu uma chave");
    expect(document.body.textContent).not.toContain("asked for a key");
  });

  test("on: the reply shows its tools, the secret request still without its raw line", async () => {
    await openChannel(true);
    expect(document.querySelector(".ac-tools")?.textContent).toContain("Usou 2 ferramentas");
    expect(document.querySelectorAll(".brw-trail").length).toBe(2);
    expect(screen().getByRole("group", { name: "Pedido de segredo de Ada" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("pediu uma chave");
  });

  test("off: the live step line still shows while the agent works, and goes once it's done", async () => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.showActivity = false;
    const work = [
      { kind: "call", id: "1", tool: "run_code", connector: null, detail: null, code: null, output: [], running: true },
    ] as unknown as LiveWork[];
    await renderPage(<Live work={work} />, { api: createFakeApi(state), org: true });
    expect(document.querySelector(".ac-tools")).not.toBeNull();
    await act(async () => finish());
    await settle(2);
    expect(document.querySelector(".ac-tools")).toBeNull();
  });

  test("Sua conta has the switch: it starts off and turns it on for this workspace", async () => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.showActivity = false;
    await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state) });
    await settle(8);
    const toggle = screen().getByRole("switch", { name: "Mostrar o que os agentes fizeram em cada resposta" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(toggle));
    await settle(4);
    expect(state.calls.some((c) => c.method === "orgs.setShowActivity" && c.args[1] === true)).toBe(true);
    expect(org?.showActivity).toBe(true);
    expect(
      within(document.body)
        .getByRole("switch", { name: "Mostrar o que os agentes fizeram em cada resposta" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

test("Sua conta: a save that fails puts the switch back and says so", async () => {
  const state = seedState();
  const org = state.me?.organizations[0];
  if (org) org.showActivity = false;
  const api = createFakeApi(state);
  api.orgs.setShowActivity = async () => {
    throw new Error("offline");
  };
  await renderApp(`/org/${ORG_ID}/settings/account`, { api });
  await settle(8);
  const name = "Mostrar o que os agentes fizeram em cada resposta";
  await act(async () => fireEvent.click(screen().getByRole("switch", { name })));
  await settle(4);
  expect(screen().getByRole("switch", { name }).getAttribute("aria-checked")).toBe("false");
  expect(document.body.textContent).toContain("Não deu para salvar. Tente de novo.");
});
