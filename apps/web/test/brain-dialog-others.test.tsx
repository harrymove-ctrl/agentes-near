import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { brainDialog, brainRows, brainScreen, mainButton, pickRow, toScreen } from "./ai-picker";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { shownText } from "./hint";
import { renderApp, settle } from "./render";

/*
 * "Quem pensa" with other people's agents and accounts (ADR 0032 §5, addendum 2026-11-10; ADR 0059 §3): an admin on
 * someone else's agent picks among that owner's accounts and the workspace's keys, never signs one in there; switching
 * everyone on an account moves each agent by the server's own rules, and one it refuses is named.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

const account = (patch: Partial<MachineAccount> & Pick<MachineAccount, "id" | "label">): MachineAccount => ({
  kind: "claude_code",
  email: `${patch.id}@acme.com`,
  plan: "max",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  ...patch,
});

/** Ada on the MacBook, thinking with `view`'s account; `owner`: who owns Ada and Atlas. */
async function ada(view: Partial<AgentBrain>, owner = "u-walter") {
  const state = seedState();
  for (const a of state.agents)
    if (a.id === ADA_ID || a.id === ATLAS_ID) {
      a.ownerUserId = owner;
      a.brain = { kind: "claude_code", model: "Sonnet", account: "Claude Max" };
    }
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook", os: "darwin" });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
  const brain = fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", onlyOwner: true, ...view });
  api.agents.brain = async (_orgId, agentId) => structuredClone({ ...brain, agentId });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api };
}

describe("an admin on someone else's agent", () => {
  test("picks among the owner's accounts it may use and the keys; locked ones stay off, nothing to sign in or connect", async () => {
    const theirs = account({
      id: "acct_joao",
      label: "Claude Max",
      ownerId: "u-joao",
      ownerName: "João Silva",
      mine: false,
      usedBy: ["Ada"],
    });
    const other = account({
      id: "acct_joao2",
      label: "Claude Pro",
      ownerId: "u-joao",
      ownerName: "João Silva",
      mine: false,
    });
    const admin = { canUsePlans: false, canManageAccounts: false, ownSignIn: false };
    await ada({ account: "acct_joao", accounts: [theirs, other], ...admin }, "u-joao");
    const d = await brainDialog("Quem pensa pela Ada");
    // Whose accounts these are, said on the first screen.
    expect(shownText(d)).toContain("Só contas de João");
    await toScreen(d, "Trocar de conta");
    // The one in use; the workspace's key, the admin's to pick, picked; João's other account is his to give: shown
    // under his name, not to be picked.
    expect(brainRows(d).map((r) => [r.group, r.title, r.checked, r.off])).toEqual([
      ["Em uso", "Claude Max", false, false],
      ["Chave do workspace", "Chave padrão do workspace", true, false],
      ["De João", "Claude Pro · Max", false, true],
    ]);
    expect(mainButton(d)?.textContent).toBe("Trocar para Chave padrão do workspace");
    // No sign-in here and no other AI to connect: those are the owner's (ADR 0160, addendum).
    expect(within(d).queryByRole("button", { name: /^Conectar outra IA/ })).toBeNull();
    expect(within(d).queryByRole("button", { name: /^Entrar/ })).toBeNull();
  });
});

describe("Todos nesta conta", () => {
  test("each agent on the account moves by the server's rules; one it refuses keeps its account and is named", async () => {
    const shared = account({
      id: "acct_team",
      label: "Claude Max",
      shared: true,
      usedBy: ["Ada", "Atlas"],
      usedByIds: [ADA_ID, ATLAS_ID],
    });
    const next = account({ id: "acct_next", label: "Claude Team", email: "next@acme.com", plan: "team", shared: true });
    const { state, api } = await ada({ account: "acct_team", accounts: [shared, next] });
    const setBrain = api.agents.setBrain;
    const asked: unknown[] = [];
    api.agents.setBrain = async (orgId, agentId, input) => {
      if (agentId !== ATLAS_ID) return setBrain(orgId, agentId, input);
      asked.push(input);
      throw new ApiError(409, "agent.brain_refused", "Not on this account");
    };
    const d = await brainDialog("Quem pensa pela Ada");
    await toScreen(d, "Trocar de conta");
    await pickRow(d, "Claude Team");
    await click(within(d).getByRole("button", { name: "Trocar para Claude Team" }));
    // The account thinks for both: whom the switch is for, everyone by default.
    expect(brainScreen(d)).toBe("Trocar a conta do time");
    const cards = within(d).getByRole("group", { name: "Para quem é" });
    expect(
      within(cards)
        .getByRole("button", { name: /^Todos nesta conta/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await click(within(d).getByRole("button", { name: "Trocar os 2 agentes" }));
    await settle(6);
    // Ada moved; Atlas was asked for the account alone (the model it has stays its own) and refused.
    expect(state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID]);
    expect(asked).toEqual([{ brain: "claude_code", account: "acct_next" }]);
    expect(brainScreen(d)).toBe("Pronto");
    expect(shownText(d)).toContain("Atlas ficou com a conta de antes.");
  });
});
