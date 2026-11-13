import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, DirectMessage, TeamTemplate } from "@agenteschat/client";
import { ApiError, keys } from "@agenteschat/client";
import type { OnboardingStepId } from "@agenteschat/client/lib/onboarding";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import { focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ATLAS_ID,
  createFakeApi,
  type FakeState,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle, showIn } from "./render";
// The team step's views load on their own (`TeamSource`'s lazy import): loaded here first, so a step shows them within
// its first rounds and the geometry capture never measures their placeholder.
import "@/pages/onboarding/TeamSourceBody";

/*
 * The onboarding (ADR 0162): what the workspace is for first (ADR 0159), then the blue rail with Lodi, its steps read
 * from the workspace's own data: a team's name, business and team, a personal workspace's agents, the plan only where
 * the workspace waits for its first one, an AI for the team to think with, and where the workspace opens after it.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
  focusManager.setFocused(undefined);
});

const button = (name: string | RegExp) => screen().getByRole("button", { name });
const answer = (name: RegExp) => screen().getByRole("radio", { name });
const click = async (el: Element, rounds = 10) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
/** The first question answered for a company or team: its name comes next. */
const forATeam = async () => {
  await click(answer(/Para meu time/), 4);
  await click(button("Continuar"), 4);
};
const type = async (label: string, value: string) => {
  await act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
const heading = () => document.querySelector(".onb__title")?.textContent;
const eyebrow = () => document.querySelector(".onb__eyebrow")?.textContent;
/** The plan step's card: its button shares the rail step's name, "Ligar o time". */
const planCard = () => document.querySelector(".onb__plan") as HTMLElement;
const GREETING = "Oi, eu sou o Lodi. Monto o time com você.";
/** How a team with no agents yet starts, after "I don't use any yet" (ADR 0162, amended 2026-11-11). */
const START = "Como você quer começar o time?";
/** The team step's question, before a template or an import. */
const ASK = "Você já tem agentes em outro app?";
/** The last step's heading while no AI is connected. */
const CONNECT = "Conecte uma IA para o seu time pensar";
/** The same, in a personal workspace (ADR 0159): no team there. */
const CONNECT_PERSONAL = "Conecte uma IA para os seus agentes pensarem";
/** A team's last step: inviting the people who work there (ADR 0162, amended 2026-11-11). */
const PEOPLE = "Quem trabalha com você?";
/** The geometry capture, where CI runs one (`check:geometry`). */
const snapshot = () => (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
/** A new workspace's zone and the person's own in it: this browser's, sent with the workspace. */
const zones = () => {
  const zone = browserTimezone();
  return { timezone: zone ?? "UTC", ...(zone ? { memberTimezone: zone } : {}) };
};

const draft = (name: string, handle: string, role: string, channel: string) => ({
  name,
  handle,
  role,
  line: `${name} cuida de ${role.toLowerCase()}.`,
  instructions: role,
  appearance: null,
  channel,
  routines: [],
  firstTask: null,
});
const TEMPLATES: TeamTemplate[] = [
  {
    id: "store",
    name: "Loja online",
    sub: "Pedidos, estoque e redes sociais",
    description: "Para uma loja que vende online.",
    team: {
      lead: "Um time para a loja.",
      agents: [
        draft("Iara", "iara", "Atendimento", "atendimento"),
        draft("Otto", "otto", "Pedidos", "pedidos"),
        draft("Lia", "lia", "Conteúdo", "conteudo"),
      ],
      newChannels: ["atendimento", "pedidos", "conteudo"],
      skills: [],
      weekly: null,
      approvals: "O que sai para os clientes espera a sua aprovação.",
      invite: [],
    },
  },
  {
    id: "clinic",
    name: "Clínica ou consultório",
    sub: "Agenda no WhatsApp",
    description: "Para uma clínica.",
    team: {
      lead: "Um time para a clínica.",
      agents: [draft("Nina", "nina", "Agenda", "agenda")],
      newChannels: ["agenda"],
      skills: [],
      weekly: null,
      approvals: "",
      invite: [],
    },
  },
];

/** Someone signed up with no workspace yet; `cloud`: the server bills, and a new workspace waits for its plan. */
const newcomer = (cloud: boolean) => {
  const state = seedState({ agents: [] });
  if (state.me) state.me.organizations = [];
  state.teamTemplates = TEMPLATES;
  if (cloud) {
    state.authConfig = { billingUrl: "https://billing.example.com" };
    state.newWorkspaceStanding = { state: "hold", reason: "payment" };
  }
  return state;
};
/** One being set up already, at whatever its data says; `step`: the furthest one the server keeps. */
const settingUp = (opts: { held?: boolean; context?: string; team?: boolean; step?: OnboardingStepId } = {}) => {
  const state = withRightHand(seedState(opts.team ? {} : { agents: [] }));
  if (state.me)
    state.me.organizations = [
      {
        id: ORG_ID,
        name: "Ateliê Couto",
        role: "owner",
        onboarding: { step: opts.step ?? "context", generalChannelId: GENERAL_ID },
        ...(opts.held ? { standing: { state: "hold" as const, reason: "payment" } } : {}),
      },
    ];
  if (opts.context) state.context = opts.context;
  state.teamTemplates = TEMPLATES;
  if (opts.held) state.authConfig = { billingUrl: "https://billing.example.com" };
  return state;
};
/** The billing service's public plan list; `null`: it can't be read. */
const plans = (list: unknown | null) => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return list === null
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return asked;
};
const PLANS = {
  recommended: "team",
  plans: [
    { key: "personal", name: "Pessoal", price: "$29", period: "month" },
    { key: "team", name: "Equipe", price: "$49", period: "month" },
  ],
};

/**
 * No agent has an AI yet, whoever is made later (the fake's own answer is every agent ready): the last step asks for
 * one.
 */
const noAiYet = (state: FakeState) => {
  Object.defineProperty(state, "aiStatus", {
    configurable: true,
    get: () => ({ any: false, agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai" as const })) }),
  });
  return state;
};
/** An AI connected meanwhile (in the step's dialog, another tab, the phone): every agent ready again. */
const aiConnected = (state: FakeState) =>
  Object.defineProperty(state, "aiStatus", { configurable: true, writable: true, value: undefined });
/** The team step's question answered "I don't use any yet", then its button ("Build a new team" for a team's). */
const noneYet = async (go = "Montar um time novo") => {
  const none = screen().queryByRole("radio", { name: /Ainda não uso nenhum/ }) ?? button(/Ainda não uso nenhum/);
  await click(none, 4);
  await click(button(go), 14);
};
/** On how a team starts, "Start with a ready-made team" and its button: the template's screen. */
const readyMade = async () => {
  await click(answer(/Começar com um time pronto/), 4);
  await click(button("Ver o time pronto"), 8);
};
/** Where the onboarding sends the person, with the arrival it asks for (the workspace drops it from the address). */
const landings = (router: Awaited<ReturnType<typeof renderApp>>["router"]) => {
  const seen: { path: string; arrival: string | undefined }[] = [];
  router.subscribe("onBeforeNavigate", (e) => {
    // Against the last path seen, not `pathChanged`: the router's resolved location can lag behind a navigation that
    // only drops the arrival from the address.
    if (e.toLocation.pathname === (seen.at(-1)?.path ?? e.fromLocation?.pathname)) return;
    const arrival = (e.toLocation.search as Record<string, unknown>).arrival;
    seen.push({ path: e.toLocation.pathname, arrival: arrival === undefined ? undefined : String(arrival) });
  });
  return seen;
};

/** Steps 1 to 3 as a person goes through them: the name, "Loja online", no agents yet, the store's team made. */
async function throughTheTeam(state: FakeState) {
  const r = await renderApp("/onboarding", { api: createFakeApi(state) });
  const landed = landings(r.router);
  await settle(10);
  await forATeam();
  await type("Nome", "Ateliê Couto");
  await click(button("Continuar"), 14);
  await click(button("Loja online"), 4);
  await click(button("Continuar"), 14);
  await noneYet();
  await readyMade();
  await click(button("Criar o time"), 20);
  return { ...r, landed };
}

describe("the steps", () => {
  test("the name creates the workspace and goes on, nothing finished; what it does is its context", async () => {
    const state = newcomer(false);
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    expect(document.querySelector(".onb__say")?.textContent).toContain("Eu sou o Lodi.");
    await forATeam();
    expect(eyebrow()).toBe("Passo 1 de 5");
    // The whole path on the rail, connecting an AI last.
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Conectar uma IA");
    await type("Nome", "Ateliê Couto");
    await click(button("Continuar"), 14);
    expect(calls(state, "orgs.create")[0]?.args[0]).toEqual({ name: "Ateliê Couto", ...zones() });
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
    expect(heading()).toBe("O que a Ateliê Couto faz?");
    expect(eyebrow()).toBe("Passo 2 de 5");
    // A type alone is enough; its words are the context.
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    await click(button("Loja online"), 4);
    await click(button("Continuar"), 14);
    const orgId = state.me?.organizations[0]?.id;
    expect(calls(state, "orgs.updateSettings").at(-1)?.args).toEqual([orgId, { context: "Loja online" }]);
    // Its team: first whether its agents come from another app.
    expect(heading()).toBe(ASK);
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
    await noneYet();
    // "None" is kept by the server: another visit opens on how to start, "Start from scratch" picked.
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[orgId, { step: "import" }]]);
    expect(heading()).toBe(START);
    expect(answer(/Começar do zero/).getAttribute("aria-checked")).toBe("true");
    await readyMade();
    expect(heading()).toBe("Seu time");
    // The store's team, picked for its business.
    expect(document.querySelector(".tp-agents")?.textContent).toContain("Otto");
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Loja online");
  });

  test("a type and a sentence are saved together: going back, or coming back later, finds both", async () => {
    const state = newcomer(false);
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    await forATeam();
    await type("Nome", "Ateliê Couto");
    await click(button("Continuar"), 14);
    await click(button("Clínica ou consultório"), 4);
    await type("Em uma frase", "Atendemos com hora marcada");
    await click(button("Continuar"), 14);
    const orgId = state.me?.organizations[0]?.id;
    const context = "Clínica ou consultório · Atendemos com hora marcada";
    expect(calls(state, "orgs.updateSettings").at(-1)?.args).toEqual([orgId, { context }]);
    // Back on step 2: the type still picked, the sentence still there, and Continuar keeps both.
    await click(document.querySelectorAll(".onb__step")[1] as HTMLElement, 8);
    expect(button("Clínica ou consultório").getAttribute("aria-pressed")).toBe("true");
    expect((screen().getByLabelText("Em uma frase") as HTMLTextAreaElement).value).toBe("Atendemos com hora marcada");
    await click(button("Continuar"), 14);
    expect(calls(state, "orgs.updateSettings").at(-1)?.args).toEqual([orgId, { context }]);
    cleanup();
    // Another visit (a reload, the phone), "none" answered: the team step starts on how to start, the clinic's template
    // a click away.
    await renderApp("/onboarding", { api: createFakeApi(settingUp({ context, step: "import" })) });
    await settle(14);
    expect(heading()).toBe(START);
    expect(answer(/Começar com um time pronto/).closest("label")?.textContent).toContain("Nina");
    await readyMade();
    expect(heading()).toBe("Seu time");
    expect(document.querySelector(".tp-agents")?.textContent).toContain("Nina");
  });

  test("a template picked stays picked, until step 2 names another business: then that business's template", async () => {
    const state = settingUp({ context: "Roupas sob medida para noivas" });
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    await noneYet();
    await readyMade();
    const team = () => document.querySelector(".tp-agents")?.textContent;
    expect(team()).toContain("Otto");
    await pick(screen().getByRole("combobox", { name: "Modelos de time" }), "Clínica ou consultório");
    expect(team()).toContain("Nina");
    const backToStep2 = () => click(document.querySelectorAll(".onb__step")[1] as HTMLElement, 8);
    await backToStep2();
    await click(button("Continuar"), 14);
    expect(team()).toContain("Nina");
    await backToStep2();
    await click(button("Loja online"), 4);
    await click(button("Continuar"), 14);
    expect(team()).toContain("Otto");
  });

  test("Outra coisa asks for the sentence", async () => {
    const state = settingUp();
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(12);
    expect(heading()).toBe("O que a Ateliê Couto faz?");
    await click(button("Outra coisa"), 4);
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    await type("Em uma frase", "Roupas sob medida para noivas");
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(false);
  });

  test("self-hosted (no plans), the server's AI there: Criar o time goes on to inviting people, never the AI step", async () => {
    const state = newcomer(false);
    const { router, landed } = await throughTheTeam(state);
    const orgId = state.me?.organizations[0]?.id;
    expect(calls(state, "agents.applyTeamTemplate").map((c) => c.args[1])).toEqual(["store"]);
    expect(heading()).toBe(PEOPLE);
    expect(eyebrow()).toBe("Passo 5 de 5");
    expect(router.state.location.pathname).toBe("/onboarding");
    await click(button("Convidar depois"), 16);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([
      [orgId, { step: "import" }],
      [orgId, { finished: true }],
    ]);
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${orgId}/c/`));
    // The team thought before its step showed: the arrival as ever, the beta notice then Connect for whoever has none.
    expect(landed.at(-1)?.arrival).toBe("1");
    // Never a price, a plan or a billing call.
    expect(calls(state, "orgs.billingLink")).toEqual([]);
  });

  test("no AI yet: a step connects one, Conectar depois goes on to inviting people, then #general with the beta notice alone", async () => {
    const state = noAiYet(newcomer(false));
    const { router, landed } = await throughTheTeam(state);
    const orgId = state.me?.organizations[0]?.id;
    expect(heading()).toBe(CONNECT);
    expect(eyebrow()).toBe("Passo 4 de 5");
    // Not the last step: the people come after it.
    expect(document.querySelector(".onb__say")?.textContent).toBe(
      "Escolha a IA que você já usa e o time acorda. Depois, falta só chamar as pessoas.",
    );
    expect(router.state.location.pathname).toBe("/onboarding");
    await click(button("Conectar depois"), 16);
    // Kept as left for later, so a reload resumes on the people step.
    expect(calls(state, "orgs.saveOnboarding").at(-1)?.args).toEqual([orgId, { step: "ai" }]);
    expect(heading()).toBe(PEOPLE);
    expect(eyebrow()).toBe("Passo 5 de 5");
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Depois");
    await click(button("Convidar depois"), 16);
    expect(calls(state, "orgs.saveOnboarding").at(-1)?.args).toEqual([orgId, { finished: true }]);
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${orgId}/c/`));
    expect(landed.at(-1)?.arrival).toBe("beta");
  });

  test("back from the AI step: the team, whose Continuar comes back to it; nothing opens meanwhile", async () => {
    const state = noAiYet(settingUp({ context: "Loja online", team: true }));
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    expect(heading()).toBe(CONNECT);
    await click(button("Voltar"), 8);
    expect(heading()).toBe("Seu time");
    // Words for a team already made, never the template's.
    expect(document.querySelector(".onb__lead")?.textContent).toBe(
      "Eles já estão no workspace. Você ajusta cada um depois.",
    );
    expect(document.querySelector(".onb__say")?.textContent).toBe(
      "O time já está montado. Quando quiser, a gente segue.",
    );
    expect(router.state.location.pathname).toBe("/onboarding");
    await click(button("Continuar"), 8);
    expect(heading()).toBe(CONNECT);
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
  });

  test("an AI connected meanwhile: its done screen stays, Continuar goes on to the people, then #general with the beta notice alone", async () => {
    const state = noAiYet(settingUp({ context: "Loja online", team: true }));
    const { router, services } = await renderApp("/onboarding", { api: createFakeApi(state) });
    const landed = landings(router);
    await settle(16);
    expect(heading()).toBe(CONNECT);
    aiConnected(state);
    await act(() => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
    await settle(10);
    // The step stays on what was connected, rather than the people step taking its place.
    expect(heading()).toBe("Pronto. O time da Ateliê Couto já pensa.");
    expect(eyebrow()).toBe("Passo 4 de 5");
    expect(document.querySelector(".onb__progress-text")?.textContent).toContain("Falta 1 etapa");
    expect(document.querySelector(".onb__say")?.textContent).toBe("Agora sim. Falta só chamar quem trabalha com você.");
    expect(router.state.location.pathname).toBe("/onboarding");
    await click(button("Continuar"), 12);
    expect(heading()).toBe(PEOPLE);
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Conectada");
    // Back from the people: the AI step's done screen again, and Continuar returns.
    await click(button("Voltar"), 8);
    expect(heading()).toBe("Pronto. O time da Ateliê Couto já pensa.");
    await click(button("Continuar"), 8);
    expect(heading()).toBe(PEOPLE);
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
    await click(button("Convidar depois"), 16);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { finished: true }]]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(landed.at(-1)?.arrival).toBe("beta");
  });

  test("a step of the template that fails says why, and the same button tries again", async () => {
    const state = settingUp({ context: "Loja online", step: "import" });
    const api = createFakeApi(state);
    api.agents.applyTeamTemplate = async () => ({
      channelId: "dm",
      messageId: "m",
      state: "pending",
      error: { step: "channel", reason: "taken", target: "pedidos" } as never,
    });
    await renderApp("/onboarding", { api });
    await settle(12);
    await readyMade();
    await click(button("Criar o time"), 12);
    expect(document.querySelector(".onb__actions [role='alert']")).not.toBeNull();
    expect(button("Tentar de novo")).toBeTruthy();
  });

  test("beside the question: a workspace named neutrally until typed, every agent counted, one team order", async () => {
    const native = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(min-width: 1200px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      plans(PLANS);
      await renderApp("/onboarding", { api: createFakeApi(newcomer(true)) });
      await settle(10);
      const preview = () => document.querySelector(".onb-preview") as HTMLElement;
      const name = () => preview().querySelector(".sidebar__org-name")?.textContent;
      const meta = () => preview().querySelector(".sidebar__org-meta")?.textContent;
      const agents = () =>
        [...(preview().querySelectorAll(".sidebar__section")[1]?.querySelectorAll(".sidebar__item-label") ?? [])].map(
          (e) => e.textContent,
        );
      // Never the field's example ("Ex.: Acme"), and Lodi, listed under Agentes, is counted there.
      expect(name()).toBe("Seu workspace");
      expect(meta()).toBe("1 membro · 1 agente");
      await forATeam();
      await type("Nome", "Ateliê Couto");
      expect(name()).toBe("Ateliê Couto");
      await click(button("Continuar"), 14);
      await click(button("Loja online"), 4);
      await click(button("Continuar"), 14);
      // On the team's question, nobody but Lodi yet.
      expect(agents()).toEqual(["Lodi"]);
      await noneYet();
      // Starting from scratch: still Lodi alone, the team's place empty.
      expect(agents()).toEqual(["Lodi"]);
      expect(preview().querySelector(".onb-preview__ghost")?.textContent).toBe("O time aparece aqui");
      // The ready-made team picked: the template's agents and channels show as they would come.
      await click(answer(/Começar com um time pronto/), 4);
      expect(agents()).toEqual(["Lodi", "Iara", "Otto", "Lia"]);
      expect(preview().querySelectorAll(".sidebar__item[data-fresh]").length).toBeGreaterThan(3);
      await click(answer(/Começar do zero/), 4);
      expect(agents()).toEqual(["Lodi"]);
      await readyMade();
      // The template's order, the one step 3 lists, before and after the team is made.
      expect(
        [...document.querySelectorAll(".onb__body .tp-agent .ac-mediarow__head b")].map((b) => b.textContent),
      ).toEqual(["Iara", "Otto", "Lia"]);
      expect(agents()).toEqual(["Lodi", "Iara", "Otto", "Lia"]);
      expect(meta()).toBe("1 membro · 4 agentes");
      await click(button("Criar o time"), 16);
      expect(agents()).toEqual(["Lodi", "Iara", "Otto", "Lia"]);
      expect([...planCard().querySelectorAll(".onb__plan-week b")].map((b) => b.textContent)).toEqual([
        "Iara",
        "Otto",
        "Lia",
      ]);
      expect(document.querySelector(".onb__steps")?.textContent).toContain("Iara, Otto e Lia");
    } finally {
      window.matchMedia = native;
    }
  });
});

describe("the plan step (agentes.chat Cloud)", () => {
  test("the team asleep, the plan with its price from the billing service, the link to that plan's Checkout", async () => {
    const state = newcomer(true);
    const asked = plans(PLANS);
    await throughTheTeam(state);
    expect(eyebrow()).toBe("Passo 4 de 6");
    expect(heading()).toBe("Ligue o time");
    const card = document.querySelector(".onb__plan") as HTMLElement;
    expect(card.textContent).toContain("Plano Equipe · $49 por mês");
    expect(card.querySelectorAll(".onb__plan-face")).toHaveLength(3);
    // What comes after it: connecting an AI.
    expect(card.textContent).toContain("Em seguida: conectar a sua IA.");
    expect(asked[0]).toBe("https://billing.example.com/plans.json?locale=pt-BR");
    const orgId = state.me?.organizations[0]?.id;
    // Nothing is finished while it waits for the plan: the step is only kept as shown, so once paid it stays.
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([
      [orgId, { step: "import" }],
      [orgId, { step: "computer" }],
    ]);
    await click(within(planCard()).getByRole("button", { name: "Ligar o time" }), 6);
    expect(calls(state, "orgs.billingLink").map((c) => c.args)).toEqual([[orgId, "onboarding", "team"]]);
    await click(button("Ver todos os planos"), 6);
    expect(calls(state, "orgs.billingLink").at(-1)?.args).toEqual([orgId, "onboarding"]);
  });

  test("back at the plan step from the billing page: it opens whole, its price there from its first frame", async () => {
    const state = settingUp({ context: "Loja online", team: true, held: true });
    let answer: (r: Response) => void = () => {};
    globalThis.fetch = (() =>
      new Promise<Response>((done) => {
        answer = done;
      })) as unknown as typeof fetch;
    await renderApp(`/org/${ORG_ID}/onboarding`, { api: createFakeApi(state) });
    await settle(14);
    // The billing service's plan list still on its way: no step yet, rather than one whose price line would change.
    expect(planCard()).toBeNull();
    const list = new Response(JSON.stringify(PLANS), { status: 200, headers: { "content-type": "application/json" } });
    await act(async () => answer(list));
    await settle(10);
    expect(document.querySelector(".onb__plan-price")?.textContent).toContain("Plano Equipe · $49 por mês");
  });

  test("with no plan data, the plan is named generically and both ways open the billing page", async () => {
    const state = newcomer(true);
    plans(null);
    await throughTheTeam(state);
    expect(document.querySelector(".onb__plan-price")?.textContent).toContain("Um plano do agentes.chat");
    expect(screen().queryByRole("button", { name: "Ver todos os planos" })).toBeNull();
    await click(within(planCard()).getByRole("button", { name: "Ligar o time" }), 6);
    expect(calls(state, "orgs.billingLink").map((c) => c.args.length)).toEqual([2]);
  });

  test("Ligar depois e só conhecer o workspace finishes it and opens Lodi's DM, with the beta notice alone", async () => {
    const state = newcomer(true);
    plans(PLANS);
    const { router, landed } = await throughTheTeam(state);
    const orgId = state.me?.organizations[0]?.id;
    await click(button("Ligar depois e só conhecer o workspace"), 16);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([
      [orgId, { step: "import" }],
      [orgId, { step: "computer" }],
      [orgId, { finished: true }],
    ]);
    // Its card there leads with the plan: no Connect an AI on a workspace that waits for it.
    expect(router.state.location.pathname).toBe(`/org/${orgId}/dm/agent/${LODI_ID}`);
    expect(landed.at(-1)?.arrival).toBe("beta");
  });
});

describe("a workspace being set up resumes from its data", () => {
  test("at what it does, at its team's question or how it starts, at its plan; never a second workspace", async () => {
    for (const [opts, title, saved] of [
      [{}, "O que a Ateliê Couto faz?", []],
      [{ context: "Loja online" }, ASK, []],
      // Past the question ("I don't use any yet"), wherever it was left: how to start, its templates a click away.
      [{ context: "Loja online", step: "import" }, START, []],
      [{ context: "Loja online", team: true, held: true }, "Ligue o time", [[ORG_ID, { step: "computer" }]]],
    ] as const) {
      const state = settingUp(opts);
      plans(PLANS);
      await renderApp("/onboarding", { api: createFakeApi(state) });
      await settle(14);
      expect(heading()).toBe(title);
      expect(calls(state, "orgs.create")).toEqual([]);
      expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual<typeof saved>(saved);
      cleanup();
    }
  });

  test("a step answered in another tab meanwhile: this one moves on when it comes back, never a second team", async () => {
    const state = settingUp({ context: "Loja online", held: true });
    plans(PLANS);
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    expect(heading()).toBe(ASK);
    // The other tab made the team.
    state.agents.push(...seedState().agents);
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle(14);
    expect(heading()).toBe("Ligue o time");
    expect(calls(state, "agents.applyTeamTemplate")).toEqual([]);
  });

  test("a read that fails, or a workspace that won't open, says so with a way on, never a sky that waits", async () => {
    const broke = () => new ApiError(500, "internal", "Something broke");
    const state = settingUp({ context: "Loja online" });
    const api = createFakeApi(state);
    const read = api.orgs.settings;
    let fails = 1;
    api.orgs.settings = async (orgId) => {
      if (fails-- > 0) throw broke();
      return read(orgId);
    };
    await renderApp("/onboarding", { api });
    await settle(14);
    await click(button("Tentar de novo"), 14);
    expect(heading()).toBe(ASK);
    cleanup();

    // Its people invited already ("team"): nothing left to answer, it opens by itself.
    const ready = settingUp({ context: "Loja online", team: true, step: "team" });
    const opening = createFakeApi(ready);
    const finish = opening.orgs.saveOnboarding;
    let refusals = 1;
    opening.orgs.saveOnboarding = async (orgId, input) => {
      if (refusals-- > 0) throw broke();
      return finish(orgId, input);
    };
    const { router } = await renderApp("/onboarding", { api: opening });
    await settle(16);
    expect(router.state.location.pathname).toBe("/onboarding");
    await click(button("Tentar de novo"), 16);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  });

  test("its team thinking, it resumes on inviting people; invited already, it opens in #general", async () => {
    const state = settingUp({ context: "Loja online", team: true });
    const first = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    expect(first.router.state.location.pathname).toBe("/onboarding");
    expect(heading()).toBe(PEOPLE);
    cleanup();
    // The AI left for later ("ai"): the people step too, never the AI step again.
    const later = noAiYet(settingUp({ context: "Loja online", team: true, step: "ai" }));
    await renderApp("/onboarding", { api: createFakeApi(later) });
    await settle(16);
    expect(heading()).toBe(PEOPLE);
    cleanup();
    const invited = settingUp({ context: "Loja online", team: true, step: "team" });
    const { router } = await renderApp("/onboarding", { api: createFakeApi(invited) });
    await settle(16);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  });

  test("back from paying: the payment received, then the AI step once the hold lifts; back without: the plan", async () => {
    const paid = noAiYet(settingUp({ context: "Loja online", team: true, held: true }));
    plans(PLANS);
    const { router } = await renderApp(`/org/${ORG_ID}/onboarding?paid=1`, { api: createFakeApi(paid) });
    await settle(14);
    expect(router.state.location.pathname).toBe("/onboarding");
    expect(heading()).toBe("Ligue o time");
    expect(within(planCard()).getByRole("status").textContent).toContain("Pagamento recebido");
    expect(within(planCard()).queryByRole("button", { name: "Ligar o time" })).toBeNull();
    // Nothing finished: the step only kept as shown.
    expect(calls(paid, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { step: "computer" }]]);
    // The billing service lifts the hold; `/me` says so when asked again.
    const org = paid.me?.organizations[0];
    if (org) delete org.standing;
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle(16);
    expect(heading()).toBe(CONNECT);
    // The plan stays on the rail, on, and is never asked again.
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Ligado");
    const rail = [...document.querySelectorAll<HTMLButtonElement>(".onb__step")];
    expect(rail.find((b) => b.textContent?.includes("Ligar o time"))?.disabled).toBe(true);
    expect(calls(paid, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { step: "computer" }]]);
    cleanup();

    const back = settingUp({ context: "Loja online", team: true, held: true });
    plans(PLANS);
    await renderApp(`/org/${ORG_ID}/onboarding`, { api: createFakeApi(back) });
    await settle(14);
    expect(heading()).toBe("Ligue o time");
    expect(calls(back, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { step: "computer" }]]);
    cleanup();

    // Back without paying to one set up meanwhile in another tab: it opens as it is, never a new workspace's step 1.
    const meanwhile = settingUp({ context: "Loja online", team: true, held: true });
    const setUp = meanwhile.me?.organizations[0];
    if (setUp) delete setUp.onboarding;
    const again = await renderApp(`/org/${ORG_ID}/onboarding`, { api: createFakeApi(meanwhile) });
    await settle(14);
    expect(again.router.state.location.pathname.startsWith(`/org/${ORG_ID}/`)).toBe(true);
    expect(document.querySelector(".onb")).toBeNull();
  });

  test("asked to delete the workspace being set up: its dialog, and nothing is finished", async () => {
    const state = settingUp();
    await renderApp("/onboarding?delete=1", { api: createFakeApi(state) });
    await settle(10);
    expect(screen().getByRole("dialog")).toBeTruthy();
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
  });
});

describe("a team with no agents for now (ADR 0162, amended 2026-11-11)", () => {
  test("Skip this step on the question: the right hand alone on the AI step; back, the question again", async () => {
    const state = noAiYet(settingUp({ context: "Loja online" }));
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    expect(heading()).toBe(ASK);
    // The quiet way out under the step's button, with what it means.
    const skip = document.querySelector(".onb__actions .onb__skip");
    expect(skip?.textContent).toContain("Você cria os agentes depois, um por um.");
    await click(button("Pular esta etapa"), 16);
    // Kept by the server, so a reload resumes after the step; nothing made.
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { step: "agents" }]]);
    expect(calls(state, "agents.applyTeamTemplate")).toEqual([]);
    // Its right hand alone thinks with it: named, never a team that isn't there.
    expect(heading()).toBe("Conecte uma IA para o Lodi pensar");
    expect(eyebrow()).toBe("Passo 4 de 5");
    // The team step answered, its agents to come; Lodi alone wakes with the AI, the people still to come.
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Depois");
    expect(document.querySelector(".onb__say")?.textContent).toBe(
      "Escolha a IA que você já usa e eu acordo. Depois, falta só chamar as pessoas.",
    );
    expect(router.state.location.pathname).toBe("/onboarding");
    // Back on the team step: the question again, to bring or build a team after all, never an empty team.
    await click(button("Voltar"), 8);
    expect(heading()).toBe(ASK);
    expect(button("Pular esta etapa")).toBeTruthy();
    // "I don't use any yet" there, then the ready-made team: the templates, which stay on screen.
    await noneYet();
    await readyMade();
    expect(heading()).toBe("Seu time");
    await click(button("Criar o time"), 20);
    expect(calls(state, "agents.applyTeamTemplate").map((c) => c.args[1])).toEqual(["store"]);
    // The step gone back to stays on screen with who is in the team now, until Continuar.
    expect(
      [...document.querySelectorAll(".onb__body .tp-agent .ac-mediarow__head b")].map((b) => b.textContent),
    ).toEqual(["Iara", "Otto", "Lia"]);
    await click(button("Continuar"), 12);
    expect(heading()).toBe(CONNECT);
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Iara, Otto e Lia");
  });

  test("Start from scratch, picked on how to start: the plan for the right hand alone, and a reload resumes there", async () => {
    const state = settingUp({ context: "Loja online", held: true });
    plans(PLANS);
    const withoutRoutines = () => {
      const api = createFakeApi(state);
      // A new workspace has no routines yet: its right hand has no first job to show on the plan step.
      api.routines = { ...api.routines, list: async () => [] };
      return api;
    };
    await renderApp("/onboarding", { api: withoutRoutines() });
    await settle(14);
    await noneYet();
    expect(heading()).toBe(START);
    expect(document.querySelector(".onb__lead")?.textContent).toBe("Dá para mudar tudo depois, nada se perde.");
    expect(document.querySelector(".onb__say")?.textContent).toBe(
      "Tenho um time pronto para o que vocês fazem. Ou a gente começa só nós dois.",
    );
    // Two radio cards in one group, "Start from scratch" picked, each with who comes in it.
    expect(screen().getByRole("radiogroup", { name: START })).toBeTruthy();
    const template = answer(/Começar com um time pronto/);
    const scratch = answer(/Começar do zero/);
    expect(template.getAttribute("aria-checked")).toBe("false");
    expect(scratch.getAttribute("aria-checked")).toBe("true");
    expect(template.closest("label")?.textContent).toContain(
      "3 agentes do modelo Loja online, cada um no seu canal, com as rotinas prontas.",
    );
    expect(template.closest("label")?.querySelector(".onb-start__names")?.textContent).toBe("Iara, Otto e Lia");
    expect(scratch.closest("label")?.textContent).toContain(
      "Só o Lodi, o seu braço direito. Você cria cada agente depois, do seu jeito.",
    );
    expect(scratch.closest("label")?.querySelector(".onb-start__names")?.textContent).toBe("Lodi e quem você criar");
    await click(button("Seguir só com o Lodi"), 16);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([
      [ORG_ID, { step: "import" }],
      [ORG_ID, { step: "agents" }],
      [ORG_ID, { step: "computer" }],
    ]);
    expect(calls(state, "agents.applyTeamTemplate")).toEqual([]);
    expect(heading()).toBe("Ligue o time");
    expect(document.querySelector(".onb__lead")?.textContent).toBe(
      "Com o plano e uma IA, o seu braço direito começa hoje. Os outros agentes você cria depois.",
    );
    // Its right hand alone, asleep until the plan, said as what it is.
    expect(planCard().querySelectorAll(".onb__plan-face")).toHaveLength(1);
    expect(planCard().querySelector(".onb__plan-week")?.textContent).toBe("Lodi · Seu braço direito");
    cleanup();

    // Another visit: after the team step, never back on how to start.
    plans(PLANS);
    await renderApp("/onboarding", { api: withoutRoutines() });
    await settle(14);
    expect(heading()).toBe("Ligue o time");
  });

  test("Start with a ready-made team: its templates with no way out but Back, to how to start, then the question", async () => {
    const state = noAiYet(settingUp({ context: "Loja online" }));
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    await noneYet();
    // The keyboard: an arrow picks the other card, Enter on a card presses the step's button.
    const scratch = answer(/Começar do zero/);
    scratch.focus();
    await act(async () => fireEvent.keyDown(scratch, { key: "ArrowUp" }));
    await settle(4);
    expect(answer(/Começar com um time pronto/).getAttribute("aria-checked")).toBe("true");
    expect(button("Ver o time pronto")).toBeTruthy();
    await act(async () => fireEvent.keyDown(answer(/Começar com um time pronto/), { key: "Enter" }));
    await settle(8);
    expect(heading()).toBe("Seu time");
    // Nothing stored for looking at the templates; and no "create later" under their button any more.
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { step: "import" }]]);
    expect(document.querySelector(".onb__actions .onb__skip")).toBeNull();
    expect(screen().queryByRole("button", { name: /depois/ })).toBeNull();
    // Back: how to start, the ready-made team still picked; Back again: the question.
    await click(button("Voltar"), 6);
    expect(heading()).toBe(START);
    expect(answer(/Começar com um time pronto/).getAttribute("aria-checked")).toBe("true");
    await click(button("Voltar"), 6);
    expect(heading()).toBe(ASK);
    // "I don't use any yet" again: from scratch picked again; Start with a ready-made team, then the team made.
    await noneYet();
    expect(answer(/Começar do zero/).getAttribute("aria-checked")).toBe("true");
    await readyMade();
    await click(button("Criar o time"), 20);
    expect(calls(state, "agents.applyTeamTemplate").map((c) => c.args[1])).toEqual(["store"]);
    expect(heading()).toBe(CONNECT);
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Iara, Otto e Lia");
  });

  test("self-hosted with an AI already there: skipping goes on to the people, then #general, the team's place", async () => {
    const state = settingUp({ context: "Loja online" });
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    await click(button("Pular esta etapa"), 16);
    expect(heading()).toBe(PEOPLE);
    await click(button("Convidar depois"), 16);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([
      [ORG_ID, { step: "agents" }],
      [ORG_ID, { finished: true }],
    ]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  });
});

describe("the person's own area, asked once per account", () => {
  const AREA = "E você, cuida de quê?";
  /** Nobody asked this account its area yet (the fake's accounts said it already). */
  const unasked = (state: FakeState) => {
    if (state.me) state.me.user.workArea = null;
    return state;
  };
  const chip = (name: string) => button(name);

  test("a team's, after what it does, on that step of the rail: Back keeps the answers, a chip then Continue goes on", async () => {
    const state = unasked(newcomer(false));
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    await forATeam();
    await type("Nome", "Ateliê Couto");
    await click(button("Continuar"), 14);
    await click(button("Loja online"), 4);
    await click(button("Continuar"), 14);
    expect(heading()).toBe(AREA);
    expect(document.querySelector(".onb__lead")?.textContent).toBe("Só para a gente entender quem usa o agentes.chat.");
    // Still "What you do" on the rail: no step of its own.
    expect(eyebrow()).toBe("Passo 2 de 5");
    expect(document.querySelector(".onb__step[aria-current='step']")?.textContent).toContain("O que vocês fazem");
    expect(document.querySelector(".onb__say")?.textContent).toBe("Última curiosidade antes do time.");
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    // Back: what it does, as answered.
    await click(button("Voltar"), 8);
    expect(heading()).toBe("O que a Ateliê Couto faz?");
    expect(button("Loja online").getAttribute("aria-pressed")).toBe("true");
    await click(button("Continuar"), 14);
    expect(heading()).toBe(AREA);
    // One at a time; a chip only marks it.
    await click(chip("Vendas"), 4);
    await click(chip("Marketing"), 4);
    expect(chip("Marketing").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Vendas").getAttribute("aria-pressed")).toBe("false");
    expect(heading()).toBe(AREA);
    await click(button("Continuar"), 14);
    expect(calls(state, "account.setWorkArea").map((c) => c.args[0])).toEqual(["marketing"]);
    expect(heading()).toBe(ASK);
    cleanup();

    // Another visit, the area said: never asked again.
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    expect(heading()).toBe(ASK);
  });

  test("Skip this step stores that it was asked; a reload before either asks again", async () => {
    const state = unasked(settingUp({ context: "Loja online" }));
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    // Reloaded before answering: asked again.
    expect(heading()).toBe(AREA);
    await click(button("Pular esta etapa"), 14);
    expect(calls(state, "account.setWorkArea").map((c) => c.args[0])).toEqual(["skipped"]);
    expect(heading()).toBe(ASK);
    cleanup();
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    expect(heading()).toBe(ASK);
  });

  test("a save that fails never holds the onboarding", async () => {
    const state = unasked(settingUp({ context: "Loja online" }));
    const api = createFakeApi(state);
    api.account.setWorkArea = async () => {
      throw new ApiError(500, "internal", "Something broke");
    };
    await renderApp("/onboarding", { api });
    await settle(14);
    await click(chip("Finanças"), 4);
    await click(button("Continuar"), 14);
    expect(heading()).toBe(ASK);
  });

  test("a personal workspace's, after For me, before its agents; no Back to a purpose it can't change", async () => {
    const state = unasked(newcomer(false));
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    await click(answer(/^Para mim(?!ha)/), 4);
    await click(button("Continuar"), 16);
    expect(heading()).toBe(AREA);
    expect(document.querySelector(".onb__say")?.textContent).toBe("Última curiosidade antes dos seus agentes.");
    expect(screen().queryByRole("button", { name: "Voltar" })).toBeNull();
    await click(chip("Desenvolvimento"), 4);
    await click(button("Continuar"), 14);
    expect(calls(state, "account.setWorkArea").map((c) => c.args[0])).toEqual(["dev"]);
    expect(heading()).toBe(ASK);
  });
});

describe("inviting people, a team's last step (ADR 0162, amended 2026-11-11)", () => {
  test("the addresses as chips, each with its role, sent by the step's button; the workspace opens in #general", async () => {
    const state = settingUp({ context: "Loja online", team: true });
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    const landed = landings(router);
    await settle(16);
    expect(heading()).toBe(PEOPLE);
    expect(eyebrow()).toBe("Passo 5 de 5");
    expect(document.querySelector(".onb__lead")?.textContent).toBe(
      "Convide as pessoas do time. Cada uma recebe um e-mail para entrar.",
    );
    expect(document.querySelector(".onb__say")?.textContent).toBe(
      "Agora as pessoas. Me passa os e-mails que eu mando os convites.",
    );
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Convidar pessoas");
    // Nothing typed: the button waits, and the way past the step is under it.
    expect((button("Enviar convites") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".onb__actions .onb__skip")?.textContent).toBe("Convidar depois");
    const field = screen().getByLabelText("E-mails");
    await act(async () => fireEvent.change(field, { target: { value: "bia@example.com, caio@example.com" } }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(4);
    await pick(screen().getByRole("combobox", { name: "Papel de caio@example.com" }), "Admin");
    await click(button("Convidar 2 pessoas"), 20);
    expect(calls(state, "orgs.inviteMany").map((c) => c.args[1])).toEqual([
      {
        invites: [
          { email: "bia@example.com", roleIds: [] },
          { email: "caio@example.com", roleIds: ["role-admin"] },
        ],
      },
    ]);
    // Kept as invited, then finished.
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([
      [ORG_ID, { step: "team" }],
      [ORG_ID, { finished: true }],
    ]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    // The team thought before the AI step could show: the arrival as ever.
    expect(landed.at(-1)?.arrival).toBe("1");
  });

  test("Convidar depois opens the workspace with no invitation; an address already in is said and left out", async () => {
    const state = settingUp({ context: "Loja online", team: true });
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    const field = screen().getByLabelText("E-mails");
    await act(async () => fireEvent.change(field, { target: { value: state.me?.user.email ?? "" } }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(2);
    expect(document.querySelector(".email-chip")?.textContent).toContain("já está na Ateliê Couto");
    expect((button("Enviar convites") as HTMLButtonElement).disabled).toBe(true);
    await click(button("Convidar depois"), 16);
    expect(calls(state, "orgs.inviteMany")).toEqual([]);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { finished: true }]]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  });

  test("a server that sends no email: the workspace's link, and Entrar no workspace", async () => {
    const state = settingUp({ context: "Loja online", team: true });
    state.authConfig = { passwordReset: false };
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    expect(heading()).toBe(PEOPLE);
    expect(document.querySelector(".onb__lead")?.textContent).toBe(
      "Quem abrir pede para entrar. Eu te mostro cada pedido, e você aprova.",
    );
    expect(screen().queryByLabelText("E-mails")).toBeNull();
    // The link to copy and until when it works: renewing or turning it off is for Members, once the workspace opens.
    await click(button("Criar link"), 8);
    const link = document.querySelector(".onb__body .invite-link") as HTMLElement;
    expect(within(link).getByRole("button", { name: "Copiar link" })).toBeTruthy();
    expect(link.querySelector(".invite-link__foot")?.textContent).toMatch(/^Vale até \d+ \S+$/);
    expect(within(link).queryByRole("button", { name: "Renovar" })).toBeNull();
    expect(within(link).queryByRole("button", { name: "Desativar" })).toBeNull();
    await click(button("Entrar no workspace"), 16);
    expect(calls(state, "orgs.inviteMany")).toEqual([]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  });
});

describe("the name step's other cases", () => {
  test("waiting for its plan elsewhere: said in place, with the way to that plan", async () => {
    const state = newcomer(true);
    const api = createFakeApi(state);
    api.orgs.create = async () => {
      throw new ApiError(403, "org.create_unpaid", "Waiting", { orgId: ORG_ID });
    };
    await renderApp("/onboarding", { api });
    await settle(10);
    await forATeam();
    await type("Nome", "Outra loja");
    await click(button("Continuar"), 10);
    expect(document.querySelector(".onb__status")?.textContent).toBeTruthy();
    expect(document.querySelector(".onb__answer .row button")).not.toBeNull();
  });

  test("back on the name after another visit: the workspace's own zone and name, the zone kept unless changed", async () => {
    const state = settingUp({ context: "Loja online" });
    const api = createFakeApi(state);
    const read = api.orgs.settings;
    api.orgs.settings = async (orgId) => ({ ...(await read(orgId)), timezone: "Asia/Tokyo" });
    await renderApp("/onboarding", { api });
    await settle(14);
    await click(document.querySelectorAll(".onb__step")[0] as HTMLElement, 8);
    expect(document.querySelector(".onb__help")?.textContent).toContain("Tóquio");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("Ateliê Couto");
    // The field clears like any other, and an empty name goes nowhere.
    await type("Nome", "");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("");
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    await type("Nome", "Ateliê Couto e Filhas");
    await click(button("Continuar"), 14);
    expect(calls(state, "orgs.updateSettings").at(-1)?.args).toEqual([ORG_ID, { name: "Ateliê Couto e Filhas" }]);
  });

  test("invite-only: the step says so and Continuar stays off", async () => {
    const state = newcomer(false);
    if (state.me) state.me.user = { ...state.me.user, canCreateWorkspace: false };
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    await click(answer(/Para meu time/), 4);
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".onb__note")?.textContent).toBeTruthy();
  });
});

describe("for me (ADR 0159)", () => {
  test("no name nor business to ask: its agents, its plan, and the plan left for later opens Lodi's DM", async () => {
    const state = newcomer(true);
    plans(PLANS);
    const api = createFakeApi(state);
    // A new workspace has no routines yet: its right hand has no first job to show on the plan step.
    api.routines = { ...api.routines, list: async () => [] };
    const { router } = await renderApp("/onboarding", { api });
    const landed = landings(router);
    await settle(10);
    expect(heading()).toBe("Para que você vai usar o agentes.chat?");
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    // "For me", not "For my team", whose words start the same in Portuguese.
    await click(answer(/^Para mim(?!ha)/), 4);
    expect(screen().queryByLabelText("Nome")).toBeNull();
    // Its whole path on the rail at once: what it is for, its agents, the plan, an AI.
    expect(document.querySelectorAll(".onb__step")).toHaveLength(4);
    expect(document.querySelector(".onb__steps")?.textContent).not.toContain("O que vocês fazem");
    await click(button("Continuar"), 16);
    expect(calls(state, "orgs.create")[0]?.args[0]).toEqual({ name: "Pessoal", mode: "personal", ...zones() });
    const orgId = state.me?.organizations.at(-1)?.id;
    // Whether its agents come from another app, never a team template.
    expect(heading()).toBe(ASK);
    expect(calls(state, "orgs.saveOnboarding")).toEqual([]);
    // Its "I don't use any yet" already goes on with no agents: no "Skip this step" beside it.
    expect(screen().queryByRole("button", { name: "Pular esta etapa" })).toBeNull();
    // Its "I don't use any yet" goes on with no agents at once: never how a team starts.
    await noneYet("Seguir sem agentes");
    expect(heading()).toBe("Ligue os seus agentes");
    // Its agents step answered with none: they come later.
    expect(document.querySelector(".onb__steps")?.textContent).toContain("Depois");
    // Its right hand alone, asleep until the plan, said as what it is (it has no role), and the button in its words.
    expect(planCard().querySelectorAll(".onb__plan-face")).toHaveLength(1);
    expect(planCard().querySelector(".onb__plan-week")?.textContent).toBe("Lodi · Seu braço direito");
    expect(within(planCard()).getByRole("button", { name: "Ligar os agentes" })).toBeTruthy();
    expect(within(planCard()).queryByRole("button", { name: "Ligar o time" })).toBeNull();
    await click(button("Ligar depois e só conhecer o workspace"), 16);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([
      [orgId, { step: "agents" }],
      [orgId, { step: "computer" }],
      [orgId, { finished: true }],
    ]);
    expect(router.state.location.pathname).toBe(`/org/${orgId}/dm/agent/${LODI_ID}`);
    expect(landed.at(-1)?.arrival).toBe("beta");
    expect(calls(state, "agents.applyTeamTemplate")).toEqual([]);
  });

  test("self-hosted with no AI yet: the AI step for its right hand, and Conectar depois opens Lodi's DM", async () => {
    const state = noAiYet(newcomer(false));
    const { router } = await renderApp("/onboarding", { api: createFakeApi(state) });
    const landed = landings(router);
    await settle(10);
    await click(answer(/^Para mim(?!ha)/), 4);
    // Its agents, then an AI: no people to invite here.
    expect(document.querySelectorAll(".onb__step")).toHaveLength(3);
    expect(document.querySelector(".onb__steps")?.textContent).not.toContain("Convidar pessoas");
    await click(button("Continuar"), 16);
    await noneYet("Seguir sem agentes");
    expect(heading()).toBe(CONNECT_PERSONAL);
    expect(eyebrow()).toBe("Passo 3 de 3");
    await click(button("Conectar depois"), 16);
    const orgId = state.me?.organizations.at(-1)?.id;
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([
      [orgId, { step: "agents" }],
      [orgId, { finished: true }],
    ]);
    expect(router.state.location.pathname).toBe(`/org/${orgId}/dm/agent/${LODI_ID}`);
    expect(landed.at(-1)?.arrival).toBe("beta");
  });

  test("back from the name, the question again; the answer can change", async () => {
    const state = newcomer(false);
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(10);
    await forATeam();
    expect(screen().getByLabelText("Nome")).toBeTruthy();
    await click(button("Voltar"), 4);
    expect(answer(/Para meu time/).getAttribute("aria-checked")).toBe("true");
    expect(calls(state, "orgs.create")).toEqual([]);
  });
});

/** Every call the app makes, reads too, in order, as "orgs.create". */
function recorded(api: ApiClient) {
  const log: string[] = [];
  const wrap = <T extends object>(target: T, path: string): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver);
        const name = path ? `${path}.${String(key)}` : String(key);
        if (typeof value === "function")
          return (...args: unknown[]) => {
            log.push(name);
            return value.apply(obj, args);
          };
        return value && typeof value === "object" ? wrap(value, name) : value;
      },
    });
  return { api: wrap(api, ""), log };
}

/**
 * How long "Abrindo seu workspace" waits is its calls one after another: each is a round trip to the server (#1).
 */
describe("opening a new workspace, in round trips", () => {
  test("For me: one call makes it with both zones, one finishes it and opens Lodi's DM, nobody asked again", async () => {
    const state = noAiYet(newcomer(false));
    const { api, log } = recorded(createFakeApi(state));
    const { router } = await renderApp("/onboarding", { api });
    await settle(10);
    await click(answer(/^Para mim(?!ha)/), 4);
    log.length = 0;
    await click(button("Continuar"), 16);
    expect(heading()).toBe(ASK);
    expect(log[0]).toBe("orgs.create");
    // Its zones went with it and the answers said who the person is: none of them is asked on its own.
    expect(log.filter((c) => ["account.me", "orgs.updateSettings", "orgs.updateMe"].includes(c))).toEqual([]);
    await noneYet("Seguir sem agentes");
    expect(heading()).toBe(CONNECT_PERSONAL);
    log.length = 0;
    const off = router.subscribe("onBeforeNavigate", (e) => {
      if (e.pathChanged) log.push(`→ ${e.toLocation.pathname}`);
    });
    await click(button("Conectar depois"), 16);
    off();
    const orgId = state.me?.organizations.at(-1)?.id;
    const before = log.slice(0, log.findIndex((c) => c.startsWith("→")) + 1);
    // One call finishes it, and its answer says where it opens.
    expect(before.slice(-2)).toEqual(["orgs.saveOnboarding", `→ /org/${orgId}/dm/agent/${LODI_ID}`]);
    expect(before.filter((c) => c === "account.me")).toEqual([]);
    expect(state.me?.organizations.at(-1)?.onboarding).toBeUndefined();
  });

  test("a logo picked first: the workspace, its logo, then who the person is asked again, for the logo", async () => {
    const state = newcomer(false);
    const { api, log } = recorded(createFakeApi(state));
    await renderApp("/onboarding", { api });
    await settle(10);
    await forATeam();
    await click(button("Escolher o logo"), 4);
    const dialog = screen().getByRole("dialog", { name: "Logo do workspace" });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () =>
      fireEvent.change(input, { target: { files: [new File(["png-bytes"], "logo.png", { type: "image/png" })] } }),
    );
    await settle(3);
    await click(screen().getByRole("button", { name: "Salvar" }), 6);
    await type("Nome", "Ateliê Couto");
    log.length = 0;
    await click(button("Continuar"), 14);
    expect(log.slice(0, 5)).toEqual(["orgs.create", "orgs.setLogo", "orgs.settings", "agents.list", "account.me"]);
    expect(heading()).toBe("O que a Ateliê Couto faz?");
  });

  test("a conversation opened for the first time shows from its own answer, no list read again for it", async () => {
    const state = seedState();
    const { api, log } = recorded(createFakeApi(state));
    const { services } = await renderApp(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`, { api });
    await settle(10);
    expect(screen().getByRole("heading", { level: 1, name: /Atlas/ })).toBeTruthy();
    expect(log.filter((c) => c === "dms.open")).toHaveLength(1);
    expect(log.filter((c) => c === "dms.list")).toHaveLength(1);
    expect(log.filter((c) => c === "chat.channels")).toHaveLength(1);
    // In the DM list all the same, where the header's search finds it.
    const dms = services.queryClient.getQueryData<DirectMessage[]>(keys.dms(ORG_ID)) ?? [];
    expect(dms.some((d) => d.with.id === ATLAS_ID)).toBe(true);
  });
});

describe("the worst case, measured by CI's geometry in German and Russian too", () => {
  test("a long unbroken name, a long first name, a long sentence, a long plan and price, every rail answer filled", async () => {
    const state = settingUp({ held: true, team: true, context: "Vendemos cerâmica feita à mão. ".repeat(16).trim() });
    const org = state.me?.organizations[0];
    if (org) org.name = "Cerâmicas Pneumoultramicroscopicossilicovulcanoconióticas Artesanais Ltda";
    if (state.me) state.me.user = { ...state.me.user, name: "Maximiliana Bartolomeu Constantinopla de Albuquerque" };
    plans({
      recommended: "team",
      plans: [{ key: "team", name: "Equipe Profissional Ilimitada Plus", price: "US$ 49,00 + impostos" }],
    });
    const { services } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(14);
    expect(heading()).toBe("Ligue o time");
    expect(document.querySelector(".onb__plan-price")?.textContent).toContain("Equipe Profissional Ilimitada Plus");
    for (const lang of ["de", "ru"] as const) {
      await showIn(services, lang);
      for (const step of [0, 1, 3]) {
        await click(document.querySelectorAll(".onb__step")[step] as HTMLElement, 8);
        snapshot();
      }
    }
  });

  test("the team's question, the AI step and its done screen, with the same long names", async () => {
    const LONG = "Cerâmicas Pneumoultramicroscopicossilicovulcanoconióticas Artesanais Ltda";
    const long = (state: FakeState) => {
      const org = state.me?.organizations[0];
      if (org) org.name = LONG;
      if (state.me) state.me.user = { ...state.me.user, name: "Maximiliana Bartolomeu Constantinopla de Albuquerque" };
      return state;
    };
    const context = "Vendemos cerâmica feita à mão. ".repeat(16).trim();
    const asking = await renderApp("/onboarding", { api: createFakeApi(long(settingUp({ context }))) });
    await settle(14);
    expect(heading()).toBe(ASK);
    for (const lang of ["de", "ru"] as const) {
      await showIn(asking.services, lang);
      snapshot();
    }
    cleanup();

    const state = noAiYet(long(settingUp({ context, team: true })));
    const { services } = await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(16);
    expect(heading()).toBe(CONNECT);
    for (const lang of ["de", "ru"] as const) {
      await showIn(services, lang);
      snapshot();
    }
    aiConnected(state);
    await act(() => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
    await settle(10);
    expect(heading()).toContain(LONG);
    for (const lang of ["de", "ru"] as const) {
      await showIn(services, lang);
      snapshot();
    }
  });
});

describe("the top of Lodi's DM without its checklist", () => {
  test("with a team and an AI: the greeting and the way to build the team again, no card", async () => {
    const state = withRightHand(seedState());
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(10);
    expect(document.body.textContent).toContain(GREETING);
    expect(document.querySelector(".setup-cl")).toBeNull();
    expect(button("Montar o time")).toBeTruthy();
  });
});
