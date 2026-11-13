import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { join } from "node:path";
import type { AiAccounts, AiComputer, PlanUsage } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { declarations, topLevel } from "./built-css";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Your plans' limits where the workspace's budget was (ADR 0063 §5): in Sua conta, in the account menu near a limit,
 * the budget only where the workspace uses the API; and the account card's lines on its face.
 */

afterEach(() => cleanup());

const LATER = "2099-01-01T15:40:00.000Z";
const used = (fiveHour: number, week: number): PlanUsage => ({
  windows: [
    { kind: "five_hour", usedPercent: fiveHour, resetsAt: LATER },
    { kind: "seven_day", usedPercent: week, resetsAt: LATER },
  ],
  source: "turn",
  at: new Date().toISOString(),
});
const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};
const TEAM: AiAccounts["accounts"][number] = {
  id: "acct_team",
  kind: "claude_code",
  label: "Claude Team",
  email: "walt@acme.com",
  plan: "team",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: ["Ada", "Atlas"],
  usage: used(12, 40),
  provider: null,
  keyHint: null,
  machineId: "machine_1",
  computer: "MacBook",
};

type State = ReturnType<typeof seedState>;

/** Ada and Atlas think with Walter's Claude Team, and nothing went through the API this month. */
function onPlans(state: State = seedState()) {
  state.spentUsd = { [ADA_ID]: 0, [ATLAS_ID]: 0 };
  for (const a of state.agents)
    a.brain = { kind: "claude_code", model: "Sonnet", account: "Claude Team", usage: used(12, 40) };
  return state;
}

/** The app at `path` (under the workspace) with Walter's accounts. */
async function go(path: string, state: State, accounts: AiAccounts["accounts"] = [TEAM]) {
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({ accounts, computers: [MAC] });
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(6);
  return r;
}

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const account = () => screen().getByRole("button", { name: /^Conta: / });
/** Radix menus open from the keyboard here (a pointer press, not a click, opens them with a mouse). */
const openMenu = async () => {
  account().focus();
  await act(async () => {
    fireEvent.keyDown(account(), { key: "Enter" });
    fireEvent.keyUp(account(), { key: "Enter" });
  });
  await settle(4);
  return screen().getAllByRole("menu")[0] as HTMLElement;
};
/** The menu's rows, under my face on top (an item too: it changes my photo). */
const names = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .filter((i) => !i.matches(".ac-face-edit"))
    .map((i) => i.textContent);

/** Sua conta's card of your plans, by its words (null: none). */
const plansCard = () => screen().queryByRole("region", { name: "Limites dos seus planos" })?.textContent ?? null;
/** Each time the app asked the computers to look your plans' usage up again. */
const refreshes = (state: State) =>
  state.calls.filter((c) => c.method === "machines.refreshAccountUsage").map((c) => c.args);

describe("Sua conta: your plans' limits", () => {
  test("each plan your agents think with: its mark, its name and its compact line, opening Uso", async () => {
    const { router } = await go("settings/account", onPlans());
    const card = screen().getByRole("region", { name: "Limites dos seus planos" });
    const plan = within(card).getByRole("button", { name: /^Claude Team/ });
    expect(plan.querySelector(".settings-row__icon .ac-brand")?.getAttribute("data-mark")).toBeTruthy();
    expect(plan.querySelector(".settings-row__label")?.textContent).toBe("Claude Team");
    // Its tightest windows and one bar for the fullest: the line the agents' facts and AI accounts draw.
    expect(plan.querySelector(".ac-planmeter__line")?.textContent).toBe("semana 40% · 5h 12%");
    expect(
      within(plan)
        .getAllByRole("meter")
        .map((m) => m.getAttribute("aria-valuenow")),
    ).toEqual(["40"]);
    await click(plan);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/usage`);
  });

  test("no window known yet, or no agent thinks with it: no card, never 0%", async () => {
    await go("settings/account", onPlans(), [{ ...TEAM, usage: null }]);
    expect(plansCard()).toBeNull();
    cleanup();
    await go("settings/account", onPlans(), [{ ...TEAM, usedBy: [] }]);
    expect(plansCard()).toBeNull();
  });

  test("opening it asks your computers to look your plans' usage up again", async () => {
    const state = onPlans();
    await go("settings/account", state);
    expect(refreshes(state)).toEqual([[ORG_ID]]);
  });
});

describe("IA e uso: budget only where the workspace uses the API", () => {
  const BUDGET = ["API do workspace", "Gastos da API por tipo", "Orçamento padrão dos agentes"];
  const regions = () => BUDGET.filter((name) => screen().queryByRole("region", { name }));

  test("on plans alone: no budget anywhere on the screen, only the accounts and the keys", async () => {
    await go("settings/usage", onPlans());
    expect(screen().getByRole("region", { name: "Contas" })).toBeTruthy();
    expect(regions()).toEqual([]);
    const body = document.querySelector(".settings__body")?.textContent ?? "";
    expect(body).not.toMatch(/orçamento|US\$/i);
    // A workspace that already holds a key keeps its keys in sight.
    expect(screen().getByRole("region", { name: "Chaves de provedor" })).toBeTruthy();
    // The tabs stay: Resumo, then Pessoas.
    expect(
      within(screen().getByRole("tablist", { name: "IA e uso" }))
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Resumo", "Pessoas"]);
  });

  test("on plans alone with no key: only the accounts, and the first key is added from Conectar uma IA", async () => {
    const state = onPlans();
    state.credentials = [];
    await go("settings/usage", state);
    const accounts = screen().getByRole("region", { name: "Contas" });
    expect(screen().queryByRole("region", { name: "Chaves de provedor" })).toBeNull();
    expect(regions()).toEqual([]);
    await click(within(accounts).getByRole("button", { name: "Conectar uma IA" }));
    expect(within(screen().getByRole("dialog")).getByRole("radio", { name: "Com chave de API" })).toBeTruthy();
  });

  test("one agent on the API with a key: the API per agent, its spend by kind and the default budget", async () => {
    const state = seedState();
    state.spentUsd = { [ADA_ID]: 0, [ATLAS_ID]: 0 };
    // Ada stays on the API (her key is the workspace's); Atlas thinks with Claude Team.
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.brain = { kind: "claude_code", model: "Sonnet", account: "Claude Team", usage: used(12, 40) };
    await go("settings/usage", state);
    expect(regions()).toEqual(BUDGET);
    expect(screen().getByLabelText("Orçamento mensal por agente (US$)")).toBeTruthy();
  });
});

describe("IA e uso › Contas with many accounts and long names", () => {
  // The worst case the list is built for: a dozen accounts, names that run past any row, two near their limit.
  const LONG = "Assinatura corporativa compartilhada do time de atendimento e operações";
  const MANY: AiAccounts["accounts"] = Array.from({ length: 12 }, (_, i) => ({
    ...TEAM,
    id: `acct_${i}`,
    label: `${LONG} ${i + 1}`,
    email: `conta-${i + 1}-com-um-endereco-bem-comprido@subdominio.example.com`,
    ownerName: "Maximiliano Albuquerque de Vasconcelos",
    usedBy: i === 0 ? ["Ada", "Atlas"] : [],
    usage: i === 11 ? null : used(5 * i, i < 2 ? 96 - 10 * i : 7 * i),
  }));

  test("each is one row: whole name, plan, owner's first name and one meter; only those near a limit start open", async () => {
    await go("settings/usage", onPlans(), MANY);
    const plans = screen().getByRole("region", { name: "Contas" });
    // The seeded computer's own sign-in comes first.
    const rows = ([...plans.querySelectorAll(".plan-row")] as HTMLElement[]).slice(1);
    expect(rows).toHaveLength(12);
    const heads = rows.map((r) => r.querySelector(".plan-row__head") as HTMLElement);
    // Names wrap whole, never cut: the words are all there, the plan and whose it is after them.
    expect(heads.map((h) => h.querySelector(".plan-acct__name")?.textContent)).toEqual(
      MANY.map((a) => `${a.label}\u2002Team\u2002de Maximiliano`),
    );
    // One meter each, none while nothing is known: never 0%.
    expect(heads.map((h) => within(h).queryAllByRole("meter").length)).toEqual([...Array(11).fill(1), 0]);
    expect(heads[0]?.querySelector(".ac-planmeter__line")?.textContent).toBe("semana 96%");
    expect(heads.map((h) => h.getAttribute("aria-expanded"))).toEqual(["true", "true", ...Array(10).fill("false")]);
    expect(heads.map((h) => Boolean(h.querySelector(".plan-row__alert")))).toEqual([
      true,
      true,
      ...Array(10).fill(false),
    ]);
    // A closed row holds nothing: twelve accounts stay twelve lines.
    expect(rows.slice(2).map((r) => r.querySelector(".plan-row__body")?.textContent)).toEqual(Array(10).fill(""));
    // The keyboard opens one: its head is a button that says whether it is open.
    const third = heads[2] as HTMLElement;
    expect(third.tagName).toBe("BUTTON");
    await click(third);
    expect(third.getAttribute("aria-expanded")).toBe("true");
    expect(rows[2]?.textContent).toContain("conta-3-com-um-endereco-bem-comprido@subdominio.example.com");
    expect(within(rows[2] as HTMLElement).getByRole("button", { name: "Desconectar" })).toBeTruthy();
  });
});

describe("the account menu: a plan near its limit", () => {
  test("under 80%: no line, the menu as it was", async () => {
    await go("settings", onPlans(), [{ ...TEAM, usage: used(12, 79) }]);
    expect(names(await openMenu())).toEqual(["Definir status", "Editar perfil", "Configurações", "Sair"]);
  });

  test("opening it asks your computers to look your plans' usage up again", async () => {
    const state = onPlans();
    await go("settings", state, [{ ...TEAM, usage: used(12, 79) }]);
    expect(refreshes(state)).toEqual([]);
    await openMenu();
    expect(refreshes(state)).toEqual([[ORG_ID]]);
  });

  test("from 80%: one line under your status, the plan and how it stands, opening Uso", async () => {
    const { router } = await go("settings", onPlans(), [{ ...TEAM, usage: used(86, 40) }]);
    const menu = await openMenu();
    expect(names(menu)).toEqual([
      "Claude TeamQuase no limite",
      "Definir status",
      "Editar perfil",
      "Configurações",
      "Sair",
    ]);
    const plan = within(menu).getByRole("menuitem", { name: /^Claude Team/ });
    expect(plan.querySelector(".ac-menu__leading .ac-brand--xs")).toBeTruthy();
    expect(plan.querySelector(".ac-menu__hint")?.textContent).toBe("Quase no limite");
    // Under you, before the menu's first separator.
    expect(plan.previousElementSibling?.matches(".profile-menu__head, .profile-menu__line")).toBe(true);
    await click(plan);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/usage`);
  });

  test("a plan at its limit before a fuller one almost there; when it's back, if known", async () => {
    const work = {
      ...TEAM,
      id: "acct_work",
      label: "Trabalho",
      email: "work@acme.com",
      usedBy: ["Atlas"],
      // It refused a request before any window was known.
      usage: { windows: [], limited: true, source: "turn" as const, at: new Date().toISOString() },
    };
    await go("settings", onPlans(), [{ ...TEAM, usage: used(95, 40) }, work]);
    const menu = await openMenu();
    expect(names(menu)[0]).toBe("Trabalho · TeamNo limite");
    expect(names(menu).filter((n) => n?.startsWith("Claude Team"))).toEqual([]);
    cleanup();
    await go("settings", onPlans(), [{ ...TEAM, usage: used(100, 40) }]);
    expect(names(await openMenu())[0]).toMatch(/^Claude TeamNo limite até /);
  });
});

const ROOT = join(import.meta.dir, "../../..");
const read = (file: string) => Bun.file(join(ROOT, file)).text();
/** A selector's last value for a property in a stylesheet, as written. */
const of = (css: string, selector: string, prop: string) =>
  declarations(css, selector).findLast(([p]) => p === prop)?.[1] ?? "";
const px = (value: string | undefined) => Number.parseFloat(value ?? "");

describe("the account card", () => {
  test("with a line under the name, the face starts at its capitals; a name alone centres on the face", async () => {
    await go("settings", seedState());
    expect(account().classList.contains("ac-faceline")).toBe(true);
    expect(account().querySelector(".sidebar__user-name")?.classList.contains("ac-captop")).toBe(true);
    cleanup();
    // How you appear isn't known yet: no line under the name.
    const api = createFakeApi(seedState());
    api.orgs.people = () => new Promise<never>(() => {});
    await renderApp(`/org/${ORG_ID}/settings`, { api });
    await settle(6);
    expect(account().querySelector(".sidebar__user-line")).toBeNull();
    expect(account().classList.contains("ac-faceline")).toBe(false);
    expect(account().querySelector(".sidebar__user-name")?.classList.contains("ac-captop")).toBe(false);
  });

  test("as much room over the face and the name's capitals as under the face and the last baseline", async () => {
    const layout = topLevel(await read("apps/web/src/layout.css"));
    const presence = topLevel(await read("apps/web/src/components/presence.css"));
    const tokens = await read("packages/ui/src/styles/tokens.css");
    // `ex` follows the app's font-size-adjust; a line's capitals' top and middle sit that many ex over its middle.
    const adjust = px(/--font-size-adjust:\s*([\d.]+)/.exec(await read("apps/web/src/styles.css"))?.[1]);
    const token = (name: string) => px(new RegExp(`${name}:\\s*([\\d.]+)ex`).exec(tokens)?.[1]);
    const capTop = token("--cap-top");
    const capMid = token("--cap-mid");
    const type = (css: string, selector: string) => ({
      size: px(of(css, selector, "font-size")),
      line: px(of(css, selector, "line-height")),
    });
    const name = type(layout, ".sidebar__user-name");
    const line = type(presence, ".sidebar__user-line");
    // The name's capitals start the lines (`.ac-captop`); the line's baseline ends them.
    expect(of(presence, ".sidebar__user-line", "margin-bottom")).toBe(
      `calc(var(--cap-top) - 2 * var(--cap-mid) - ${line.line / 2}px)`,
    );
    const lines =
      name.line / 2 + capTop * adjust * name.size + line.line / 2 + (capTop - 2 * capMid) * adjust * line.size;
    const face = px(of(layout, ".sidebar__me > .sidebar__user > .ac-avatar", "height"));
    expect(Math.abs(lines - face)).toBeLessThan(0.5);
    // A name alone is no taller than the face: the card keeps its height while your line loads.
    expect(name.line).toBeLessThanOrEqual(face);
    const [top, , bottom] = of(layout, ".sidebar__me > .sidebar__user", "padding").split(/\s+/);
    expect(top).toBe(bottom);
  });

  test("in the narrow sidebar, as tall as the workspace's button above it", async () => {
    const layout = topLevel(await read("apps/web/src/layout.css"));
    const height = (selector: string) => px(of(layout, selector, "height"));
    const padding = (selector: string) => px(of(layout, selector, "padding"));
    expect(
      height(".sidebar__me > .sidebar__user > .ac-avatar") + 2 * padding('.sidebar[data-rail="true"] .sidebar__user'),
    ).toBe(height(".sidebar__org-mark") + 2 * padding('.sidebar[data-rail="true"] .sidebar__org .sidebar__org-button'));
  });
});
