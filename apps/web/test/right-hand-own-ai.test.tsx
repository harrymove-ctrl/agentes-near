import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeAgentBrain, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * ADR 0137 §11: "Sua IA" is every person's, the workspace's AI is the admins', and every row of Lodi's settings has the
 * same structure. Its page opens docked beside its conversation, like a thread, with nothing dimmed.
 */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const planOf = (ownerId: string | undefined) =>
  ({
    id: "acc-ana",
    kind: "claude_code",
    label: "Trabalho",
    ownerId,
    mine: true,
    status: "active",
    shared: true,
    usedBy: [],
  }) as never;

const groups = () => [...document.querySelectorAll(".rh-group .ac-grouphead__title")].map((h) => h.textContent);
const row = (name: RegExp) => screen().getByRole("button", { name });

test("Lodi's old settings address opens Lodi's page: two groups, the face opens the look, the fallback AI is one row that opens", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "claude_code", model: "Sonnet" } });
  const api = createFakeApi(state);
  let onPlan = true;
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: onPlan ? "claude_code" : "model",
      ...(onPlan ? { account: "acc-ana" } : {}),
      accounts: [planOf(state.me?.user.id)],
      onlyOwner: true,
      canUsePlans: true,
      canEdit: true,
      workspaceAi: {
        brain: "model",
        ownerId: null,
        servesYou: true,
        key: { provider: "openai", label: "OpenAI da Acme" },
      },
    });
  const sent: unknown[] = [];
  api.agents.setBrain = async (_org, id, input) => {
    sent.push(input);
    onPlan = false;
    const lodi = state.agents.find((a) => a.id === id);
    if (lodi) lodi.brain = undefined;
    return fakeAgentBrain(id);
  };
  const { router } = await renderApp(`/org/${ORG_ID}/settings/right_hand`, { api });
  await settle(8);
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${LODI_ID}`);
  expect(groups()).toEqual(["Só para você", "Para todo o workspace· só admins"]);
  expect(screen().queryByRole("button", { name: "Mudar visual" })).toBeNull();
  // The weekly card's button stands on a plate like the selects beside it: wrapped under them on a phone, it starts
  // on their edge, never a padding further in as bare words would.
  expect(screen().getByRole("button", { name: "Parar de receber" }).classList.contains("ac-btn--ghost")).toBe(false);
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Mudar o visual do Lodi" })));
  await settle(4);
  expect(screen().getByRole("dialog", { name: "Mudar visual" })).toBeTruthy();
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Cancelar" })));
  await settle(2);
  // The value is under the row's name, the chevron at its end: no button of its own, nothing floating right.
  const ai = row(/^IA de quem não tem plano próprio/);
  expect(ai.matches(".settings-row--open")).toBe(true);
  expect(ai.querySelector(".settings-row__status")?.textContent).toBe("Plano Trabalho");
  expect(ai.querySelector(".settings-row__status .ac-provider-logo, .settings-row__status svg")).toBeTruthy();
  expect(ai.querySelector(".settings-row__chevron")).toBeTruthy();
  expect(ai.querySelector(".settings-row__value")).toBeNull();
  expect(screen().queryByRole("button", { name: "Usar uma chave de API" })).toBeNull();
  // The switch says what it does once: its state is the switch.
  const lend = screen().getByRole("switch", { name: "Emprestar este plano a quem não tem um" });
  const lendRow = lend.closest(".settings-row") as HTMLElement;
  expect(lendRow.querySelector(".settings-row__status")).toBeNull();
  // The plan's terms on lending it stay one press away, beside the name.
  expect(within(lendRow).getByRole("button", { name: "Sobre Emprestar este plano a quem não tem um" })).toBeTruthy();
  // The row opens the choice in place, and choosing there changes the row.
  await act(async () => fireEvent.click(ai));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "IA de quem não tem plano próprio" });
  const choices = within(dialog).getAllByRole("radio");
  expect(choices.map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  expect(choices[1]?.textContent).toContain("Plano Trabalho");
  await act(async () => fireEvent.click(choices[0] as HTMLElement));
  await settle(8);
  expect(sent).toEqual([{ scope: "workspace", brain: "model" }]);
  // The dialog stays for the key's model. Closed, the row behind it says the new value.
  expect(within(dialog).getAllByRole("radio")[0]?.getAttribute("aria-checked")).toBe("true");
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" })));
  await settle(4);
  expect(row(/^IA de quem não tem plano próprio/).querySelector(".settings-row__status")?.textContent).toBe(
    "OpenAI da Acme",
  );
  expect(screen().queryByRole("switch", { name: "Emprestar este plano a quem não tem um" })).toBeNull();
});

test("a member's Lodi page is only Só para você: Sua IA is one row that opens, and connects their plan from its dialog", async () => {
  const state = withRightHand(seedState());
  const me = state.me?.organizations[0];
  if (me) me.role = "member";
  const api = createFakeApi(state);
  api.agents.brain = async (_org, id) =>
    fakeAgentBrain(id, {
      scope: "mine",
      brain: "model",
      accounts: [],
      canUsePlans: true,
      workspaceAi: { brain: "claude_code", ownerId: "u-ana", servesYou: false },
    });
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  expect(groups()).toEqual(["Só para você"]);
  expect(screen().queryByText("Nome e visual")).toBeNull();
  expect(screen().queryByText("Quem pode usar")).toBeNull();
  const mine = row(/^Sua IA/);
  expect(mine.querySelector(".settings-row__status")?.textContent).toBe("Ninguém te responde aqui ainda");
  expect(screen().queryByRole("button", { name: "Conectar meu plano" })).toBeNull();
  await act(async () => fireEvent.click(mine));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Sua IA" });
  // Why it is theirs alone: the dialog's sentence.
  expect(dialog.textContent).toContain("Sua conversa com o Lodi pensa com um plano seu");
  await act(async () => fireEvent.click(within(dialog).getByRole("radio", { name: /Conectar meu plano/ })));
  await settle(6);
  expect(screen().queryByRole("dialog", { name: "Sua IA" })).toBeNull();
  expect(screen().getByRole("dialog", { name: /Lodi/ })).toBeTruthy();
});

test("Sua IA on a plan of mine: the dialog goes back to the workspace's AI, and the row says so", async () => {
  const state = withRightHand(seedState());
  const api = createFakeApi(state);
  const key = { provider: "openai", label: "OpenAI da Acme" };
  let own = true;
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: own && scope !== "workspace" ? "claude_code" : "model",
      ...(own && scope !== "workspace" ? { account: "acc-ana" } : {}),
      accounts: [planOf(state.me?.user.id)],
      canUsePlans: true,
      workspaceAi: { brain: "model", ownerId: null, servesYou: true, key },
    });
  const sent: unknown[] = [];
  api.agents.setBrain = async (_org, id, input) => {
    sent.push(input);
    own = false;
    return fakeAgentBrain(id);
  };
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  expect(row(/^Sua IA/).querySelector(".settings-row__status")?.textContent).toBe("Trabalho · seu plano");
  await act(async () => fireEvent.click(row(/^Sua IA/)));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Sua IA" });
  // Every way out is a choice of the list, the plan in use checked: no button stands loose among them.
  expect(
    within(dialog)
      .getAllByRole("radio")
      .map((r) => [r.textContent, r.getAttribute("aria-checked")]),
  ).toEqual([
    ["Trabalhoseu plano", "true"],
    ["Conectar outro plano", "false"],
    ["Usar a do workspace", "false"],
  ]);
  expect(within(dialog).queryByRole("button", { name: "Mudar" })).toBeNull();
  await act(async () => fireEvent.click(within(dialog).getByRole("radio", { name: /Usar a do workspace/ })));
  await settle(8);
  expect(sent).toEqual([{ scope: "mine", brain: "model" }]);
  expect(screen().queryByRole("dialog", { name: "Sua IA" })).toBeNull();
  expect(row(/^Sua IA/).querySelector(".settings-row__status")?.textContent).toBe(
    "OpenAI da Acme · chave do workspace",
  );
});

test("the worst case keeps its shape: a very long account and owner name stay under the row's name, whole", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "claude_code", model: "Sonnet" } });
  const long = "Assinatura corporativa compartilhada do time de operações e atendimento da América Latina";
  const owner = state.members.find((m) => m.userId !== state.me?.user.id);
  if (owner) owner.name = "Maximiliana-Bernardette Albuquerque";
  const api = createFakeApi(state);
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: "claude_code",
      account: "acc-ana",
      accounts: [{ ...(planOf(owner?.userId) as object), label: long, mine: false } as never],
      onlyOwner: false,
      canUsePlans: true,
      canEdit: true,
    });
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  const ai = row(/^IA de quem não tem plano próprio/);
  const value = ai.querySelector(".settings-row__status .rh-value") as HTMLElement;
  expect(value.textContent).toBe(`Plano ${long} · conta de Maximiliana-Bernardette`);
  // Under the name, in the words' column: never a second column squeezing the name, never cut.
  expect(value.closest(".settings-row__text")).toBeTruthy();
  const css = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
  const rule = css.split("\n.rh-value {")[1]?.split("}")[0] ?? "";
  expect(rule).toContain("overflow-wrap: anywhere");
  expect(rule).not.toMatch(/ellipsis|nowrap/);
});

test("Quem pode usar sits one card gap under its head, with no margin of its own", async () => {
  const state = withRightHand(seedState());
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const card = document.getElementById("rh-audience")?.closest(".ac-card") as HTMLElement;
  expect(card.querySelector(".ac-card__head")?.nextElementSibling?.querySelector('[role="radiogroup"]')).toBeTruthy();
  expect(await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text()).not.toContain(
    "rh-set__audience",
  );
});

describe("the agent's page beside its conversation", () => {
  const openPanel = async () => {
    const state = withRightHand(seedState());
    seedDm(state, { type: "agent", id: LODI_ID });
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const opener = document.querySelector(".dm-who__hit") as HTMLElement;
    opener.focus();
    await act(async () => fireEvent.click(opener));
    await settle(6);
    return opener;
  };
  const panel = () => document.querySelector(".thread-panel--wide") as HTMLElement | null;

  test("floats over a scrim, takes the focus, and gives it back on Esc", async () => {
    const opener = await openPanel();
    const side = panel() as HTMLElement;
    expect(side.previousElementSibling?.classList.contains("thread-panel__scrim")).toBe(true);
    expect(side.contains(document.activeElement)).toBe(true);
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    await act(async () => fireEvent.keyDown(side, { key: "Escape" }));
    await settle(3);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("its × and its opener again close it", async () => {
    const opener = await openPanel();
    await act(async () =>
      fireEvent.click(within(panel() as HTMLElement).getAllByRole("button", { name: "Fechar" })[0] as HTMLElement),
    );
    await settle(3);
    expect(panel()).toBeNull();
    await act(async () => fireEvent.click(opener));
    await settle(4);
    expect(panel()).toBeTruthy();
    await act(async () => fireEvent.click(opener));
    await settle(4);
    expect(panel()).toBeNull();
  });
});
