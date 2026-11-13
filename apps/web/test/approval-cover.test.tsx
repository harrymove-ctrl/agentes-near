import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { decisionOutcome } from "@agenteschat/client/lib/approval-words";
import { resources } from "@agenteschat/i18n";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import i18next from "i18next";
import { createFakeApi, type FakeState, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (state: FakeState = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/settings/approvals`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const section = () => within(document.querySelector(".settings__body") as HTMLElement);
const pick = async (select: string, option: string) => {
  const trigger = section().getByRole("combobox", { name: select });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
};
const last = (state: FakeState, method: string) => state.calls.findLast((c) => c.method === method)?.args;
const joao = (state: FakeState) => state.members.find((m) => m.userId === "u-joao")?.name ?? "";

describe("Configurações › Você › Aprovações (ADR 0139)", () => {
  test("Quem aprova por mim: one person, then when, until and risky actions, each saved at once", async () => {
    const { state } = await go();
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    // A tab of Sua conta: the list marks the entry, the strip the section.
    expect(within(nav).getByRole("link", { name: "Sua conta" }).getAttribute("aria-current")).toBe("page");
    expect(screen().getByRole("tab", { name: "Aprovações" }).getAttribute("aria-selected")).toBe("true");
    expect(section().getByRole("region", { name: "Quem aprova por mim" })).toBeTruthy();
    // No one yet: only the person to pick, and what never leaves you.
    expect(section().queryByRole("switch", { name: "Merge, deploy e outras ações de risco" })).toBeNull();
    expect(section().getByText(/Sempre com você: dinheiro/)).toBeTruthy();

    await pick("Pessoa", joao(state));
    expect(last(state, "approvals.setCover")).toEqual([
      ORG_ID,
      { userId: "u-joao", mode: "while_out", risky: false, endsAt: null },
    ]);
    expect(section().getByText("Essa pessoa decide essas também.")).toBeTruthy();
    await click(section().getByRole("switch", { name: "Merge, deploy e outras ações de risco" }));
    expect(last(state, "approvals.setCover")?.[1]).toMatchObject({ userId: "u-joao", risky: true });
    await pick("Quando", "Sempre");
    expect(last(state, "approvals.setCover")?.[1]).toMatchObject({ mode: "always", risky: true });

    await pick("Pessoa", "Ninguém");
    expect(last(state, "approvals.endCover")).toEqual([ORG_ID, state.me?.user.id]);
  });

  test("whom I approve for, with Não quero cobrir", async () => {
    const state = seedState();
    state.approvalCovers = {
      cover: null,
      covering: [{ userId: "u-joao", mode: "always", risky: false, endsAt: null, active: true }],
    };
    await go(state);
    const card = section().getByRole("region", { name: "Você aprova por" });
    expect(within(card).getByText("Sempre · Cobrindo agora")).toBeTruthy();
    await click(within(card).getByRole("button", { name: "Não quero cobrir" }));
    expect(last(state, "approvals.endCover")).toEqual([ORG_ID, "u-joao"]);
    expect(section().queryByRole("region", { name: "Você aprova por" })).toBeNull();
  });

  test("what Lodi does for me is on Lodi's page: one row here opens it", async () => {
    const { router } = await go(withRightHand(seedState()));
    expect(section().queryByRole("switch", { name: /Lodi/ })).toBeNull();
    await click(section().getByRole("button", { name: "Lodi cria e ajusta agentes por você" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${LODI_ID}`);
  });

  test("alone in a personal workspace nobody can approve for you: no Quem aprova por mim, unless one is set (ADR 0159)", async () => {
    const personal = (alone: boolean) => {
      const state = seedState();
      const org = state.me?.organizations[0];
      if (org) org.mode = "personal";
      if (alone) state.members = state.members.filter((m) => m.userId === state.me?.user.id);
      return state;
    };
    await go(personal(true));
    expect(section().queryByRole("region", { name: "Quem aprova por mim" })).toBeNull();
    cleanup();
    // A cover set before stays in sight, to change or end it.
    const set = personal(true);
    set.approvalCovers = {
      cover: { userId: "u-joao", mode: "always", risky: false, endsAt: null, active: true },
      covering: [],
    };
    await go(set);
    expect(section().getByRole("region", { name: "Quem aprova por mim" })).toBeTruthy();
    cleanup();
    await go(personal(false));
    expect(section().getByRole("region", { name: "Quem aprova por mim" })).toBeTruthy();
  });

  test("a decided card says who decided, covering whom", () => {
    const i18n = i18next.createInstance();
    void i18n.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
    const t = i18n.t;
    const names: Record<string, string> = { b: "Bruno", a: "Ana" };
    const name = (id: string) => names[id];
    const approved = { status: "approved" as const, decidedByUserId: "b", decidedForUserId: "a" };
    expect(decisionOutcome(t, approved, "x", name)).toBe("Aprovado por Bruno, cobrindo Ana");
    expect(decisionOutcome(t, approved, "a", name)).toBe("Aprovado por Bruno, cobrindo você");
    expect(decisionOutcome(t, { ...approved, status: "refused" }, "b", name)).toBe("Recusado por você, cobrindo Ana");
  });
});
