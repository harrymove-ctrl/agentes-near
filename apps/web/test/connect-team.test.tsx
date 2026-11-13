import { afterEach, describe, expect, test } from "bun:test";
import type { Agent, AiComputer, MachineAccount } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { LOGIN_PER_AGENT } from "@agenteschat/client/lib/plans";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeMachinesOf, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/*
 * Connect for the whole team (ADR 0160, addendum "For the whole team"): who it is for when the right hand is named
 * first, and what the end says (who woke across rounds, why each one stayed, what they think with, whom they answer).
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};

const LIA_ID = "00000000-0000-4000-8000-0000000000a3";

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};

/** A Claude plan's account as the computer reports it once a sign-in ends. */
const max = (n: number, over: Partial<MachineAccount> = {}): MachineAccount => ({
  id: `acct_${n}`,
  kind: "claude_code",
  label: "Claude Max",
  email: "walt@acme.com",
  plan: "max",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  ...over,
});

/** The sign-in window: the page opens it on the click, then sends it to the provider's page. */
async function withPopup(run: () => Promise<void>) {
  const realOpen = window.open;
  const popup = {
    closed: false,
    opener: {},
    location: {
      href: "",
      replace(url: string) {
        this.href = url;
      },
    },
    close: () => {},
  };
  window.open = (() => popup) as unknown as typeof window.open;
  try {
    await run();
  } finally {
    window.open = realOpen;
  }
}

/**
 * Settings › AI accounts with Ada, Atlas and Lia, all Walter's and none with an AI: Ada and Atlas on the MacBook, Lia
 * there too or on another computer (`liaElsewhere`). `hand`: the team's right hand too, listed first as the onboarding
 * and the first-run list name it. `ready`: agents that already think. "Conectar uma IA" opened.
 */
async function team({
  hand = false,
  liaElsewhere = false,
  ready = [],
}: {
  hand?: boolean;
  liaElsewhere?: boolean;
  ready?: string[];
} = {}) {
  const state = seedState();
  const ada = state.agents[0];
  if (ada) state.agents.push({ ...ada, id: LIA_ID, name: "Lia", handle: "lia" });
  if (hand) {
    withRightHand(state);
    state.agents.unshift(state.agents.pop() as Agent);
  }
  for (const a of state.agents) a.ownerUserId = "u-walter";
  state.aiStatus = {
    any: ready.length > 0,
    agents: state.agents.map((a) =>
      ready.includes(a.id)
        ? { agentId: a.id, state: "ready" as const }
        : { agentId: a.id, state: "no_ai" as const, reason: "no_key" as const },
    ),
  };
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  const row = (id: string) => {
    const a = state.agents.find((x) => x.id === id);
    return { id, name: a?.name ?? "", handle: a?.handle ?? "" };
  };
  machines?.pair({
    id: "machine_1",
    name: "MacBook",
    agents: [row(ADA_ID), row(ATLAS_ID), ...(liaElsewhere ? [] : [row(LIA_ID)])],
  });
  if (liaElsewhere) machines?.pair({ id: "machine_2", name: "Mini", agents: [row(LIA_ID)] });
  machines?.setAiAccounts({ accounts: [], computers: [MAC] });
  const viewOf = api.agents.brain;
  api.agents.brain = async (orgId, agentId) => ({ ...(await viewOf(orgId, agentId)), ownSignIn: false });
  const { services } = await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
  await settle(6);
  await click(screen().getByRole("button", { name: "Conectar uma IA" }));
  await settle(4);
  return { state, machines, services, dialog: screen().getByRole("dialog") };
}

const inBand = (dialog: HTMLElement) => dialog.querySelector(".arrival-hero") !== null;
const facesOf = (inside: HTMLElement) =>
  [...inside.querySelectorAll(".ai-strip__face")].map((li) => li.getAttribute("data-state"));
const faceNames = (inside: HTMLElement) =>
  [...inside.querySelectorAll(".ai-strip__face")].map((li) => li.getAttribute("title"));
const calls = (state: ReturnType<typeof seedState>, method: string) => state.calls.filter((c) => c.method === method);

async function pickPlan(dialog: HTMLElement, name: string) {
  const card = () => within(dialog).queryByRole("button", { name: new RegExp(`^${name}`) });
  if (!card()) await click(within(dialog).getByRole("button", { name: /^Outro plano/ }));
  await click(card() as HTMLElement);
  await settle(4);
}

const signIn = async (dialog: HTMLElement, name = "Entrar no Claude") => {
  await withPopup(() => click(within(dialog).getByRole("button", { name })));
  await settle(8);
};

describe("whom it is for: the right hand never picks the computer", () => {
  test("named first, the right hand wakes with the team; the computer is the first other agent's, another one's agent stays out", async () => {
    const { state, machines, services, dialog } = await team({ hand: true, liaElsewhere: true });
    expect(inBand(dialog)).toBe(true);
    // Ada and Atlas on the MacBook, and the right hand; Lia, on another computer, isn't among them.
    const line = dialog.querySelector(".arrival-forline") as HTMLElement;
    expect(shownText(line)).toBe("3 agentes sem IAEscolher");
    for (const n of [1, 2]) machines?.endLogin(`login_${n}`, { state: "done", account: max(n) });
    await pickPlan(dialog, "Claude");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    // The plan signs in for the others, never for the right hand, and the first of them leads.
    expect(faceNames(panel)).toEqual(["Ada", "Atlas"]);
    expect(shownText(panel)).toContain("1 de 2");
    expect(shownText(panel)).toContain("Entre no Claude para a Ada");
    await signIn(dialog);
    await signIn(dialog);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args[1])).toEqual(["machine_1", "machine_1"]);
    expect(calls(state, "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID]);
    // The right hand is counted by its own AI status: still none, so it is named apart, with its own Connect.
    expect(shownText(dialog)).toContain("2 agentes acordaram");
    expect(shownText(dialog)).toMatch(/(O|A) Lodi ainda não tem IA para você\./);
    expect(facesOf(dialog)).toEqual(["done", "done", "failed"]);
    expect(within(dialog).getByRole("button", { name: /^Conectar (o|a) Lodi$/ })).toBeTruthy();
    // Once the status says it thinks (the person's own AI now serves it), the whole team is awake.
    state.aiStatus = {
      any: true,
      agents: (state.aiStatus?.agents ?? []).map((a) =>
        a.agentId === LODI_ID ? { agentId: LODI_ID, state: "ready" as const } : a,
      ),
    };
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
    await settle(6);
    expect(shownText(dialog)).toContain("O time acordou");
    expect(facesOf(dialog)).toEqual(["done", "done", "done"]);
  });

  test("the right hand left without an AI: its Connect opens the narrow dialog for it alone", async () => {
    const { machines, dialog } = await team({ hand: true });
    for (const n of [1, 2, 3]) machines?.endLogin(`login_${n}`, { state: "done", account: max(n) });
    await pickPlan(dialog, "Claude");
    for (const _ of [1, 2, 3]) await signIn(dialog);
    await click(within(dialog).getByRole("button", { name: /^Conectar (o|a) Lodi$/ }));
    await settle(4);
    const own = screen().getByRole("dialog", { name: /^Conectar uma IA para (o|a) Lodi$/ });
    expect(inBand(own)).toBe(true);
    expect(own.querySelector(".ai-picker")).toBeNull();
  });

  test("the right hand the only one to wake: one agent alone, the narrow dialog named for it", async () => {
    const { dialog } = await team({ hand: true, ready: [ADA_ID, ATLAS_ID, LIA_ID] });
    expect(inBand(dialog)).toBe(true);
    expect(dialog.querySelector(".ai-picker")).toBeNull();
    // Its own dialog, named for it, never the generic one over agents that already think.
    expect(screen().getByRole("dialog", { name: /^Conectar uma IA para (o|a) Lodi$/ })).toBe(dialog);
    expect(within(dialog).queryByRole("combobox", { name: "Agentes que usam este plano" })).toBeNull();
  });
});

describe("the arrival's Connect: the right hand never picks the computer either", () => {
  test("Claude's panel is for the agents on the MacBook, never the right hand listed first", async () => {
    const state = seedState();
    withRightHand(state);
    state.agents.unshift(state.agents.pop() as Agent);
    for (const a of state.agents) a.ownerUserId = "u-walter";
    state.aiStatus = {
      any: false,
      agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai" as const, reason: "no_key" as const })),
    };
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    const row = (id: string) => {
      const a = state.agents.find((x) => x.id === id);
      return { id, name: a?.name ?? "", handle: a?.handle ?? "" };
    };
    machines?.pair({ id: "machine_1", name: "MacBook", agents: [row(ADA_ID), row(ATLAS_ID)] });
    machines?.setAiAccounts({ accounts: [], computers: [MAC] });
    await renderApp(`/org/${ORG_ID}?arrival=1`, { api });
    await settle(6);
    await click(
      within(screen().getByRole("dialog", { name: "Você chegou cedo. Que bom." })).getByRole("button", {
        name: /Continuar/,
      }),
    );
    await settle(6);
    const dialog = screen().getByRole("dialog", { name: "Conecte uma IA para o seu time pensar" });
    await pickPlan(dialog, "Claude");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(shownText(panel)).not.toContain("Lodi");
    expect(shownText(panel)).toMatch(/Ada|Atlas|Todos os agentes/);
  });
});

describe("the end: who woke, why the others stayed, what they think with", () => {
  test("every agent passed over, the last one too: nobody woke, each one's reason, and Connect the 3", async () => {
    const { state, machines, dialog } = await team();
    for (const n of [1, 2, 3]) machines?.endLogin(`login_${n}`, { state: "failed" });
    await pickPlan(dialog, "Claude");
    for (const name of ["Pular a Ada", "Pular o Atlas", "Pular a Lia"]) {
      await signIn(dialog);
      await click(within(dialog).getByRole("button", { name }));
    }
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
    expect(shownText(dialog)).toContain("Ninguém acordou");
    expect(shownText(dialog)).toContain("Ada, Atlas e Lia ficaram sem IA: os logins não terminaram.");
    for (const name of ["Ada", "Atlas", "Lia"])
      expect(shownText(dialog)).toContain(`${name}: Não deu para entrar nessa conta. Tente de novo.`);
    expect(facesOf(dialog)).toEqual(["failed", "failed", "failed"]);
    // No dawn for nobody, and no audience line: nothing thinks yet.
    expect(dialog.querySelector(".ai-aud")).toBeNull();
    // An end, not a step: no way back to the steps, and the trail to the plan's mark no longer walks.
    expect(within(dialog).queryByRole("button", { name: "Voltar" })).toBeNull();
    expect(dialog.querySelector(".team-scene__trail")?.getAttribute("data-state")).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Conectar os 3" }));
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(shownText(panel)).toContain("1 de 3");
  });

  test("Connect Atlas: the end counts the whole team across the rounds, and says the account they think with", async () => {
    const { state, machines, dialog } = await team();
    machines?.endLogin("login_1", { state: "done", account: max(1) });
    machines?.endLogin("login_2", { state: "failed" });
    machines?.endLogin("login_3", { state: "done", account: max(3) });
    await pickPlan(dialog, "Claude");
    await signIn(dialog);
    await signIn(dialog);
    await click(within(dialog).getByRole("button", { name: "Pular o Atlas" }));
    await signIn(dialog);
    expect(shownText(dialog)).toContain("2 agentes acordaram");
    expect(shownText(dialog)).toContain("Eles já pensam com o seu Claude Max");
    expect(shownText(dialog)).toContain("Atlas: Não deu para entrar nessa conta. Tente de novo.");
    machines?.endLogin("login_4", { state: "done", account: max(4) });
    await click(within(dialog).getByRole("button", { name: "Conectar o Atlas" }));
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(8);
    expect(calls(state, "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID, LIA_ID, ATLAS_ID]);
    expect(shownText(dialog)).toContain("O time acordou");
    expect(shownText(dialog)).toContain("Eles já pensam com o seu Claude Max");
    expect(shownText(dialog)).not.toContain("Não deu para entrar");
    expect(facesOf(dialog)).toEqual(["done", "done", "done"]);
  });

  test("Choose one: Use this agent; it thinks with the account, and a Team seat's terms behind the audience's ⓘ", async () => {
    const { machines, dialog } = await team();
    machines?.endLogin("login_1", { state: "done", account: max(1, { label: "Claude Team", plan: "team" }) });
    await click(within(dialog).getByRole("button", { name: "Escolher" }));
    // The list is named as its title asks: whom it is for.
    const boxes = within(within(dialog).getByRole("group", { name: "Para quais agentes" })).getAllByRole("checkbox");
    await click(boxes[1] as HTMLElement);
    await click(boxes[2] as HTMLElement);
    await click(within(dialog).getByRole("button", { name: "Usar este agente" }));
    expect(shownText(dialog)).toContain("1 de 3 agentes sem IA");
    await pickPlan(dialog, "Claude");
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(8);
    expect(shownText(dialog)).toContain("A Ada já pensa com o seu Claude Team");
    expect(shownText(dialog)).toContain("1 agente acordou");
    expect(hintOf("os termos do plano", dialog).text).toContain("Cada assento do");
  });
});

describe("one login per agent, one instruction at a time", () => {
  test("ChatGPT's turn: the hidden sign-in step takes no number, so the code is step 2", async () => {
    const was = LOGIN_PER_AGENT.codex;
    (LOGIN_PER_AGENT as { codex: boolean }).codex = true;
    try {
      const { dialog } = await team();
      await pickPlan(dialog, "ChatGPT");
      const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
      await signIn(dialog, "Entrar no ChatGPT");
      expect([...panel.querySelectorAll(".agp-addacct__step > i")].map((i) => i.textContent)).toEqual(["1", "2"]);
    } finally {
      (LOGIN_PER_AGENT as { codex: boolean }).codex = was;
    }
  });
});

/** A stylesheet's text, its comments left out. */
const stylesheet = async (path: string) =>
  (await Bun.file(new URL(path, import.meta.url).pathname).text()).replace(/\/\*[\s\S]*?\*\//g, "");

/** The stylesheet with its `@media (…) {…}` blocks for `query` cut out, braces matched. */
const without = (css: string, query: string) => {
  let out = css;
  for (let at = out.indexOf(query); at !== -1; at = out.indexOf(query)) {
    let depth = 0;
    let end = out.indexOf("{", at);
    for (; end < out.length; end++) {
      if (out[end] === "{") depth++;
      else if (out[end] === "}" && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
  return out;
};

describe("the team dialog's styles", () => {
  test("screens slide only for whoever didn't ask for less motion", async () => {
    const css = await stylesheet("../src/components/arrival/arrival.css");
    expect(css).toContain(".arrival-swap");
    const still = without(css, "@media (prefers-reduced-motion: no-preference)");
    expect(still).not.toMatch(/\.arrival-swap[^{]*\{[^}]*animation/);
    expect(still).not.toMatch(/\.ai-strip__badge[^{]*\{[^}]*animation/);
  });

  test("a choice's title and its line sit as one block on the tile's middle, with what ends the card", async () => {
    const css = await stylesheet("../src/components/arrival/arrival.css");
    const rule = css.split(/\n\.arrival-opts \.ac-option \{/)[1]?.split("}")[0] ?? "";
    expect(rule).toContain("align-items: center");
    // No nudge pulling the title up to the tile's top any more.
    expect(css).not.toContain(
      ".arrival-opts .ac-option > :is(.ac-brand, .arrival-opts__tile):first-child + .ac-option__text > .ac-option__title {",
    );
  });

  test("Choose keeps long names whole, the box and the face on the name's first line", async () => {
    const css = await stylesheet("../src/components/arrival/arrival.css");
    const rule = (selector: string) =>
      css.split(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`))[1]?.split("}")[0] ?? "";
    expect(rule(".arrival-pick__name")).not.toContain("ellipsis");
    expect(rule(".arrival-pick__name")).toContain("overflow-wrap: anywhere");
    expect(rule(".arrival-pick")).toContain("align-items: start");
  });
});
