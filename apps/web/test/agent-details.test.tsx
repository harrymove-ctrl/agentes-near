import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** I (Walter) am a member; Ada answers only João, her owner: I see her public card. */
const outside = () => {
  const state = seedState();
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) {
    ada.ownerUserId = "u-joao";
    ada.audience = { mode: "owner", userIds: [] };
    ada.instructions = "Os preços da tabela 4 são confidenciais.";
    ada.seesDetails = false;
  }
  return state;
};

describe("an agent seen from outside its audience", () => {
  test("its page is the public card: who answers for it, who it answers, where it works, a way to ask", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(outside()) });
    await settle(8);
    expect(screen().queryByRole("tablist")).toBeNull();
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("tabela 4");
    expect(document.body.textContent).toContain("João");
    const ask = screen().getByRole("link", { name: "Pedir acesso" });
    expect(ask.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/person/u-joao`);
  });

  test("Equipe's map card leaves out what it does and opens its public card, which offers to ask for access", async () => {
    await renderApp(`/org/${ORG_ID}/team`, { api: createFakeApi(outside()) });
    await settle(4);
    await act(async () => fireEvent.click(screen().getByRole("radio", { name: "Mapa" })));
    await settle(2);
    const link = screen().getAllByRole("link", { name: /^Ada/ })[0];
    const card = link?.closest(".team-map__card");
    expect(card).toBeTruthy();
    expect(card?.textContent).not.toContain("tabela 4");
    expect(card?.querySelector(".team-map__does")).toBeNull();
    expect(link?.getAttribute("href")).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
  });
});

describe("an agent that doesn't answer an admin", () => {
  /** I (Walter) own the workspace; Ada is João's, kept to the Suporte role I don't hold. */
  const keptOut = () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.ownerUserId = "u-joao";
      ada.audience = { mode: "people", userIds: [], roleIds: ["r-suporte"] };
      ada.canTalk = false;
      ada.seesDetails = true;
    }
    return state;
  };

  test("its conversation opens, says why the composer is off, and lets me in", async () => {
    const state = keptOut();
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const allow = screen().getByRole("button", { name: /Quero falar com/ });
    await act(async () => fireEvent.click(allow));
    await settle(2);
    const update = state.calls.find((c) => c.method === "agents.update");
    expect(update?.args[2]).toEqual({
      audience: { mode: "people", userIds: ["u-walter"], roleIds: ["r-suporte"] },
      mailLossSeen: [],
    });
  });

  test("letting me in when she holds João's mailbox asks first, naming whose access goes, and Cancel keeps it", async () => {
    const state = keptOut();
    state.mailLoss = {
      [ADA_ID]: [{ accountId: "mb-joao", address: "joao@acme.com", ownerUserId: "u-joao", ownerName: "João" }],
    };
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const allow = screen().getByRole("button", { name: /Quero falar com/ });
    await act(async () => fireEvent.click(allow));
    await settle(2);
    const ask = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    expect(ask.textContent).toContain("Ada tem acesso à caixa de email de João.");
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Cancelar" })));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.some((c) => c.method === "agents.update")).toBe(false);

    await act(async () => fireEvent.click(allow));
    await settle(2);
    const again = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Continuar" })));
    await settle(2);
    expect(state.calls.filter((c) => c.method === "agents.update")).toHaveLength(1);
  });

  test("a mailbox given while I'm asked: the save is refused and I'm asked again, naming both", async () => {
    const state = keptOut();
    const box = (id: string, ownerName: string) => ({
      accountId: id,
      address: `${id}@acme.com`,
      ownerUserId: `u-${id}`,
      ownerName,
    });
    state.mailLoss = { [ADA_ID]: [box("joao", "João")] };
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Quero falar com/ })));
    await settle(2);
    state.mailLoss = { [ADA_ID]: [box("joao", "João"), box("bia", "Bia")] };
    const ask = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Continuar" })));
    await settle(4);
    const again = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    expect(again.textContent).toContain("de João e Bia.");
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Continuar" })));
    await settle(2);
    const updates = state.calls.filter((c) => c.method === "agents.update");
    expect(updates.map((c) => (c.args[2] as { mailLossSeen?: string[] }).mailLossSeen)).toEqual([
      ["joao"],
      ["joao", "bia"],
    ]);
    expect(state.agents.find((a) => a.id === ADA_ID)?.audience?.userIds).toContain("u-walter");
  });

  test("on João's Claude plan one question says it uses his plan and he gets an email, and the mailbox it loses", async () => {
    const state = keptOut();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "claude_code", account: "Claude Max" } as NonNullable<typeof ada.brain>;
    state.mailLoss = {
      [ADA_ID]: [{ accountId: "mb-joao", address: "joao@acme.com", ownerUserId: "u-joao", ownerName: "João" }],
    };
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Quero falar com/ })));
    await settle(2);
    const ask = screen().getByRole("dialog", { name: "Usar o plano de João?" });
    expect(ask.textContent).toContain(
      "As conversas com Ada vão usar o plano do Claude de João e os limites dele. João vai receber um email avisando.",
    );
    expect(ask.textContent).toContain("Ada tem acesso à caixa de email de João.");
    expect(state.calls.some((c) => c.method === "agents.update")).toBe(false);
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Continuar" })));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.filter((c) => c.method === "agents.update")).toHaveLength(1);
  });
});
