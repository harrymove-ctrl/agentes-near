import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type AgentInput, ApiError, keys } from "@agenteschat/client";
import { en, ptBR } from "@agenteschat/i18n";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  freeHandle,
  handleProblem,
  presetChannels,
  presetLevels,
  ROLE_GROUPS,
  ROLE_IDS,
  ROLE_PRESETS,
  readBudget,
  stepErrors,
} from "@/lib/new-agent";
import { aiSelect, chooseAi, payWith } from "./ai-picker";
import {
  createFakeApi,
  ENG_ID,
  fakeMachinesOf,
  fakeMailOf,
  GENERAL_ID,
  meWithRole,
  OPENROUTER_KEY,
  OPENROUTER_MODELS,
  ORG_ID,
  seedState,
} from "./fake-api";
import { hintOf } from "./hint";
import {
  click,
  continueButton,
  pick,
  press,
  proceed,
  railStep,
  startAs,
  title,
  toReview,
  typeIn,
} from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const open = async (state = seedState(), api = createFakeApi(state)) => {
  await renderApp(`/org/${ORG_ID}/agents/new`, { api });
  await settle(8);
  return state;
};
const createdWith = (state: ReturnType<typeof seedState>) =>
  state.calls.find((c) => c.method === "agents.create")?.args[1] as AgentInput | undefined;

/** "Quem pensa" on the model step: its trigger reads the choice; its list, every model and plan, searched. */
const brainBox = () => screen().getByRole("combobox", { name: "Quem pensa" });
const openBrain = async () => {
  await click(brainBox());
  return screen().getByRole("listbox", { name: "Modelos" });
};
const chooseBrain = async (name: RegExp) => {
  await openBrain();
  await click(screen().getByRole("option", { name }));
};
const groupNames = (list: HTMLElement) =>
  within(list)
    .queryAllByRole("group")
    .map((g) => g.getAttribute("aria-label"));
const optionsIn = (list: HTMLElement, group: string) =>
  within(within(list).getByRole("group", { name: group })).getAllByRole("option");

describe("Criar agente: steps", () => {
  test("a focused flow: the rail with its steps instead of the sidebar; × and Cancelar leave", async () => {
    await open();
    expect(screen().queryByRole("navigation", { name: "Navegação do workspace" })).toBeNull();
    const rail = screen().getByRole("navigation", { name: "Passos para criar o agente" });
    expect(
      within(rail)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "1Papel",
      "2Identidade",
      "3Instruções",
      "4Ferramentas e acesso",
      "5Onde e quem",
      "6Modelo e orçamento",
      "7Revisar e criar",
    ]);
    expect(railStep("Papel").getAttribute("aria-current")).toBe("step");
    expect(railStep("Identidade").disabled).toBe(true);
    expect(screen().getByRole("link", { name: "Sair sem criar" }).getAttribute("href")).toBe(`/org/${ORG_ID}`);
    expect(screen().getByRole("link", { name: "Cancelar" }).getAttribute("href")).toBe(`/org/${ORG_ID}`);
    // One short lead under the title.
    expect(document.querySelector(".onb__lead")?.textContent).toBe(
      "Escolha um ponto de partida: o resto a gente preenche.",
    );
  });

  test("opened from a channel, × and Cancelar go back to that channel, as it was", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}?m=m-1`, { api: createFakeApi(seedState()) });
    await settle(6);
    await act(() => router.navigate({ to: "/org/$orgId/agents/new", params: { orgId: ORG_ID } }));
    await settle(8);
    const back = `/org/${ORG_ID}/c/${ENG_ID}?m=m-1`;
    expect(screen().getByRole("link", { name: "Sair sem criar" }).getAttribute("href")).toBe(back);
    expect(screen().getByRole("link", { name: "Cancelar" }).getAttribute("href")).toBe(back);
    await click(screen().getByRole("link", { name: "Cancelar" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(router.state.location.searchStr).toBe("?m=m-1");
    // Again, through the rail's ×, after a step forward.
    await act(() => router.navigate({ to: "/org/$orgId/agents/new", params: { orgId: ORG_ID } }));
    await settle(8);
    await click(screen().getByRole("button", { name: /^Do zero/ }));
    await click(screen().getByRole("link", { name: "Sair sem criar" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });

  test("the preview waits for something in it: a template, or the first thing typed; never all empty", async () => {
    await open();
    const preview = () => screen().queryByRole("complementary", { name: "Prévia do agente" });
    expect(preview()).toBeNull();
    // Do zero alone has nothing to show yet: no preview.
    await click(screen().getByRole("button", { name: /^Do zero/ }));
    expect(title()).toBe("Qual vai ser o papel?");
    expect(preview()).toBeNull();
    await typeIn(screen().getByLabelText("Cargo"), "Pesquisa de preços");
    expect(preview()?.textContent).toContain("Pesquisa de preços");
    // A template shows it on the role step itself: QA starts as Iris.
    await click(screen().getByRole("button", { name: /^QA/ }));
    expect(preview()?.textContent).toContain("Iris");
    // Headed by its name alone. It says which step it's on: a narrow screen keeps it out of the role step.
    expect(document.querySelector(".newag__cap")?.textContent).toBe("Prévia");
    expect(preview()?.getAttribute("data-step")).toBe("role");
    await proceed();
    expect(preview()?.getAttribute("data-step")).toBe("identity");
  });

  test("what a step needs explained: the instructions' and the budget's ⓘ; the tools keep the approval line", async () => {
    await open();
    await startAs("QA");
    await proceed();
    expect(title()).toBe("O que a Iris faz");
    const hint = (name: string) =>
      document.getElementById(screen().getByRole("button", { name }).getAttribute("aria-describedby") ?? "")
        ?.textContent;
    expect(hint("Sobre O que a Iris faz")).toBe(
      "O contexto da Acme (o que a empresa faz, regras da casa) entra antes destas instruções em toda conversa: escreva aqui só o que é da Iris.",
    );
    expect(document.querySelector(".newag__note")).toBeNull();
    await proceed();
    expect(document.querySelector(".onb__lead")?.textContent).toBe("Escolha até onde a Iris vai em cada app.");
    expect(document.querySelector(".newag__note")?.textContent).toBe(
      "Merge, deploy e rollback sempre pedem aprovação no chat. Quem aprova é Walter.",
    );
    await proceed(2);
    expect(title()).toBe("Modelo e orçamento");
    expect(hint("Sobre Orçamento mensal")).toBe("Ao atingir o limite, a Iris para e avisa. Avisamos Walter aos 80%.");
    expect(screen().getByText(/^Vazio: o padrão do workspace/).textContent).toBe(
      "Vazio: o padrão do workspace (US$\u00a050).",
    );
  });

  test("a role is required; picking one fills the rest (name, @, look, instructions, levels, channels, model)", async () => {
    const state = await open();
    expect(title()).toBe("Qual vai ser o papel?");
    await click(continueButton());
    expect(title()).toBe("Qual vai ser o papel?");
    expect(screen().getAllByText("Escolha um papel ou comece do zero.").length).toBeGreaterThan(0);
    expect(continueButton().getAttribute("aria-disabled")).toBe("true");

    await startAs("QA");
    expect(title()).toBe("Quem é");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("Iris");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("iris");
    expect(screen().getByRole("button", { name: "Violeta" }).getAttribute("aria-pressed")).toBe("true");
    expect(
      screen()
        .getByRole("button", { name: /^Headset/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const preview = screen().getByRole("complementary", { name: "Prévia do agente" });
    expect(preview.textContent).toContain("Iris");
    expect(preview.textContent).toContain("@iris");

    await proceed();
    expect(title()).toBe("O que a Iris faz");
    expect((screen().getByLabelText("Instruções") as HTMLTextAreaElement).value).toStartWith(
      "Reproduz cada bug relatado antes de abrir uma tarefa.",
    );

    await proceed();
    const github = within(screen().getByRole("list", { name: "Conectores e níveis" })).getByRole("radiogroup", {
      name: "Nível em GitHub",
    });
    // QA reads GitHub (the preset), nothing writes.
    expect(within(github).getByRole("radio", { name: "Ler" }).getAttribute("aria-checked")).toBe("true");

    await proceed();
    // The role's channels among yours: #eng for QA, not #general.
    expect(screen().getByRole("checkbox", { name: "#eng" }).getAttribute("aria-checked")).toBe("true");
    expect(screen().getByRole("checkbox", { name: "#general" }).getAttribute("aria-checked")).toBe("false");

    await proceed();
    // "Automático" comes first and is chosen for every role; the fixed models follow. A select shows only its choice.
    expect(brainBox().textContent).toBe("Automático");
    const list = await openBrain();
    const [auto, ...rest] = within(list).getAllByRole("option");
    expect(auto?.getAttribute("aria-selected")).toBe("true");
    const sonnet = screen().getByRole("option", { name: /^Claude Sonnet 5\.5/ });
    expect(sonnet.getAttribute("aria-selected")).toBe("false");
    expect(rest.indexOf(sonnet)).toBeGreaterThanOrEqual(0);
    // Claude's models by what each is for, as on the agent's page; a model without a key can't be picked.
    expect(sonnet.textContent).toContain("Recomendado para a maioria");
    const gpt = screen().getAllByRole("option", { name: /^GPT-5/ })[0] as HTMLElement;
    expect(gpt.getAttribute("aria-disabled")).toBe("true");
    expect(gpt.textContent).toContain("Precisa de uma chave de API OpenAI");
    await click(gpt);
    expect(brainBox().textContent).toStartWith("Automático");
    await press(screen().getByRole("combobox", { name: "Buscar modelos" }), "Escape");

    await proceed();
    expect(title()).toBe("Tudo certo com a Iris?");
    expect(document.querySelector(".newag__review")?.textContent).toContain("Automático ·");
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({
      name: "Iris",
      handle: "iris",
      role: "QA",
      model: "auto",
      appearance: { color: "violet", eyes: "round", accessory: "headset" },
    });
  });

  test("from a channel's Adicionar (?channel=): that channel stays picked beside the role's", async () => {
    await renderApp(`/org/${ORG_ID}/agents/new?channel=${GENERAL_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    await startAs("QA");
    await proceed(3);
    expect(screen().getByRole("checkbox", { name: "#eng" }).getAttribute("aria-checked")).toBe("true");
    expect(screen().getByRole("checkbox", { name: "#general" }).getAttribute("aria-checked")).toBe("true");
  });

  test("roles for any team, in groups (tech, customers, operations); Do zero first", async () => {
    await open();
    const step = screen().getByRole("group", { name: "Papel" });
    expect(
      within(step)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["Produto e tecnologia", "Clientes", "Operação"]);
    const names = (heading: string) =>
      within(within(step).getByRole("region", { name: heading }))
        .getAllByRole("button")
        .map((b) => b.querySelector(".newag__role-name b")?.textContent);
    expect(names("Produto e tecnologia")).toEqual(["Dev", "Ops", "QA", "PM"]);
    expect(names("Clientes")).toEqual(["Atendimento", "Vendas", "Marketing", "Conteúdo"]);
    expect(names("Operação")).toEqual(["Dados", "Financeiro", "Pessoas", "Pesquisa", "Assistente"]);
    expect(within(step).getAllByRole("button")[0]?.textContent).toContain("Do zero");
    // Every card, Do zero too, opens on its tile with the name and its line centred beside it (no cap-top rise).
    const firstRows = [...step.querySelectorAll(".newag__role")].map(
      (card) => [...card.children].find((c) => !c.classList.contains("newag__check"))?.className,
    );
    expect(firstRows).toEqual(ROLE_IDS.map(() => "newag__role-head"));
    expect(step.querySelector(".newag__role .ac-captop, .newag__role .ac-faceline")).toBeNull();
    const css = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
    expect(css).toMatch(/\n\.newag__role-head \{\s*display: flex;\s*align-items: center;/);
    // Smaller tiles than a profile's 56px face, the + as big as a face.
    expect(css).toMatch(/\n\.newag__role-head > \.ac-avatar \{\s*width: 44px;\s*height: 44px;/);
    expect(css).toMatch(/\n\.newag__blank-icon \{[^}]*width: 44px;\s*height: 44px;/);

    // Do zero's Cargo comes right under its card, in the same column with the cards' gap, before the templates; the
    // field has the focus, and its hint doesn't ask for one short word.
    await click(within(step).getByRole("button", { name: /^Do zero/ }));
    const scratch = step.querySelector(".newag__scratch");
    expect([...(scratch?.children ?? [])].map((c) => c.className)).toEqual([
      "newag__role newag__role--blank",
      expect.stringContaining("newag__card"),
    ]);
    expect(scratch?.nextElementSibling?.tagName).toBe("SECTION");
    expect(css).toMatch(/\n\.newag__scratch \{[^}]*gap: 12px;/);
    expect(document.activeElement === screen().getByLabelText("Cargo")).toBe(true);
    expect(screen().getByText("O que ele faz pelo time, ex.: Assistente de e-mails e agenda.")).toBeTruthy();

    // A role outside engineering fills the rest the same way.
    await click(within(step).getByRole("button", { name: /^Atendimento/ }));
    await proceed();
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("Nina");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("nina");
    await proceed();
    expect(title()).toBe("O que a Nina faz");
    expect((screen().getByLabelText("Instruções") as HTMLTextAreaElement).value).toContain(
      "Enviar mensagem ao cliente, reembolso e desconto só com aprovação.",
    );
  });

  test("Trazer agentes de outro app: the import flow in place of the cards, Voltar (or Esc) back to them", async () => {
    const state = await open();
    await click(screen().getByRole("button", { name: "Trazer agentes de outro app" }));
    // Still here (the rail on its first step): the import's sources in the cards' place, no preview, no Continuar.
    expect(title()).toBe("Trazer agentes de outro app");
    expect(railStep("Papel").getAttribute("aria-current")).toBe("step");
    expect(document.activeElement === screen().getByRole("heading", { level: 1 })).toBe(true);
    expect(screen().getByRole("group", { name: "De onde vêm os agentes" })).toBeTruthy();
    expect(screen().queryByRole("group", { name: "Papel" })).toBeNull();
    expect(screen().queryByRole("complementary", { name: "Prévia do agente" })).toBeNull();
    expect(screen().queryByRole("button", { name: /^Continuar/ })).toBeNull();
    // Enter in its field reads what's there, never moves the steps on.
    const field = screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app");
    await press(field, "Enter");
    expect(title()).toBe("Trazer agentes de outro app");

    // A pasted reply: planned, then Importar brings the agent, and the report links to it.
    const reply = {
      format: "agenteschat.bundle",
      version: 1,
      source: { app: "claude", ref: "my-bots", name: "Minhas automações", files: [] },
      agents: [
        {
          key: "news",
          name: "Newsy",
          handle: "news",
          role: "Notícias do dia",
          instructions: "Resume as notícias do dia.",
          model: null,
          appearance: {},
          skills: [],
        },
      ],
      skills: [],
      channels: [],
      routines: [],
      notes: [],
      todo: [],
      leftOut: [],
    };
    const pasted = `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``;
    await act(async () => fireEvent.paste(field, { clipboardData: { getData: () => pasted } }));
    await settle(10);
    expect(screen().getByRole("heading", { name: "Minhas automações" })).toBeTruthy();
    await click(screen().getByRole("button", { name: /^Importar 1 / }));
    await settle(8);
    expect(state.calls.some((c) => c.method === "imports.apply" && !(c.args[1] as { dryRun?: boolean }).dryRun)).toBe(
      true,
    );
    const link = screen().getByRole("link", { name: /Newsy/ });
    expect(link.getAttribute("href")).toMatch(new RegExp(`^/org/${ORG_ID}/agents/`));

    // Voltar goes back to the cards; so does Esc outside a field.
    await click(screen().getByRole("button", { name: "Voltar" }));
    expect(title()).toBe("Qual vai ser o papel?");
    expect(screen().getByRole("group", { name: "Papel" })).toBeTruthy();
    await click(screen().getByRole("button", { name: "Trazer agentes de outro app" }));
    await press(document.body, "Escape");
    expect(title()).toBe("Qual vai ser o papel?");
  });

  test("the rail during an import leaves it: the step it goes to is whole (Continuar, Enter)", async () => {
    await open();
    await startAs("Assistente");
    expect(title()).toBe("Quem é");
    await click(screen().getByRole("button", { name: "Voltar" }));
    await click(screen().getByRole("button", { name: "Trazer agentes de outro app" }));
    expect(title()).toBe("Trazer agentes de outro app");
    await click(railStep("Identidade"));
    expect(title()).toBe("Quem é");
    expect(screen().getByRole("button", { name: /^Continuar/ })).toBeTruthy();
    await press(document.body, "Enter");
    expect(title()).not.toBe("Quem é");
  });

  test("Dev starts as Ada, whose @ is taken: the error suggests a free one and blocks the step", async () => {
    await open();
    await startAs("Dev");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("ada");
    expect(document.body.textContent).toContain("@ada já é de outro agente ou pessoa. Que tal @ada-2?");
    await click(continueButton());
    expect(title()).toBe("Quem é");
    await typeIn(screen().getByLabelText("No chat"), "Ada 2!");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("ada2");
    // A person's @ is taken too.
    await typeIn(screen().getByLabelText("No chat"), "joao");
    expect(document.body.textContent).toContain("@joao já é de outro agente ou pessoa.");
    await typeIn(screen().getByLabelText("No chat"), "-x");
    expect(document.body.textContent).toContain("Use de 2 a 32 letras minúsculas");
    await typeIn(screen().getByLabelText("No chat"), "ada-dev");
    // The name no longer drives a handle someone edited.
    await typeIn(screen().getByLabelText("Nome"), "Ada Maria");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("ada-dev");
    await proceed();
    expect(title()).toBe("O que a Ada Maria faz");
  });

  test("an empty name and @ only complain after trying to go on", async () => {
    await open();
    await startAs("Do zero");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("Dê um nome ao agente.");
    await click(continueButton());
    expect(title()).toBe("Quem é");
    expect(document.body.textContent).toContain("Dê um nome ao agente.");
    expect(document.body.textContent).toContain("Escolha um @ para o agente.");
    await typeIn(screen().getByLabelText("Nome"), "Íris B.");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("irisb");
    expect(document.body.textContent).not.toContain("Dê um nome ao agente.");
  });

  test("keyboard: Enter continues, ⌘/Ctrl+Enter inside the instructions, Esc goes back; visited steps are clickable", async () => {
    await open();
    await click(screen().getByRole("button", { name: /^PM/ }));
    await press(document.body, "Enter");
    expect(title()).toBe("Quem é");
    // Enter in a field continues.
    await press(screen().getByLabelText("Nome"), "Enter");
    expect(title()).toBe("O que o Theo faz");
    // A plain Enter in the instructions is a new line; ⌘↵ / Ctrl+↵ continues.
    const ta = screen().getByLabelText("Instruções");
    await press(ta, "Enter");
    expect(title()).toBe("O que o Theo faz");
    await press(ta, "Enter", { ctrlKey: true });
    expect(title()).toBe("Ferramentas e acesso");
    // Esc in a field only leaves it; Esc elsewhere goes back.
    await press(screen().getByRole("heading", { level: 1 }), "Escape");
    expect(title()).toBe("O que o Theo faz");
    // Steps already reached are on the rail; later ones aren't yet.
    expect(railStep("Ferramentas e acesso").disabled).toBe(false);
    expect(railStep("Onde e quem").disabled).toBe(true);
    await click(railStep("Papel"));
    expect(title()).toBe("Qual vai ser o papel?");
    expect(railStep("Papel").getAttribute("aria-current")).toBe("step");
    await click(railStep("Ferramentas e acesso"));
    expect(title()).toBe("Ferramentas e acesso");
    // Esc on the first step stays.
    await click(railStep("Papel"));
    await press(document.body, "Escape");
    expect(title()).toBe("Qual vai ser o papel?");
  });

  test("on a touch screen or at phone width, the instructions' ⌘↵ hint goes with its keys", async () => {
    await open();
    await startAs("PM");
    await proceed();
    expect(title()).toBe("O que o Theo faz");
    const hint = document.querySelector(".newag__hint");
    expect(hint?.querySelectorAll(":scope > kbd.ac-kbd")).toHaveLength(2);
    expect(hint?.textContent).toContain("continua daqui");
    const css = await Bun.file(new URL("../src/responsive.css", import.meta.url).pathname).text();
    const touch = css.split("\n@media (max-width: 760px), (pointer: coarse) {")[1]?.split("\n}")[0] ?? "";
    expect(touch).toMatch(/\.newag__hint:has\(> \.ac-kbd\) \{\s*display: none;/);
  });

  test("Revisar e criar: each section has Editar, which goes to its step", async () => {
    await open();
    await startAs("PM");
    await toReview();
    const content = () => screen().getByRole("heading", { level: 1 }).closest(".newag__content") as HTMLElement;
    expect(title()).toBe("Tudo certo com o Theo?");
    expect(content().textContent).toContain("PM · Organiza tarefas e resumos.");
    expect(content().textContent).toContain("@theo");
    // The title says it all: no lead, and no note under the summary.
    expect(content().querySelector(".onb__lead, .newag__note")).toBeNull();
    await click(within(content()).getByRole("button", { name: "Editar Modelo e custo" }));
    expect(title()).toBe("Modelo e orçamento");
    await proceed();
    await click(within(content()).getByRole("button", { name: "Editar Instruções" }));
    expect(title()).toBe("O que o Theo faz");
  });
});

describe("Criar agente: what gets created", () => {
  test("levels: one access write after creation, the chosen connectors kept", async () => {
    const state = await open();
    await startAs("QA");
    await proceed(2);
    const github = within(screen().getByRole("list", { name: "Conectores e níveis" })).getByRole("radiogroup", {
      name: "Nível em GitHub",
    });
    await click(within(github).getByRole("radio", { name: "Ler e escrever" }));
    // Writing: the sensitive action shows as asking for approval.
    expect(screen().getByRole("list", { name: "Conectores e níveis" }).textContent).toContain(
      "Fazer merge pede aprovação",
    );
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts).toHaveLength(1);
    const body = puts[0]?.args[2] as { connectors: Record<string, boolean> };
    expect(body.connectors).toEqual({ "conn-gh": true });
  });

  test("model: a fixed model can replace Automático; it is what gets created and reviewed", async () => {
    const state = await open();
    await startAs("Assistente");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    await chooseBrain(/^Claude Sonnet 5\.5/);
    expect(brainBox().textContent).toStartWith("Claude Sonnet 5.5");
    await proceed();
    expect(document.querySelector(".newag__review")?.textContent).toContain("Claude Sonnet 5.5 ·");
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(state)?.model).toBe("claude-sonnet-5-5");
  });

  test("model: OpenRouter's good picks first under their heading; a pick is what gets created", async () => {
    const seeded = seedState({ extraModels: OPENROUTER_MODELS });
    seeded.credentials.push(OPENROUTER_KEY);
    const state = await open(seeded);
    await startAs("Assistente");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    const list = await openBrain();
    expect(
      optionsIn(list, "OpenRouter · Boas escolhas").map((o) => o.querySelector(".ac-menu__label span")?.textContent),
    ).toEqual(["Z.ai: GLM Latest", "DeepSeek: DeepSeek Flash Latest", "Claude Sonnet Latest"]);
    await click(screen().getByRole("option", { name: /^Z\.ai: GLM Latest/ }));
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(state)?.model).toBe("~z-ai/glm-latest");
  });

  const plan = (kind: "claude_code" | "codex", available: boolean) => ({
    kind,
    available,
    ...(available ? {} : { reason: "not_installed" as const }),

    models: [],
    defaultModel: null,
  });

  test("plan: with no key, Claude Code on a computer can think; the agent moves there and thinks with it", async () => {
    const state = seedState();
    state.credentials = [];
    state.platformKey = false;
    state.brainMachines = [
      {
        machineId: "machine_mini",
        name: "Mac mini",
        online: true,
        options: [plan("claude_code", true), plan("codex", false)],
      },
    ];
    const api = createFakeApi(state);
    // The Mac mini is his, its Claude Code signed in there: its own sign-in thinks for his agents.
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [],
      computers: [
        {
          machineId: "machine_mini",
          name: "Mac mini",
          online: true,
          mine: true,
          canAdd: true,
          keys: true,
          brains: { claude_code: true, codex: false },
          own: { claude_code: {} },
        },
      ],
    });
    await open(state, api);
    await startAs("Assistente");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    // No key: the API can't think, and Codex isn't on any computer. Nothing blocks: Connect is right here.
    expect(
      screen().getByText("O workspace ainda não tem uma IA. Conecte uma agora, ou crie o agente e conecte depois."),
    ).toBeTruthy();
    const list = await openBrain();
    expect(optionsIn(list, "Plano do ChatGPT")[0]?.textContent).toBe("ChatGPTIndisponível");
    expect(optionsIn(list, "Plano do ChatGPT")[0]?.getAttribute("aria-disabled")).toBe("true");
    // The workspace's only computer: the heading doesn't name it.
    expect(groupNames(list)).toContain("Plano do Claude");
    const claude = optionsIn(list, "Plano do Claude")[0] as HTMLElement;
    expect(claude.textContent).toBe("AutomáticoUsa o plano do Claude de quem conectou o computador.");
    await click(claude);
    expect(brainBox().textContent).toStartWith("Plano do Claude");
    expect(
      screen().queryByText("O workspace ainda não tem uma IA. Conecte uma agora, ou crie o agente e conecte depois."),
    ).toBeNull();
    // In the words of the switch it points to, "Atende outras pessoas".
    expect(
      screen().getByText(
        "No plano, a Eva começa atendendo só você. Na página da Eva, você pode escolher se ela atende outras pessoas.",
      ),
    ).toBeTruthy();
    await proceed();
    expect(document.querySelector(".newag__review")?.textContent).toContain("Plano do Claude");
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args).toEqual([ORG_ID, agentId, "machine_mini"]);
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code" },
    ]);
    // It thinks with the Mac mini's own sign-in: nothing to connect.
    expect(screen().queryByRole("dialog", { name: /^Conectar uma IA/ })).toBeNull();
  });

  /** A workspace with nothing to think with: no key, no platform key, no computer. */
  const noAi = () => {
    const state = seedState();
    state.credentials = [];
    state.platformKey = false;
    state.brainMachines = [];
    return state;
  };
  const NO_AI = "O workspace ainda não tem uma IA. Conecte uma agora, ou crie o agente e conecte depois.";

  test("no AI yet: the model step connects one in place, and comes back with every field as it was", async () => {
    const state = noAi();
    await open(state);
    await startAs("Assistente");
    await typeIn(screen().getByLabelText("Nome"), "Lia");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    await typeIn(screen().getByLabelText(/^Orçamento/), "12");
    expect(screen().getByText(NO_AI)).toBeTruthy();
    await click(screen().getByRole("button", { name: "Conectar uma IA" }));
    await settle(6);
    const box = screen().getByRole("dialog", { name: "Conectar uma IA" });
    // A plan for the agent being made (never one of theirs): a computer to connect opens beside the draft.
    await chooseAi(box, "Claude");
    const panel = within(box).getByRole("region", { name: "Seu plano do Claude" });
    const opened: unknown[][] = [];
    const realOpen = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      await click(within(panel).getByRole("button", { name: "Conectar um computador" }));
    } finally {
      window.open = realOpen;
    }
    expect(opened).toEqual([[`/org/${ORG_ID}/settings/devices`, "_blank", "noopener"]]);
    await click(payWith(box, "Com chave de API"));
    await act(async () =>
      fireEvent.change(within(box).getByLabelText("Cole aqui"), {
        target: { value: "sk-ant-api03-abcdefghijklmnop1234" },
      }),
    );
    await click(within(box).getByRole("button", { name: "Salvar chave" }));
    await settle(8);
    await click(within(box).getByRole("button", { name: "Pronto" }));
    await settle(6);
    // Back where it was: the same step, the name and the budget kept, and the key thinks for it now.
    expect(screen().queryByRole("dialog", { name: "Conectar uma IA" })).toBeNull();
    expect(title()).toBe("Modelo e orçamento");
    expect((screen().getByLabelText(/^Orçamento/) as HTMLInputElement).value).toBe("12");
    expect(screen().queryByText(NO_AI)).toBeNull();
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Lia" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({ name: "Lia", model: "auto", monthlyBudgetUsd: 12 });
    expect(screen().queryByRole("dialog", { name: /^Conectar uma IA/ })).toBeNull();
  });

  test("no AI yet: the plan connected in place is for the agent being made, never one they already have", async () => {
    const state = noAi();
    for (const a of state.agents) a.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [],
      computers: [
        {
          machineId: "machine_mini",
          name: "Mac mini",
          online: true,
          mine: true,
          canAdd: true,
          keys: true,
          brains: { claude_code: true, codex: false },
        },
      ],
    });
    await open(state, api);
    await startAs("Assistente");
    await proceed(4);
    await click(screen().getByRole("button", { name: "Conectar uma IA" }));
    await settle(6);
    const box = screen().getByRole("dialog", { name: "Conectar uma IA" });
    const panel = within(box).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Os agentes que você criar pensam com ele.");
  });

  test("with the workspace's key too: Conectar uma IA is right there, and the plan it connects is what it thinks with", async () => {
    const state = seedState();
    state.agents = [];
    // The workspace's key is OpenAI's: Claude's models need a Claude key until a Claude plan is here.
    state.credentials = state.credentials.map((c) => ({ ...c, provider: "openai", label: "OpenAI da Acme" }));
    state.brainMachines = [];
    const api = createFakeApi(state);
    const mini = {
      machineId: "machine_mini",
      name: "Mac mini",
      online: true,
      mine: true,
      canAdd: true,
      keys: true,
      brains: { claude_code: true, codex: false },
    };
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [], computers: [mini] });
    const { services } = await renderApp(`/org/${ORG_ID}/agents/new`, { api });
    await settle(8);
    await startAs("Assistente");
    await typeIn(screen().getByLabelText("Nome"), "Lia");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    expect(screen().queryByText(NO_AI)).toBeNull();
    let list = await openBrain();
    expect(within(list).getAllByRole("option", { name: /Precisa de uma chave de API Claude/ }).length).toBeGreaterThan(
      0,
    );
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" }));
    await settle(2);
    // An API model picked first: connecting a plan here still moves the agent onto it.
    await chooseBrain(/^GPT-5 US/);
    await click(screen().getByRole("button", { name: "Conectar uma IA" }));
    await settle(6);
    const box = screen().getByRole("dialog", { name: "Conectar uma IA" });
    // The same choices as Settings › Contas de IA and the setup, for the agents they create.
    expect(aiSelect(box).textContent).toBe("Claude");
    expect(payWith(box, "Com chave de API")).toBeTruthy();
    const panel = within(box).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Os agentes que você criar pensam com ele.");
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" }));
    await settle(2);
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [
        {
          id: "acct_1",
          kind: "claude_code",
          label: "Claude",
          email: "walter@acme.com.br",
          plan: "max",
          status: "active",
          ownerId: "u-walter",
          ownerName: "Walter",
          mine: true,
          usedBy: [],
          usage: null,
          provider: null,
          keyHint: null,
          machineId: "machine_mini",
          computer: "Mac mini",
        },
      ],
      computers: [mini],
    });
    state.brainMachines = [
      { machineId: "machine_mini", name: "Mac mini", online: true, options: [plan("claude_code", true)] },
    ];
    await act(async () => {
      await services.queryClient.invalidateQueries({ queryKey: keys.aiAccounts(ORG_ID) });
      await services.queryClient.invalidateQueries({ queryKey: keys.brainMachines(ORG_ID) });
    });
    await settle(8);
    // The draft kept, the plan chosen, and its models listed as the plan's, ready.
    expect(brainBox().textContent).toStartWith("Plano do Claude");
    list = await openBrain();
    expect(within(list).queryByRole("option", { name: /Precisa de uma chave de API Claude/ })).toBeNull();
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" }));
    await settle(2);
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Lia" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "lia")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code", account: "acct_1" },
    ]);
  });

  test("no AI yet: the agent is created all the same, and Connect opens for it", async () => {
    const state = noAi();
    await open(state);
    await startAs("Assistente");
    await proceed(5);
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(state)?.name).toBe("Eva");
    expect(screen().getByRole("dialog", { name: "Conectar uma IA para a Eva" })).toBeTruthy();
  });

  test("no AI yet but a plan of theirs on a computer: it thinks with that plan", async () => {
    const state = noAi();
    state.brainMachines = [
      { machineId: "machine_mini", name: "Mac mini", online: true, options: [plan("claude_code", true)] },
    ];
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [
        {
          id: "acct_1",
          kind: "claude_code",
          label: "Claude",
          email: "walter@acme.com.br",
          plan: "max",
          status: "active",
          ownerId: "u-walter",
          ownerName: "Walter",
          mine: true,
          usedBy: [],
          usage: null,
          provider: null,
          keyHint: null,
          shared: true,
          machineId: "machine_mini",
          computer: "Mac mini",
        },
      ],
      computers: [
        {
          machineId: "machine_mini",
          name: "Mac mini",
          online: true,
          mine: false,
          canAdd: true,
          keys: true,
          brains: { claude_code: true, codex: false },
        },
      ],
    });
    await open(state, api);
    await startAs("Assistente");
    await proceed(4);
    expect(brainBox().textContent).toStartWith("Plano do Claude");
    expect(screen().queryByText(NO_AI)).toBeNull();
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code", account: "acct_1" },
    ]);
  });

  test("a plan account of theirs and no last setup: it thinks with their plan, over the workspace's key", async () => {
    const state = seedState();
    state.brainMachines = [
      { machineId: "machine_mini", name: "Mac mini", online: true, options: [plan("claude_code", true)] },
    ];
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [
        {
          id: "acct_1",
          kind: "claude_code",
          label: "Claude",
          email: "walter@acme.com.br",
          plan: "max",
          status: "active",
          ownerId: "u-walter",
          ownerName: "Walter",
          mine: true,
          usedBy: [],
          usage: null,
          provider: null,
          keyHint: null,
          machineId: "machine_mini",
          computer: "Mac mini",
        },
      ],
      computers: [],
    });
    await open(state, api);
    await startAs("Assistente");
    await proceed(4);
    expect(brainBox().textContent).toStartWith("Plano do Claude");
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code", account: "acct_1" },
    ]);
  });

  test("plan: with more than one computer, each plan's heading names its own", async () => {
    const state = seedState();
    state.brainMachines = [
      {
        machineId: "machine_1",
        name: "MacBook",
        online: true,
        options: [plan("claude_code", true), plan("codex", false)],
      },
      {
        machineId: "machine_mini",
        name: "Mac mini",
        online: false,
        options: [plan("claude_code", true), plan("codex", false)],
      },
    ];
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    const list = await openBrain();
    expect(groupNames(list).filter((g) => g?.startsWith("Plano do"))).toEqual([
      "Plano do Claude · MacBook",
      "Plano do Claude · Mac mini · offline",
      "Plano do ChatGPT",
    ]);
    expect(optionsIn(list, "Plano do ChatGPT")[0]?.textContent).toBe("ChatGPTIndisponível");
  });

  test("plan: Cursor shows only where a computer runs it, with Cursor's mark (ADR 0114)", async () => {
    const state = seedState();
    state.brainMachines = [
      {
        machineId: "machine_1",
        name: "MacBook",
        online: true,
        options: [plan("claude_code", true), plan("codex", false), { ...plan("codex", true), kind: "cursor" as const }],
      },
    ];
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    const list = await openBrain();
    const cursor = optionsIn(list, "Plano do Cursor")[0] as HTMLElement;
    expect(cursor.querySelector(".ac-brand[data-mark='cursor']")).not.toBeNull();
    expect(cursor.textContent).toContain("Usa o plano do Cursor de quem conectou o computador.");
  });

  test("plan: OpenCode Go's models in the same list, its free ones found by 'free'; a model of it is what thinks", async () => {
    const state = seedState();
    state.brainMachines = [
      {
        machineId: "machine_1",
        name: "MacBook",
        online: true,
        options: [plan("claude_code", true), plan("codex", false)],
      },
    ];
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [
        {
          id: "acc-go",
          kind: "claude_code",
          label: "OpenCode Go",
          email: null,
          plan: null,
          status: "active",
          ownerId: state.me?.user.id ?? null,
          ownerName: "Ana",
          mine: true,
          usedBy: [],
          usage: null,
          provider: "opencode",
          keyHint: "abcd",
          machineId: "machine_1",
          computer: "MacBook",
        },
      ],
      computers: [],
    });
    await open(state, api);
    await startAs("Assistente");
    await proceed(4);
    const list = await openBrain();
    expect(optionsIn(list, "OpenCode Go")).toHaveLength(32);
    await typeIn(screen().getByRole("combobox", { name: "Buscar modelos" }), "free");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "LongCat 2.5 FreeGrátis",
      "Beam FreeGrátis",
      "Crouton Alpha FreeGrátis",
      "Iceman Contributor FreeGrátis",
    ]);
    await typeIn(screen().getByRole("combobox", { name: "Buscar modelos" }), "deepseek flash");
    await click(screen().getByRole("option", { name: /^DeepSeek V4\.1 Flash/ }));
    expect(brainBox().textContent).toStartWith("DeepSeek V4.1 Flash pelo OpenCode Go");
    // What its account must allow, before it's created.
    expect(screen().getByText(/Ligue a região Global no OpenCode/)).toBeTruthy();
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code", account: "acc-go", model: "deepseek-v4.1-flash" },
    ]);
  });

  test("plan: a coding plan with no key yet is one pick; Connect opens on it once the agent exists", async () => {
    const state = seedState();
    state.brainMachines = [
      {
        machineId: "machine_1",
        name: "MacBook",
        online: true,
        options: [plan("claude_code", true), plan("codex", false)],
      },
    ];
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    const list = await openBrain();
    const models = optionsIn(list, "OpenCode Go");
    expect(models[0]?.textContent).toBe(
      "Conectar OpenCode GoPrecisa de uma chave OpenCode Go. Você coloca logo depois de criar o agente.",
    );
    expect(models.slice(1).every((o) => o.getAttribute("aria-disabled") === "true")).toBe(true);
    await click(models[0] as HTMLElement);
    expect(brainBox().textContent).toStartWith("OpenCode Go");
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(state)?.model).toBe("auto");
    expect(state.calls.some((c) => c.method === "agents.setBrain")).toBe(false);
    expect(screen().getByRole("dialog", { name: /^Conectar uma IA para .*Eva$/ })).toBeTruthy();
  });

  test("plan: Codex on the workspace's computer, whose own sign-in thinks for nobody: ChatGPT's sign-in opens once it's created", async () => {
    const state = seedState();
    state.credentials = [];
    state.platformKey = false;
    state.brainMachines = [
      {
        machineId: "machine_1",
        name: "Computador da Acme",
        online: true,
        options: [plan("claude_code", true), plan("codex", true)],
      },
    ];
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    const list = await openBrain();
    expect(groupNames(list)).toContain("Plano do ChatGPT");
    await click(optionsIn(list, "Plano do ChatGPT")[0] as HTMLElement);
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "codex" },
    ]);
    // Nobody signed in to ChatGPT there: Connect an AI for Eva, on ChatGPT, over the moment she's created.
    const d = screen().getByRole("dialog", { name: /^Conectar uma IA para .*Eva$/ });
    expect(aiSelect(d).textContent).toBe("ChatGPT");
  });

  test("the last setup (ADR 0094): a plan of mine starts chosen, said on the model step, saved with all of it", async () => {
    const state = seedState();
    state.brainMachines = [
      {
        machineId: "machine_mini",
        name: "Mac mini",
        online: true,
        options: [
          { ...plan("claude_code", true), models: [{ value: "opus", label: "Opus" }], defaultModel: "sonnet" },
          plan("codex", false),
        ],
      },
    ];
    state.newAgentSetup = {
      brain: "claude_code",
      model: "opus",
      key: null,
      contextTokens: null,
      computer: { machineId: "machine_mini", name: "Mac mini" },
      account: { id: "acc-1", label: "Claude", provider: null, mine: true, free: true },
      ownSignIn: false,
      effort: "high",
      fallback: true,
    };
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    // Its account isn't one of the list's choices: the trigger names the plan as it was.
    expect(brainBox().textContent).toBe("Claude Code · Claude");
    expect(screen().getByText("Começa com a última escolha: Opus pelo plano do Claude · Esforço alto.")).toBeTruthy();
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code", account: "acc-1", model: "opus", effort: "high", contextTokens: null, fallback: true },
    ]);
  });

  test("the last setup's plan with another model of it picked: that model is saved, not the last one's", async () => {
    const state = seedState();
    state.brainMachines = [
      {
        machineId: "machine_mini",
        name: "Mac mini",
        online: true,
        options: [
          {
            ...plan("claude_code", true),
            models: [
              { value: "opus", label: "Opus" },
              { value: "sonnet", label: "Sonnet" },
            ],
            defaultModel: "sonnet",
          },
          plan("codex", false),
        ],
      },
    ];
    state.newAgentSetup = {
      brain: "claude_code",
      model: "opus",
      key: null,
      contextTokens: null,
      computer: { machineId: "machine_mini", name: "Mac mini" },
      account: null,
      ownSignIn: true,
      effort: "high",
      fallback: true,
    };
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [],
      computers: [
        {
          machineId: "machine_mini",
          name: "Mac mini",
          online: true,
          mine: true,
          canAdd: true,
          keys: true,
          brains: { claude_code: true, codex: false },
          own: { claude_code: {} },
        },
      ],
    });
    await open(state, api);
    await startAs("Assistente");
    await proceed(4);
    expect(screen().queryByText(/^Começa com a última escolha/)).toBeTruthy();
    // The last setup's model is the one checked, not the plan's Automático.
    const list = await openBrain();
    const opus = optionsIn(list, "Plano do Claude").find((o) => o.textContent?.startsWith("Opus"));
    expect(opus?.getAttribute("aria-selected")).toBe("true");
    await click(optionsIn(list, "Plano do Claude").find((o) => o.textContent?.startsWith("Sonnet")) as HTMLElement);
    // Another model: no longer the last setup.
    expect(screen().queryByText(/^Começa com a última escolha/)).toBeNull();
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code", model: "sonnet" },
    ]);
  });

  test("the last setup still arriving when the role is picked: it starts there once it comes", async () => {
    const state = seedState();
    state.newAgentSetup = { brain: "model", model: "claude-opus-5-5", key: null, contextTokens: null };
    const api = createFakeApi(state);
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const read = api.agents.newAgentSetup;
    api.agents.newAgentSetup = async (orgId) => {
      await arrived;
      return read(orgId);
    };
    await open(state, api);
    await startAs("Assistente");
    arrive();
    await settle(8);
    await proceed(4);
    expect(brainBox().textContent).toStartWith("Claude Opus 5.5");
  });

  test("the last setup: the API's model, key and context window; someone else's plan leaves Automático", async () => {
    const state = seedState();
    state.newAgentSetup = { brain: "model", model: "claude-opus-5-5", key: "cred-1", contextTokens: 400_000 };
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    expect(brainBox().textContent).toStartWith("Claude Opus 5.5");
    expect(screen().getByText("Começa com a última escolha: Claude Opus 5.5.")).toBeTruthy();
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({ model: "claude-opus-5-5", credentialId: "cred-1" });
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "model", contextTokens: 400_000 },
    ]);
    cleanup();

    // A plan on someone else's account can't think for my agent: it starts as before.
    const theirs = seedState();
    theirs.newAgentSetup = {
      brain: "claude_code",
      model: "opus",
      key: null,
      contextTokens: null,
      computer: { machineId: "machine_mini", name: "Mac mini" },
      account: { id: "acc-2", label: "Claude", provider: null, mine: false, free: true },
      ownSignIn: false,
    };
    await open(theirs);
    await startAs("Assistente");
    await proceed(4);
    expect(brainBox().textContent).toStartWith("Automático");
    expect(screen().queryByText(/^Começa com a última escolha/)).toBeNull();
  });

  // The "Modelo e custo" line of Revisar and of the preview.
  const modelAndCost = () =>
    (
      [
        [".newag__review .newag__rv", ".newag__rv-k", ".newag__rv-v"],
        [".newag__pv-sec", ".newag__pv-label", ".newag__chips"],
      ] as const
    ).map(
      ([rows, label, value]) =>
        [...document.querySelectorAll(rows)]
          .find((r) => r.querySelector(label)?.textContent === "Modelo e custo")
          ?.querySelector(value)?.textContent,
    );

  test("the last setup's Autonomia: its switch, Revisar says it, sent at creation; another AI leaves all of it", async () => {
    const state = seedState();
    state.newAgentSetup = {
      brain: "model",
      model: "claude-opus-5-5",
      key: null,
      contextTokens: null,
      autonomy: "never",
    };
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    expect(screen().getByText("Começa com a última escolha: Claude Opus 5.5.")).toBeTruthy();
    const carry = screen().getByRole("switch", { name: "Levar a autonomia" });
    expect(carry.getAttribute("aria-checked")).toBe("true");
    expect(carry.closest(".ac-setrow")?.textContent).toContain(
      "Não pergunta, como na última escolha. Desligado, começa com Só o que é arriscado.",
    );
    await proceed();
    const [review, preview] = modelAndCost();
    expect(review).toContain("Claude Opus 5.5 · Autonomia: Não pergunta");
    expect(preview).toContain("Autonomia: Não pergunta");
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({ model: "claude-opus-5-5", autonomy: "never" });
    cleanup();

    const other = seedState();
    other.newAgentSetup = {
      brain: "model",
      model: "claude-opus-5-5",
      key: null,
      contextTokens: null,
      autonomy: "never",
    };
    await open(other);
    await startAs("Assistente");
    await proceed(4);
    await chooseBrain(/^Claude Sonnet 5\.5/);
    expect(screen().queryByText(/^Começa com a última escolha/)).toBeNull();
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(other)?.model).toBe("claude-sonnet-5-5");
    expect(createdWith(other)).not.toHaveProperty("autonomy");
  });

  test("on an Automático last setup, Levar a autonomia off starts it on Automático with the default", async () => {
    const state = seedState();
    state.newAgentSetup = { brain: "model", model: "auto", key: null, contextTokens: null, autonomy: "never" };
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    expect(screen().getByText("Começa com a última escolha: Automático.")).toBeTruthy();
    // Automático picked again is still the last setup, its Autonomia too: the switch is the way out.
    await click(within(await openBrain()).getAllByRole("option")[0] as HTMLElement);
    const carry = screen().getByRole("switch", { name: "Levar a autonomia" });
    expect(carry.getAttribute("aria-checked")).toBe("true");
    await click(carry);
    expect(carry.getAttribute("aria-checked")).toBe("false");
    await proceed();
    const lines = modelAndCost();
    expect(lines).toEqual([expect.stringContaining("Automático"), expect.stringContaining("Automático")]);
    for (const line of lines) expect(line).not.toContain("Autonomia");
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(state)?.model).toBe("auto");
    expect(createdWith(state)).not.toHaveProperty("autonomy");
  });

  test("budget: empty is the workspace default; zero or text is invalid; a quick amount lights its button", async () => {
    const state = await open();
    await startAs("QA");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    expect(document.body.textContent).toContain("Vazio: o padrão do workspace (US$\u00a050).");
    const field = screen().getByLabelText("Orçamento mensal (US$)") as HTMLInputElement;
    await typeIn(field, "0");
    await click(continueButton());
    expect(title()).toBe("Modelo e orçamento");
    expect(screen().getAllByText("Use um valor maior que zero.").length).toBeGreaterThan(0);
    await typeIn(field, "abc");
    expect(screen().getAllByText("Use um valor maior que zero.").length).toBeGreaterThan(0);
    await click(screen().getByRole("button", { name: "US$\u00a030" }));
    // "Outro valor" stays empty: only an amount of its own goes there.
    expect(field.value).toBe("");
    expect(screen().getByRole("button", { name: "US$\u00a030" }).getAttribute("aria-pressed")).toBe("true");
    await click(screen().getByRole("button", { name: "Padrão do workspace (US$\u00a050)" }));
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)?.monthlyBudgetUsd).toBeNull();
  });

  test("my connected mailboxes are in 'Ferramentas e acesso', off by default; the chosen level is saved", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const mail = fakeMailOf.get(api);
    if (!mail) throw new Error("no mail fake");
    const box = (id: string, address: string, ownerUserId: string | null) => ({
      id,
      provider: "imap" as const,
      via: "imap" as const,
      address,
      label: "Atendimento",
      status: "active" as const,
      lastError: null,
      preset: "icloud",
      createdAt: new Date().toISOString(),
      offActions: [],
      askActions: [],
      aliases: [],
      defaultFrom: null,
      ownerUserId,
      agents: [],
    });
    // João's mailbox is his to give: it isn't offered here.
    mail.accounts = [
      box("mail-1", "ola@acme.com.br", state.me?.user.id ?? null),
      box("mail-2", "joao@acme.com.br", "u-joao"),
    ];
    await renderApp(`/org/${ORG_ID}/agents/new`, { api });
    await settle(8);
    await startAs("QA");
    await proceed(2);
    expect(title()).toBe("Ferramentas e acesso");
    const levels = within(screen().getByRole("list", { name: "Conectores e níveis" }));
    expect(levels.queryByRole("radiogroup", { name: "Nível em joao@acme.com.br" })).toBeNull();
    const mine = levels.getByRole("radiogroup", { name: "Nível em ola@acme.com.br" });
    expect(within(mine).getByRole("radio", { name: "Sem acesso" }).getAttribute("aria-checked")).toBe("true");
    await click(within(mine).getByRole("radio", { name: "Ler" }));
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const saved = state.calls.find((c) => c.method === "mail.setAgent");
    expect(saved?.args.slice(2)).toEqual(["mail-1", expect.objectContaining({ level: "read", canDelete: false })]);
  });

  test("a set budget is sent; the key defaults to the workspace's (credentialId null)", async () => {
    const state = await open();
    await startAs("QA");
    await proceed(4);
    expect(screen().getByRole("combobox", { name: "Chave" }).textContent).toContain("Chave padrão do workspace");
    await typeIn(screen().getByLabelText("Orçamento mensal (US$)"), "25,5");
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({ monthlyBudgetUsd: 25.5, credentialId: null });
  });

  test("owner, who can talk to it and channels are sent", async () => {
    const state = await open();
    await startAs("QA");
    await proceed(3);
    expect(title()).toBe("Onde trabalha e com quem");
    await click(screen().getByRole("checkbox", { name: "#general" }));
    await pick(screen().getByRole("combobox", { name: "Responsável" }), /^João/);
    const audience = screen().getByRole("radiogroup", { name: "Quem pode falar com a Iris" });
    expect(
      within(audience)
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(audience).getByRole("radio", { name: /^Só algumas pessoas/ }));
    expect(document.body.textContent).toContain("Só João, por enquanto");
    await click(screen().getAllByLabelText(/Walter/)[0] as HTMLElement);
    expect(document.body.textContent).toContain("João sempre pode, como responsável.");
    await proceed(2);
    // The owner and who can talk each under a label of their own, in the review and the preview: under "Responde a",
    // next to who can talk, the owner would read as whom the agent replies to.
    const labelled = (rows: string, label: string, value: string) =>
      [...document.querySelectorAll(rows)].map((r) => [
        r.querySelector(label)?.textContent,
        r.querySelector(value)?.textContent,
      ]);
    expect(labelled(".newag__review .newag__rv", ".newag__rv-k", ".newag__rv-v").slice(5, 7)).toEqual([
      ["Responsável", "João"],
      ["Quem pode falar", "Walter e João"],
    ]);
    expect(labelled(".newag__pv-sec", ".newag__pv-label", ".newag__chips").slice(2, 4)).toEqual([
      ["Responsável", "João"],
      ["Quem pode falar", "Walter e João"],
    ]);
    expect(screen().getByRole("complementary", { name: "Prévia do agente" }).textContent).not.toContain("Responde a");
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({
      ownerUserId: "u-joao",
      audience: { mode: "people", userIds: ["u-walter"] },
    });
    const channels = state.calls.find((c) => c.method === "agents.setChannels")?.args[2] as { channelId: string }[];
    expect(channels.map((c) => c.channelId).sort()).toEqual([ENG_ID, GENERAL_ID].sort());
  });

  test("'Só o responsável' needs an owner", async () => {
    await open();
    await startAs("QA");
    await proceed(3);
    // Every option of the picker is one size: "Sem responsável" says what it means behind its ⓘ, not on a second line.
    const owner = screen().getByRole("combobox", { name: "Responsável" });
    owner.focus();
    await act(async () => fireEvent.keyDown(owner, { key: "Enter" }));
    const none = screen().getByRole("option", { name: /Sem responsável/ });
    expect(none.querySelector(".ac-menu__desc")).toBeNull();
    expect(none.querySelector(".ac-menu__hint")?.textContent).toBe("Os admins recebem os avisos e aprovam");
    await pick(owner, /Sem responsável/);
    const audience = screen().getByRole("radiogroup", { name: "Quem pode falar com a Iris" });
    await click(within(audience).getByRole("radio", { name: /^Só o responsável/ }));
    await click(continueButton());
    expect(title()).toBe("Onde trabalha e com quem");
    expect(screen().getAllByText("Defina um responsável para usar esta opção.").length).toBeGreaterThan(0);
    await click(within(audience).getByRole("radio", { name: /^Todos do workspace/ }));
    await proceed();
    expect(title()).toBe("Modelo e orçamento");
  });

  test("the created moment: go to the channel, open the profile, create another", async () => {
    const state = await open();
    await startAs("QA");
    await toReview();
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const agentId = state.agents.at(-1)?.id;
    expect(screen().getByRole("heading", { name: "Iris entrou no time" })).toBeTruthy();
    expect(document.body.textContent).toContain("Já está em #eng. Mencione @iris numa conversa para começar.");
    expect(screen().getByRole("link", { name: "Ir para o #eng" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/c/${ENG_ID}`,
    );
    expect(screen().getByRole("link", { name: "Abrir perfil" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/${agentId}`,
    );
    // Title, lead and the buttons: no cards after them.
    expect(document.querySelector(".newag__born")?.nextElementSibling).toBeNull();
    // Every step is done; none can be reopened.
    expect(railStep("Papel").disabled).toBe(true);
    await click(screen().getByRole("button", { name: "Criar outro agente" }));
    expect(title()).toBe("Qual vai ser o papel?");
    // The draft starts over, so the preview waits for a role again.
    expect(screen().queryByRole("complementary", { name: "Prévia do agente" })).toBeNull();
    await startAs("Do zero");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("");
  });

  test("a save refused once the agent exists is said, and the flow still ends on the agent, without the channel", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.agents.setChannels = async () => {
      throw new ApiError(403, "forbidden", "Forbidden");
    };
    await open(state, api);
    await startAs("QA");
    await toReview();
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(document.querySelector(".ac-toasts")?.textContent).toContain(
      "A Iris já existe, mas parte do que você escolheu não foi salva. Você não tem permissão para isso.",
    );
    expect(screen().getByRole("heading", { name: "Iris entrou no time" })).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Adicione Iris a um canal e mencione @iris numa conversa para começar.",
    );
    // What came after the channels was still saved.
    expect(state.calls.some((c) => c.method === "access.set")).toBe(true);
    expect(state.agents.filter((a) => a.handle === "iris")).toHaveLength(1);
  });
});

describe("Criar agente with Criar agentes alone: an agent of my own, without apps", () => {
  const asMaker = () => {
    const state = seedState();
    meWithRole(state, ["create_agents"]);
    return open(state);
  };

  test("Responsável is me, with an ⓘ: nobody else and no one to pick", async () => {
    const state = await asMaker();
    await startAs("QA");
    await proceed(3);
    expect(title()).toBe("Onde trabalha e com quem");
    expect(screen().queryByRole("combobox", { name: "Responsável" })).toBeNull();
    expect(document.querySelector(".newag .agp-person__t")?.textContent).toBe("Walter (você)Membro");
    expect(hintOf("Responsável").text).toBe(
      "Quem cria o agente é o responsável. Um admin pode passar para outra pessoa depois.",
    );
    await proceed(2);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)?.ownerUserId).toBe("u-walter");
    expect(screen().getByRole("heading", { name: "Iris entrou no time" })).toBeTruthy();
  });

  test("apps start without access and can't be changed here; Criar saves none, so nothing is refused", async () => {
    const state = await asMaker();
    // QA's apps (GitHub) aren't on its card: they wouldn't come with it.
    expect(screen().getByRole("button", { name: /^QA/ }).textContent).not.toContain("GitHub");
    await startAs("QA");
    await proceed(2);
    expect(title()).toBe("Ferramentas e acesso");
    expect(document.querySelector(".onb__lead")?.textContent).toBe("A Iris começa sem acesso aos apps do workspace.");
    expect(hintOf("Ferramentas e acesso").text).toBe(
      "Só admins dão acesso a apps e caixas de email. Depois de criar, peça a um admin.",
    );
    const apps = screen().getByRole("list", { name: "Conectores e níveis" });
    expect(within(apps).queryByRole("radiogroup")).toBeNull();
    expect(apps.textContent).toContain("GitHub");
    expect(apps.textContent).toContain("Sem acesso");
    expect(document.querySelector(".newag__quick")).toBeNull();
    expect(screen().queryByRole("link", { name: /Conectar outro app/ })).toBeNull();
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(state.calls.some((c) => c.method === "access.set" || c.method === "mail.setAgent")).toBe(false);
    expect(document.querySelector(".ac-toasts")?.textContent ?? "").not.toContain("não foi salva");
    expect(screen().getByRole("heading", { name: "Iris entrou no time" })).toBeTruthy();
  });
});

describe("Criar agente in a personal workspace (ADR 0159)", () => {
  /** The seeded workspace as a personal one; `alone`: Walter its only member. */
  const personal = (alone: boolean) => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.mode = "personal";
    if (alone) state.members = state.members.filter((m) => m.userId === state.me?.user.id);
    return state;
  };

  test("alone: no owner and no who can talk on the screen; it is created mine, answering only me", async () => {
    const state = await open(personal(true));
    // One person's starting points: the right hand's personal agents, not a company's roles (ADR 0159 §3).
    expect(screen().getByRole("heading", { name: "Para o seu dia" })).toBeTruthy();
    expect(screen().queryByRole("heading", { name: "Produto e tecnologia" })).toBeNull();
    expect(screen().queryByRole("button", { name: /^QA/ })).toBeNull();
    await startAs("Clara");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("Clara");
    // Its technical steps start filled in and are passed over (ADR 0159 §3): four steps, Instruções on to Revisar.
    expect(screen().getByText("Passo 2 de 4")).toBeTruthy();
    await proceed(2);
    expect(screen().getByText("Passo 4 de 4")).toBeTruthy();
    // Revisar still opens them.
    await click(screen().getByRole("button", { name: "Editar Canais" }));
    expect(title()).toBe("Onde trabalha e com quem");
    expect(screen().queryByRole("combobox", { name: "Responsável" })).toBeNull();
    expect(screen().queryByRole("radiogroup", { name: "Quem pode falar com a Clara" })).toBeNull();
    await proceed(1);
    const review = document.querySelector(".newag__review")?.textContent ?? "";
    expect(review).not.toContain("Responsável");
    expect(review).not.toContain("Quem pode falar");
    await click(screen().getByRole("button", { name: "Criar Clara" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({ ownerUserId: "u-walter", audience: { mode: "owner" } });
  });

  test("with family: only the owner at first, in plain words; people to pick, without a Roles group", async () => {
    const state = await open(personal(false));
    await startAs("Clara");
    await proceed(2);
    await click(screen().getByRole("button", { name: "Editar Canais" }));
    // The owner's list names each person without their role.
    const owner = screen().getByRole("combobox", { name: "Responsável" });
    owner.focus();
    await act(async () => fireEvent.keyDown(owner, { key: "Enter" }));
    expect(screen().getByRole("option", { name: /^João/ }).querySelector(".ac-menu__desc")).toBeNull();
    // Closed on the same choice: still me.
    await click(screen().getByRole("option", { name: /^Walter/ }));
    const audience = screen().getByRole("radiogroup", { name: "Quem pode falar com a Clara" });
    expect(
      within(audience)
        .getByRole("radio", { name: /^Só o responsável/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(audience).getByRole("radio", { name: /^Todos daqui/ })).toBeTruthy();
    await click(within(audience).getByRole("radio", { name: /^Só algumas pessoas/ }));
    const results = screen().getByRole("region", { name: "Buscar pessoas" });
    // Admin is the only role besides Todos, and whoever holds it sees everything already: people, not roles.
    expect(within(results).queryByText("Papéis")).toBeNull();
    await click(within(results).getByLabelText(/João/));
    await proceed(1);
    await click(screen().getByRole("button", { name: "Criar Clara" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({
      ownerUserId: "u-walter",
      audience: { mode: "people", userIds: ["u-joao"], roleIds: [] },
    });
  });
});

describe("new-agent rules", () => {
  const taken = new Set(["ada", "ada-2", "joao"]);

  test("handles: shape, taken, next free", () => {
    expect(handleProblem("", taken)).toBe("empty");
    expect(handleProblem("a", taken)).toBe("format");
    expect(handleProblem("-ab", taken)).toBe("format");
    expect(handleProblem("ada", taken)).toBe("taken");
    expect(handleProblem("iris_2", taken)).toBeNull();
    expect(freeHandle("ada", taken)).toBe("ada-3");
  });

  test("budget: empty = default, positive amounts, the rest invalid", () => {
    expect(readBudget("")).toEqual({ amount: null, invalid: false });
    expect(readBudget("40,5")).toEqual({ amount: 40.5, invalid: false });
    expect(readBudget("0").invalid).toBe(true);
    expect(readBudget("-3").invalid).toBe(true);
    expect(readBudget("dez").invalid).toBe(true);
  });

  test("presets: levels by catalog connector, channels by name", () => {
    const items = [
      { id: "c1", def: { id: "github" } },
      { id: "c2", def: { id: "notion" } },
      { id: "c3", def: null },
    ];
    expect(presetLevels("dev", items)).toEqual({ c1: "write", c2: "write", c3: "none" });
    expect(presetLevels("pm", items)).toEqual({ c1: "read", c2: "write", c3: "none" });
    expect(presetLevels("custom", items)).toEqual({ c1: "write", c2: "write", c3: "none" });
    const chans = [
      { id: "1", name: "Engenharia" },
      { id: "2", name: "general" },
      { id: "3", name: "incidentes" },
    ];
    expect(presetChannels("dev", chans)).toEqual(["1"]);
    expect(presetChannels("ops", chans)).toEqual(["3"]);
    expect(presetChannels("custom", chans)).toEqual([]);
  });

  test("roles: each one in exactly one group, with its texts in both languages and its own starter name", () => {
    const grouped = ROLE_GROUPS.flatMap((g) => g.roles as readonly string[]);
    expect(grouped.toSorted()).toEqual(ROLE_IDS.filter((id) => id !== "custom").toSorted());
    for (const dict of [ptBR, en]) {
      const roles = dict.newAgent.roles as Record<
        string,
        { name: string; agent?: string; desc: string; instructions: string }
      >;
      for (const id of grouped) {
        expect(roles[id]?.name).toBeTruthy();
        expect(roles[id]?.agent).toBeTruthy();
        expect(roles[id]?.desc).toBeTruthy();
        expect(roles[id]?.instructions).toBeTruthy();
      }
      const agents = grouped.map((id) => roles[id]?.agent);
      expect(new Set(agents).size).toBe(agents.length);
      for (const g of ROLE_GROUPS) expect((dict.newAgent.roleGroups as Record<string, string>)[g.id]).toBeTruthy();
    }
    // Money starts read-only.
    expect(ROLE_PRESETS.finance.levels).toEqual({ stripe: "read", paypal: "read", square: "read", drive: "read" });
  });

  test("what each step needs", () => {
    const base = {
      role: "qa" as const,
      name: "Iris",
      handle: "iris",
      taken,
      ownerUserId: "u1",
      audience: { mode: "everyone" as const, userIds: [] },
      budget: "",
      modelOk: true,
    };
    expect(stepErrors("role", { ...base, role: null })).toEqual([{ field: "role", code: "required" }]);
    expect(stepErrors("identity", { ...base, name: " ", handle: "ada" })).toEqual([
      { field: "name", code: "required" },
      { field: "handle", code: "taken" },
    ]);
    expect(stepErrors("where", { ...base, ownerUserId: null, audience: { mode: "owner", userIds: [] } })).toEqual([
      { field: "audience", code: "noOwner" },
    ]);
    // "Algumas pessoas" with nobody picked is fine while there's an owner (the owner always can).
    expect(stepErrors("where", { ...base, audience: { mode: "people", userIds: [] } })).toEqual([]);
    expect(stepErrors("model", { ...base, budget: "0", modelOk: false })).toEqual([
      { field: "model", code: "unavailable" },
      { field: "budget", code: "invalid" },
    ]);
    expect(stepErrors("review", base)).toEqual([]);
  });
});
