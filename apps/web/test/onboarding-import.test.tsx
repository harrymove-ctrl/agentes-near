import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, ImportInput, ImportItemResult, TeamTemplate } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { WATCH_POLL_MS } from "@/components/ImportFlow";
import { createFakeApi, type FakeState, GENERAL_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";
// The step's views load on their own (`TeamSource`'s lazy import): loaded here first, so each test sees them at once.
import "@/pages/onboarding/TeamSourceBody";

/*
 * The onboarding's team step asking first whether the agents already live in another app, and bringing them inside the
 * step (ADR 0162 amended 2026-11-10, ADR 0055): the question, the request and its answer, what was found, the report
 * when something stayed behind; "No agents yet" goes to a team's templates.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
});

const ASK = "Você já tem agentes em outro app?";
const CONNECT = "Conecte uma IA para o seu time pensar";

const button = (name: string | RegExp) => screen().getByRole("button", { name });
const answer = (name: string | RegExp) => screen().getByRole("radio", { name });
const click = async (el: Element, rounds = 10) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
const applies = (state: FakeState) => calls(state, "imports.apply").map((c) => c.args[1] as ImportInput);
const heading = () => document.querySelector(".onb__title")?.textContent;
const text = () => document.body.textContent ?? "";

const TEMPLATES: TeamTemplate[] = [
  {
    id: "store",
    name: "Loja online",
    sub: "Pedidos, estoque e redes sociais",
    description: "Para uma loja que vende online.",
    team: {
      lead: "Um time para a loja.",
      agents: [
        {
          name: "Otto",
          handle: "otto",
          role: "Pedidos",
          line: "Otto cuida dos pedidos.",
          instructions: "Pedidos",
          appearance: null,
          channel: "pedidos",
          routines: [],
          firstTask: null,
        },
      ],
      newChannels: ["pedidos"],
      skills: [],
      weekly: null,
      approvals: "",
      invite: [],
    },
  },
];

/**
 * A workspace being set up past what it does, its team step next. `cloud`: it waits for its first plan; `personal`:
 * a personal workspace (ADR 0159), whose rail has no business step.
 */
const settingUp = (o: { cloud?: boolean; personal?: boolean } = {}) => {
  const state = withRightHand(seedState({ agents: [] }));
  if (state.me)
    state.me.organizations = [
      {
        id: ORG_ID,
        name: o.personal ? "Pessoal" : "Acme",
        role: "owner",
        ...(o.personal ? { mode: "personal" as const } : {}),
        onboarding: { step: "context", generalChannelId: GENERAL_ID },
        ...(o.cloud ? { standing: { state: "hold" as const, reason: "payment" } } : {}),
      },
    ];
  state.context = "Loja online";
  state.teamTemplates = TEMPLATES;
  if (o.cloud) {
    state.authConfig = { billingUrl: "https://billing.example.com" };
    // The billing service's plan list can't be read: the plan step opens with its generic words.
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  }
  return state;
};

/** No AI connected yet, for every agent there is at each read: the imported ones too. */
const withoutAi = (api: ApiClient, state: FakeState) => {
  api.agents = {
    ...api.agents,
    aiStatus: async () => ({
      any: false,
      agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai" as const, reason: "no_key" as const })),
    }),
  };
  return api;
};

/** The onboarding on the team step. */
const open = async (state: FakeState, api: ApiClient = createFakeApi(state)) => {
  const r = await renderApp("/onboarding", { api });
  await settle(10);
  return r;
};

/** What Grok Bot answers to the export request: two agents (one on a model of its own) and a channel. */
const grokReply = (o: { skills?: boolean } = {}) => ({
  format: "agenteschat.bundle",
  version: 1,
  source: { app: "grok-bot", ref: "my-bots", name: "Meus bots", files: [] },
  agents: [
    {
      key: "nina",
      name: "Nina",
      handle: "nina",
      role: "Pesquisa",
      instructions: "Pesquisa o mercado toda semana.",
      model: "claude-sonnet-5-5",
      appearance: {},
      skills: [],
    },
    {
      key: "leo",
      name: "Leo",
      handle: "leo",
      role: "Vendas",
      instructions: "Responde os clientes.",
      model: null,
      appearance: {},
      skills: [],
    },
  ],
  skills: o.skills
    ? [{ key: "tom", markdown: "---\nname: Tom de voz\ndescription: Como a empresa fala\n---\nFale com calma." }]
    : [],
  channels: [{ key: "pesquisa", name: "pesquisa", topic: "", agents: [{ key: "nina", autoReply: true }] }],
  routines: [],
  notes: [],
  todo: [],
  leftOut: [],
});
/** As an app answers in its chat: some words, then the JSON in a code block. */
const fenced = (reply: object) => `Aqui está:\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\``;

/** The question answered with Grok Bot, its answer pasted and read: what was found is on screen. */
const throughTheAnswer = async (reply: string) => {
  await click(answer("Grok Bot"), 4);
  await click(button("Trazer do Grok Bot"), 10);
  const field = screen().getByLabelText("Cole aqui a resposta do Grok Bot");
  await act(async () => fireEvent.change(field, { target: { value: reply } }));
  await click(button("Ler a resposta"), 14);
};

describe("the team step's question", () => {
  test("the import's apps as answers, then no agents yet, which says the team is made from what the workspace does", async () => {
    await open(settingUp());
    expect(heading()).toBe(ASK);
    for (const app of ["Grok Bot", "ChatGPT dots", "OpenClaw", "Outro app"]) expect(answer(app)).toBeTruthy();
    const none = answer(/Ainda não uso nenhum/);
    expect(none.closest("label")?.textContent).toContain("Eu monto um time para a Acme a partir do que vocês fazem.");
    // Nothing picked: the step's button waits for an answer, and under it the way past the step.
    expect((button("Continuar") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Pular esta etapa") as HTMLButtonElement).disabled).toBe(false);
    await click(answer("Grok Bot"), 4);
    expect(answer("Grok Bot").getAttribute("aria-checked")).toBe("true");
    expect(button("Trazer do Grok Bot")).toBeTruthy();
    await click(none, 4);
    expect(button("Montar um time novo")).toBeTruthy();
  });

  test("no agents yet is remembered on the workspace and opens how a team starts, with Back to the question", async () => {
    const state = settingUp();
    await open(state);
    await click(answer(/Ainda não uso nenhum/), 4);
    await click(button("Montar um time novo"), 12);
    // Only past the question: the team step still waits for its team.
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { step: "import" }]]);
    expect(heading()).toBe("Como você quer começar o time?");
    expect(button("Seguir só com o Lodi")).toBeTruthy();
    await click(button("Voltar"), 6);
    expect(heading()).toBe(ASK);
  });
});

describe("bringing the team from an app that answers in its chat", () => {
  test("the request, the answer pasted and read, what was found; the team comes, each agent on the suggested model", async () => {
    const state = settingUp();
    await open(state, withoutAi(createFakeApi(state), state));
    await click(answer("Grok Bot"), 4);
    await click(button("Trazer do Grok Bot"), 10);
    expect(heading()).toBe("Traga o seu time do Grok Bot");
    const request = screen().getByRole("region", { name: "Peça para o Grok Bot exportar" });
    expect([...request.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Copie o pedido abaixo.",
      "Cole na conversa com o Grok Bot.",
      "Ele responde com um JSON: copie a resposta inteira e cole no campo de baixo.",
    ]);
    const field = screen().getByLabelText("Cole aqui a resposta do Grok Bot");
    await act(async () => fireEvent.change(field, { target: { value: fenced(grokReply()) } }));
    // Enter in the answer is a new line: nothing is read until the step's button.
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(4);
    expect(applies(state)).toEqual([]);
    await click(button("Ler a resposta"), 14);
    expect(heading()).toBe("Achei 2 agentes no Grok Bot");
    expect(applies(state).map((a) => a.dryRun)).toEqual([true]);

    await click(button("Trazer o time"), 24);
    const applied = applies(state).filter((a) => !a.dryRun);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.pick).toEqual(expect.arrayContaining(["agent:nina", "agent:leo", "channel:pesquisa"]));
    // Whatever model an agent ran on there, here it starts on the workspace's suggestion: the AI connected next
    // answers for all of them.
    expect(applied[0]?.bundle.agents.map((a) => a.model)).toEqual([null, null]);
    expect(state.agents.map((a) => a.name)).toEqual(expect.arrayContaining(["Nina", "Leo"]));
    // Self-hosted with no AI yet: the rail's last step.
    expect(heading()).toBe(CONNECT);
  });

  test("an app that hands back a file: the import's picker, Lodi saying to send it the request first", async () => {
    await open(settingUp());
    await click(answer("ChatGPT dots"), 4);
    await click(button("Trazer do ChatGPT dots"), 10);
    expect(heading()).toBe("Traga o seu time do ChatGPT dots");
    expect(document.querySelector(".onb__say")?.textContent).toBe(
      "Copie o pedido, cole no ChatGPT dots e traga a resposta. O resto é comigo.",
    );
  });

  test("an app that takes MCP: its steps, Lodi saying so, and the agents it creates move the rail on with no socket", async () => {
    const polls: (() => void)[] = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      if (ms === WATCH_POLL_MS) polls.push(fn);
      return realSetInterval(fn, ms);
    }) as typeof setInterval;
    try {
      const state = settingUp();
      const r = await open(state, withoutAi(createFakeApi(state), state));
      await click(answer("Hermes Agent"), 4);
      await click(button("Trazer do Hermes Agent"), 10);
      expect(heading()).toBe("Traga o seu time do Hermes Agent");
      expect(screen().getByRole("radio", { name: "Conectar com MCP" }).getAttribute("aria-checked")).toBe("true");
      expect(document.querySelector(".onb__say")?.textContent).toBe(
        "Siga os passos no app e ele mesmo cria os agentes aqui. Eu fico de olho.",
      );
      expect(text()).toContain("Esperando os agentes chegarem…");
      // The onboarding has no workspace socket: only the step's own reads find what the app made.
      const base = state.agents[0] as FakeState["agents"][number];
      state.agents.push({
        ...base,
        id: "a-nina",
        name: "Nina",
        handle: "nina",
        builtin: null,
        ownerUserId: state.me?.user.id ?? null,
      });
      expect(polls.length).toBeGreaterThan(0);
      await act(async () => {
        for (const poll of polls) poll();
      });
      await settle(24);
      expect(heading()).toBe(CONNECT);
      // The app may still be at it after the first one moved the rail on, with the step's own reads gone: the page
      // keeps reading the team.
      const query = r.services.queryClient.getQueryCache().find({ queryKey: keys.agents(ORG_ID) });
      if (!query) throw new Error("no agents query");
      const every = query.observers.map((o) => {
        const ms = o.options.refetchInterval;
        return typeof ms === "function" ? ms(query) : ms;
      });
      expect(every.some((ms) => typeof ms === "number" && ms > 0)).toBe(true);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test("on agentes.chat Cloud, before its first plan, an app that takes MCP brings its file and says why MCP waits", async () => {
    // A workspace on a hold refuses an app's sign-in: MCP couldn't bring anyone yet.
    await open(settingUp({ cloud: true }));
    await click(answer("Hermes Agent"), 4);
    await click(button("Trazer do Hermes Agent"), 10);
    expect(heading()).toBe("Traga o seu time do Hermes Agent");
    expect(screen().queryByRole("radiogroup", { name: "Como trazer" })).toBeNull();
    expect(text()).not.toContain("Esperando os agentes chegarem…");
    expect(document.querySelector(".imp-drop")).toBeTruthy();
    expect(text()).toContain(
      "Conectar com MCP funciona quando o plano do workspace estiver ativo. Por enquanto, traga os agentes por aqui.",
    );
    expect(document.querySelector(".onb__say")?.textContent).toBe("Solte aqui o que o app exportou. O resto é comigo.");
  });

  test("with MCP switched to the file, Lodi says to drop it again", async () => {
    await open(settingUp());
    await click(answer("Hermes Agent"), 4);
    await click(button("Trazer do Hermes Agent"), 10);
    await click(screen().getByRole("radio", { name: "Por arquivo" }), 4);
    expect(document.querySelector(".onb__say")?.textContent).toBe("Solte aqui o que o app exportou. O resto é comigo.");
  });

  test("on agentes.chat Cloud the team brought goes on to the plan", async () => {
    const state = settingUp({ cloud: true });
    await open(state);
    await throughTheAnswer(fenced(grokReply()));
    await click(button("Trazer o time"), 24);
    expect(heading()).toBe("Ligue o time");
  });

  test("an answer that isn't one says so, and nothing is planned", async () => {
    const state = settingUp();
    await open(state);
    await throughTheAnswer("Não sei exportar, desculpe.");
    expect(text()).toContain("Não reconhecemos esse texto.");
    expect(heading()).toBe("Traga o seu time do Grok Bot");
    expect(applies(state)).toEqual([]);
  });

  test("Prefer a new team, from the request, saves no agents yet and opens how a team starts", async () => {
    const state = settingUp();
    await open(state);
    await click(answer("Grok Bot"), 4);
    await click(button("Trazer do Grok Bot"), 10);
    await click(button("Prefiro montar um time novo"), 12);
    expect(calls(state, "orgs.saveOnboarding").map((c) => c.args)).toEqual([[ORG_ID, { step: "import" }]]);
    expect(heading()).toBe("Como você quer começar o time?");
    expect(answer(/Começar do zero/).getAttribute("aria-checked")).toBe("true");
  });

  test("something that stayed behind holds the step on the report until Continue", async () => {
    const state = settingUp();
    const api = withoutAi(createFakeApi(state), state);
    // The skill exists here already: the apply skips it.
    const real = api.imports.apply;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        const out = await real(orgId, input);
        if (input.dryRun) return out;
        return {
          items: out.items.map(
            (i): ImportItemResult =>
              i.kind === "skill" ? { kind: i.kind, key: i.key, label: i.label, action: "skip", reason: "exists" } : i,
          ),
        };
      },
    };
    await open(state, api);
    await throughTheAnswer(fenced(grokReply({ skills: true })));
    await click(button("Trazer o time"), 24);
    // The agents are here, and the step stays on what came and what didn't.
    expect(state.agents.map((a) => a.name)).toEqual(expect.arrayContaining(["Nina", "Leo"]));
    expect(text()).toContain("Chegaram 3 de 4");
    expect(heading()).toBe("Achei 2 agentes no Grok Bot");
    await click(button("Continuar"), 14);
    expect(heading()).toBe(CONNECT);
  });
});

describe("a personal workspace (ADR 0159)", () => {
  test("its agents brought from another app answer its team step, and the rail goes on", async () => {
    const state = settingUp({ personal: true });
    await open(state, withoutAi(createFakeApi(state), state));
    expect(heading()).toBe(ASK);
    expect(answer(/Ainda não uso nenhum/).closest("label")?.textContent).toContain(
      "A gente começa só nós dois. Os agentes vêm depois, quando você quiser.",
    );
    // That answer is its way on with no agents: no "Skip this step" beside it.
    expect(screen().queryByRole("button", { name: "Pular esta etapa" })).toBeNull();
    await click(answer("Grok Bot"), 4);
    await click(button("Trazer do Grok Bot"), 10);
    expect(heading()).toBe("Traga os seus agentes do Grok Bot");
    const field = screen().getByLabelText("Cole aqui a resposta do Grok Bot");
    await act(async () => fireEvent.change(field, { target: { value: fenced(grokReply()) } }));
    await click(button("Ler a resposta"), 14);
    await click(button("Trazer os agentes"), 24);
    expect(applies(state).filter((a) => !a.dryRun)).toHaveLength(1);
    // Its own words on the last step: no team in a personal workspace.
    expect(heading()).toBe("Conecte uma IA para os seus agentes pensarem");
    // Back on its agents, who is there now in words of its own.
    await click(button("Voltar"), 8);
    expect(heading()).toBe("Seus agentes");
    expect(document.querySelector(".onb__say")?.textContent).toBe(
      "Os seus agentes já estão aqui. Quando quiser, a gente segue.",
    );
  });
});
