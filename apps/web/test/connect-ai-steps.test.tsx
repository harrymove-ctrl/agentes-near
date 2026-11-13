import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type {
  Agent,
  AgentBrain,
  AgentBrainLine,
  AiAccounts,
  AiComputer,
  ComputerSetup,
  Machine,
  MachineAccount,
} from "@agenteschat/client";
import { ApiError, applyMachineEvent, keys } from "@agenteschat/client";
import { LOGIN_RECONNECT_MS } from "@agenteschat/client/lib/machines";
import { LOGIN_PER_AGENT } from "@agenteschat/client/lib/plans";
import { en } from "@agenteschat/i18n";
import { icons } from "@agenteschat/ui";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { aiSelect, chooseAi, closeAiSelect, openAiSelect, payWith } from "./ai-picker";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  fakeAgentBrain,
  fakeMachinesOf,
  meAsAdmin,
  ORG_ID,
  seedState,
} from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/**
 * The key or code a panel is sending, sealed and gone: sealing is WebCrypto, which runs off the JS thread, so on a
 * loaded machine it can outlast any number of ticks.
 */
const sealed = async (panel: HTMLElement, ticks = 12) => {
  await waitFor(() => expect(shownText(panel)).not.toMatch(/Enviando (a chave|o código) a/), { timeout: 10_000 });
  await settle(ticks);
};

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};

const account = (over: Partial<MachineAccount> = {}): MachineAccount => ({
  id: "acct_new",
  kind: "claude_code",
  label: "GLM Coding",
  email: null,
  plan: null,
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: "zai",
  keyHint: "MnOp",
  ...over,
});

/** The sign-in window: the page opens it on the click, then sends it to the provider's page. */
async function withPopup(run: () => Promise<void>) {
  const realOpen = window.open;
  const opened: string[] = [];
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
  window.open = ((url: string) => {
    opened.push(url);
    return popup;
  }) as unknown as typeof window.open;
  try {
    await run();
  } finally {
    window.open = realOpen;
  }
  return { opened, popup };
}

/**
 * Settings › AI accounts with Ada (Walter's) on the MacBook, a computer someone else connected for the workspace
 * (`brain`: Ada's view; `machine`: over its row), and "Conectar uma IA" opened. `setup`: the workspace gets its own
 * computer, this far.
 */
async function connect({
  computers = [MAC],
  setup,
  brain = {},
  machine = {},
  mine = [ADA_ID],
  crew = false,
  path = `/org/${ORG_ID}/settings/keys`,
  role,
  ada: adaRow,
  accounts = [],
}: {
  computers?: AiComputer[];
  setup?: Partial<ComputerSetup>;
  brain?: Partial<AgentBrain>;
  machine?: Partial<Machine>;
  /** Walter's agents (a plan thinks only for its owner's). */
  mine?: string[];
  /** Ada, Atlas and Lia, all Walter's, all on the MacBook, none with an AI yet. */
  crew?: boolean;
  /** Where the dialog opens: Settings' button, or a link that asks for it. */
  path?: string;
  /** Walter's role in the workspace, when he isn't its owner ("admin": a member with the "Admin" role). */
  role?: "admin" | "member";
  /** Over Ada's row (what she thinks with, whom she replies to). */
  ada?: Partial<Agent>;
  /** Walter's accounts on the computers (`/ai-accounts`). */
  accounts?: AiAccounts["accounts"];
} = {}) {
  const state = seedState();
  const workspace = state.me?.organizations[0];
  if (role === "admin") meAsAdmin(state);
  else if (role && workspace) workspace.role = role;
  const ada = state.agents[0];
  if (crew && ada) {
    state.agents.push({ ...ada, id: LIA_ID, name: "Lia", handle: "lia" });
    mine = [ADA_ID, ATLAS_ID, LIA_ID];
    state.aiStatus = { any: false, agents: mine.map((agentId) => ({ agentId, state: "no_ai", reason: "no_key" })) };
  }
  for (const a of state.agents) if (mine.includes(a.id)) a.ownerUserId = "u-walter";
  if (ada && adaRow) Object.assign(ada, adaRow);
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  if (setup) machines?.setSetup(setup);
  else
    machines?.pair({
      id: "machine_1",
      name: "MacBook",
      agents: state.agents
        .filter((a) => a.id === ADA_ID || (crew && mine.includes(a.id)))
        .map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
      ...machine,
    });
  machines?.setAiAccounts({ accounts, computers });
  const viewOf = api.agents.brain;
  api.agents.brain = async (orgId, agentId) => ({ ...(await viewOf(orgId, agentId)), ownSignIn: false, ...brain });
  const { router, services } = await renderApp(path, { api });
  await settle(6);
  if (!path.includes("connect=ai")) await click(screen().getByRole("button", { name: "Conectar uma IA" }));
  await settle(4);
  // For one agent the picker; for the team (`crew`) the narrow dialog under the sky, whose title follows its screen.
  const dialog = screen().getByRole("dialog");
  const choose = (name: string) => (inBand(dialog) ? pickPlan(dialog, name) : chooseAi(dialog, name));
  return { state, api, machines, dialog, choose, router, services };
}

/** The narrow dialog under the sky (ADR 0160, addendum): the team's Connect, or an agent's own conversation's. */
const inBand = (dialog: HTMLElement) => dialog.querySelector(".arrival-hero") !== null;

/** The team's Connect: a plan's card from its list, "Other plan" opening the rest first when it is among them. */
async function pickPlan(dialog: HTMLElement, name: string) {
  const card = () => within(dialog).queryByRole("button", { name: new RegExp(`^${name}`) });
  if (!card()) await click(within(dialog).getByRole("button", { name: /^Outro plano/ }));
  await click(card() as HTMLElement);
  await settle(4);
}

/** The faces of a sign-in for several, one login each: whose turn, done, to come, or didn't end. */
const facesOf = (inside: HTMLElement) =>
  [...inside.querySelectorAll(".ai-strip__face")].map((li) => li.getAttribute("data-state"));

const calls = (state: ReturnType<typeof seedState>, method: string) => state.calls.filter((c) => c.method === method);

/**
 * As the server answers a move: the agent's row says what it thinks with and the AI status says it's ready, so the
 * agents a panel would open on by default change while it signs them in.
 */
function serverMoves(
  state: ReturnType<typeof seedState>,
  api: ReturnType<typeof createFakeApi>,
  brain: AgentBrainLine,
) {
  const setBrain = api.agents.setBrain;
  api.agents.setBrain = async (orgId, agentId, input) => {
    const view = await setBrain(orgId, agentId, input);
    const row = state.agents.find((a) => a.id === agentId);
    if (row) row.brain = brain;
    state.aiStatus = {
      any: true,
      agents: (state.aiStatus?.agents ?? []).map((a) => (a.agentId === agentId ? { agentId, state: "ready" } : a)),
    };
    return view;
  };
}
const GLM: AgentBrainLine = { kind: "claude_code", model: null, provider: "zai" };
const GLM_KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";

const LIA_ID = "00000000-0000-4000-8000-0000000000a3";
/** Whether an icon is drawn as `name` (its shape's first path). */
const drawnAs = (svg: Element | null | undefined, name: keyof typeof icons) =>
  svg?.querySelector("path")?.getAttribute("d") === icons[name].find(([tag]) => tag === "path")?.[1].d;
/** A stylesheet's text, its comments left out. */
const stylesheet = async (path: string) =>
  (await Bun.file(new URL(path, import.meta.url).pathname).text()).replace(/\/\*[\s\S]*?\*\//g, "");
/** The body of the first rule whose selector is `selector`, at any indent (inside a media query too). */
const ruleOf = (css: string, selector: string) =>
  css.split(new RegExp(`\\n *${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`))[1]?.split("}")[0] ?? "";
/** A Claude plan's account, as the computer reports it once the sign-in ends. */
const claudeMax = account({ id: "acct_max", label: "Claude Max", provider: null, keyHint: null });
/** A ChatGPT plan's account: one per agent, so a sign-in that comes back as it is refused. */
const chatgptPlus = account({
  id: "acct_plus",
  kind: "codex",
  label: "ChatGPT Plus",
  provider: null,
  keyHint: null,
  email: "rafael@gmail.com",
});

describe("Conectar uma IA: one picker, plans first", () => {
  test("one gap sets a plan's steps apart: each part of the flow takes it, with no margin of its own", async () => {
    const layout = await stylesheet("../src/layout.css");
    for (const box of [".agp-addacct", ".ai-panel"]) expect(ruleOf(layout, box)).toContain("gap: var(--ai-steps-gap)");
    expect(ruleOf(layout, ".agp-addacct > .ac-setnote")).toContain("margin-block: 0");
    const parts = [...layout.matchAll(/\.agp-addacct > [^\s{,]+ \{[^}]*\}/g)].map((m) => m[0]);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) expect(part).not.toMatch(/margin(-block|-top|-bottom)?: (?!0)/);
    // So every part a flow draws has to be one of these: a new kind brings its own margin past the check above.
    const { dialog, choose } = await connect();
    for (const name of ["Claude", "ChatGPT", "Cursor", "OpenCode Go", "Grok", "Gemini", "GLM Coding"]) {
      await choose(name);
      for (const part of Array.from(dialog.querySelector(".agp-addacct")?.children ?? []))
        expect(part.className).toMatch(/agp-addacct__step|ac-setnote|ac-btn|agp-addacct__head|ai-panel__row/);
    }
  });

  test("Settings › AI accounts opens the same picker: a plan or a key, then one select with Claude chosen and its sign-in", async () => {
    const { dialog } = await connect();
    const group = within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" });
    expect(group.querySelectorAll(":scope > .ac-option")).toHaveLength(0);
    // The two ways to pay, then whose: nothing else before the steps.
    expect(within(group).getByRole("radiogroup", { name: "Como você paga?" })).toBeTruthy();
    expect(payWith(dialog, "Com um plano").getAttribute("aria-checked")).toBe("true");
    expect(payWith(dialog, "Com chave de API").getAttribute("aria-checked")).toBe("false");
    const select = aiSelect(dialog);
    expect(select.textContent).toBe("Claude");
    expect(select.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("claude");
    const options = await openAiSelect(dialog);
    // The most used first, each by its maker's mark.
    expect(options.map((o) => o.textContent)).toEqual([
      "Claude",
      "ChatGPT",
      "Gemini",
      "Grok",
      "Cursor",
      "OpenCode",
      "GLM Coding",
      "Kimi Code",
      "MiniMax",
      "OpenCode Go",
    ]);
    expect(options.map((o) => o.querySelector(".ac-brand")?.getAttribute("data-mark"))).toEqual([
      "claude",
      "openai",
      "gemini",
      "grok",
      "cursor",
      "opencode",
      "zai",
      "kimi",
      "minimax",
      "opencode",
    ]);
    await closeAiSelect();
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    // Right under the select: nothing comes between a choice and its steps.
    expect(select.closest(".ac-select")?.nextElementSibling).toBe(panel);
    expect(panel.textContent).toContain("Pro, Max, Ultra, Team ou Enterprise");
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    // The sign-in step is its title, its ⓘ and its button: the title names the account, the button the sign-in,
    // and the ⓘ says what to do on the wrong account and where the account stays. Its one step takes no number.
    expect(hintOf("A conta com o seu plano", panel)).toMatchObject({
      text: "Conta errada? Saia de lá e tente de novo. A conta fica só no MacBook. Você digita a senha na\u00a0página\u00a0do\u00a0Claude.",
      hidden: true,
    });
    expect(panel.querySelector(".agp-addacct__step")?.classList.contains("ac-iconline")).toBe(false);
    expect(panel.querySelector(".agp-addacct__step > i")).toBeNull();
    expect(shownText(panel)).not.toMatch(/Abre a página|nunca vê a senha|senha vai só/);
    // Whom the agent answers, once, as the panel's foot: "Atende outras pessoas", off, the line saying she answers
    // only the person on their plan, and Claude's terms behind its ⓘ (no lock note above it).
    const foot = panel.querySelector(".ac-card__foot") as HTMLElement;
    expect(panel.lastElementChild).toBe(foot);
    expect(foot.firstElementChild?.getAttribute("data-icon") ?? foot.querySelector("svg")).toBeTruthy();
    expect(shownText(foot)).toBe("Atende outras pessoasA Ada só atende você, pelo seu plano do Claude.");
    expect(within(foot).getByRole("switch", { name: "Atende outras pessoas" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(hintOf("os termos do plano", foot).text).toBe(
      "Os planos do Claude são para uso pessoal. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do Claude.",
    );
    expect(panel.classList.contains("ai-panel--plan")).toBe(true);
    expect(panel.querySelectorAll(".ac-setnote")).toHaveLength(0);
    // One agent of the viewer's: nobody to choose.
    expect(within(panel).queryByRole("combobox")).toBeNull();
    // A first sign-in asks for no account, and nothing asks for a computer or a name.
    expect(within(panel).queryByLabelText("Qual conta? (opcional)")).toBeNull();
    expect(dialog.textContent).not.toContain("Em qual computador?");
    // Until something is connected the body is the dialog's last part: its own edge under the panel, no footer.
    expect(dialog.querySelector(".ac-dialog__body:last-child")).not.toBeNull();
    expect(dialog.querySelector(".ac-dialog__footer")).toBeNull();
  });

  test("the select's search finds a plan by what people call it, and the keys pick from it", async () => {
    const { dialog } = await connect();
    await openAiSelect(dialog);
    const field = screen().getByRole("combobox", { name: "Buscar provedores" });
    const shown = async (query: string) => {
      await type(field, query);
      await settle(2);
      return screen()
        .queryAllByRole("option")
        .map((o) => o.textContent);
    };
    // Its maker, what it is sold as, one of its tiers.
    expect(await shown("openai")).toEqual(["ChatGPT"]);
    expect(await shown("glm")).toEqual(["GLM Coding"]);
    expect(await shown("supergrok")).toEqual(["Grok"]);
    expect(await shown("nada disso")).toEqual([]);
    expect(screen().getByText("Nenhum provedor encontrado")).toBeTruthy();
    await shown("kimi");
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(4);
    expect(within(dialog).getByRole("region", { name: "Kimi Code" })).toBeTruthy();
  });

  test("the picker's rows: a check on the name's line, and the chosen option's panel a form's gap under its select", async () => {
    const ui = await stylesheet("../../../packages/ui/src/styles/components.css");
    expect(ruleOf(ui, '.ac-option[aria-pressed="true"]::after')).toContain("height: 18px");
    const layout = await stylesheet("../src/layout.css");
    // A row has two lines: its check goes on the first, its name's, past the row's padding (the page's 22px line
    // where the lh unit is unknown).
    expect(ruleOf(ui, ".ac-option")).toContain("padding: var(--space-3)");
    const key = ".ai-picker > .ac-option.ai-picker__key::after";
    expect(ruleOf(layout, key)).toContain("top: calc(var(--space-3) + 11px - 9px)");
    expect(ruleOf(layout.split("\n@supports (top: 1lh) {")[1] ?? "", key)).toContain(
      "top: calc(var(--space-3) + 0.5lh - 9px)",
    );
    // The form's rhythm: the panel stands from the select as any field from the next.
    expect(ruleOf(layout, ".ai-picker")).toContain("gap: var(--form-gap)");
  });

  test("a coding plan's key: its own key page, then the key sealed to the computer (in no request); the agent thinks with it", async () => {
    const { state, machines, dialog, choose } = await connect();
    machines?.endLogin("login_1", { state: "done", account: account() });
    // A plan whose keys have a known start shows it as the field's example.
    await choose("OpenCode Go");
    const opencode = within(dialog).getByRole("region", { name: "OpenCode Go" });
    expect(within(opencode).getByLabelText("Chave do OpenCode Go").getAttribute("placeholder")).toBe("oc_sk_…");
    await choose("GLM Coding");
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    expect(panel.textContent).toContain("Lite, Pro ou Max");
    expect(within(panel).getByRole("link", { name: "Abrir z.ai" }).getAttribute("href")).toBe(
      "https://z.ai/manage-apikey/apikey-list",
    );
    // Each step is its title and its control: the team plan's key and where the key goes are their ⓘ, and the
    // field is described by its own.
    expect(hintOf("Crie a chave do seu plano", panel).text).toBe(
      "Num plano de equipe, use a chave da página Team\u00a0Plan.",
    );
    const safe = hintOf("Cole a chave aqui", panel);
    expect(safe.text).toBe("A chave vai criptografada para o MacBook e\u00a0fica\u00a0só\u00a0lá.");
    // The foot names the plan, and its terms are the plan's maker's.
    const foot = panel.querySelector(".ac-card__foot") as HTMLElement;
    expect(shownText(foot)).toBe("Atende outras pessoasA Ada só atende você, pelo seu plano GLM Coding.");
    expect(hintOf("os termos do plano", foot).text).toBe(
      "Z.ai diz que o plano é só de quem assina. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do plano.",
    );
    expect(shownText(panel)).not.toMatch(/Fica em|Num plano de equipe|criptografada|só de quem assina/);
    expect(within(panel).getByLabelText("Chave do GLM Coding").getAttribute("aria-describedby")).toBe(
      safe.button.getAttribute("aria-describedby"),
    );
    // Z.ai publishes no prefix for its keys: no example in the field, never a bare "…". Colar sits inside the field,
    // and sending waits for a key: no greyed button under an empty field.
    expect(within(panel).getByLabelText("Chave do GLM Coding").hasAttribute("placeholder")).toBe(false);
    expect(within(panel).getByRole("button", { name: "Colar" }).closest(".ac-input-affix")).not.toBeNull();
    expect(within(panel).queryByRole("button", { name: "Enviar ao MacBook" })).toBeNull();
    // Nothing starts on the computer until the key is there; a paste that isn't a key says so.
    expect(machines?.lastLogin()).toBeUndefined();
    const keyBox = within(panel).getByLabelText("Chave do GLM Coding");
    expect(within(panel).getByRole("link", { name: "Abrir z.ai" }).className).toContain("ac-btn--primary");
    await type(keyBox, "short");
    expect(panel.textContent).toContain("Isso não parece uma chave do GLM Coding.");
    const KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";
    await type(keyBox, KEY);
    // With a key typed, sending is the one primary: opening the page steps back.
    expect(within(panel).getByRole("link", { name: "Abrir z.ai" }).className).not.toContain("ac-btn--primary");
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    // The fake computer is signed in before the key lands: the panel moves on while the key is still being sealed.
    await waitFor(() => expect(calls(state, "machines.sendAccountCode")).toHaveLength(1), { timeout: 10_000 });
    await settle(8);
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { provider: "zai" },
    ]);
    expect(machines?.lastLogin()?.box).not.toBeNull();
    expect(JSON.stringify(state.calls)).not.toContain("0123456789abcdef");
    // No naming step: the agent thinks with it at once.
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "claude_code", account: "acct_new" },
    ]);
    expect(calls(state, "machines.renameAccount")).toHaveLength(0);
    expect(dialog.textContent).toContain("Ada agora pensa com GLM Coding.");
    await click(within(dialog).getByRole("button", { name: "Pronto" }));
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("ChatGPT: first its settings, then a sign-in that starts only on its button; switching tiles starts nothing", async () => {
    const { state, dialog, choose } = await connect();
    await choose("ChatGPT");
    await choose("Claude");
    await choose("ChatGPT");
    await settle(4);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    expect(panel.textContent).toContain("Plus, Pro, Business ou Enterprise");
    expect(panel.textContent).toContain("Permita o login com código no ChatGPT");
    expect(within(panel).getByRole("link", { name: "Abrir as configurações do ChatGPT" }).getAttribute("href")).toBe(
      "https://chatgpt.com/#settings/Security",
    );
    // Who has to turn it on stays in view (a member of a Business plan can't do it alone): no ⓘ on this step.
    expect(shownText(panel)).toContain(
      "Em Configurações\u00a0›\u00a0Segurança, ligue o login com código de dispositivo para o Codex. No Business ou Enterprise, quem\u00a0administra\u00a0liga.",
    );
    expect(within(panel).queryByRole("button", { name: "Sobre Permita o login com código no ChatGPT" })).toBeNull();
    expect(hintOf("A conta com o seu plano", panel).text).toBe(
      "Conta errada? Saia de lá e tente de novo. A conta fica só no MacBook. Você digita a senha na\u00a0página\u00a0do\u00a0ChatGPT.",
    );
    const { opened, popup } = await withPopup(() =>
      click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })),
    );
    await settle(6);
    expect(opened).toEqual(["/conectando?kind=codex"]);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([[ORG_ID, "machine_1", "codex"]]);
    expect(popup.location.href).toBe("https://auth.openai.com/codex/device");
    expect(within(panel).getByLabelText("Código para o ChatGPT").textContent).toBe("ABCD-1234");
    expect(shownText(panel)).toContain("Digite este código na página que abrir.");
    expect(shownText(panel)).not.toContain("Foi você");
    expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
  });

  test("Cursor: its page opens and the computer finishes by itself; or its API key, sealed like a plan's (ADR 0114)", async () => {
    const base = fakeAgentBrain(ADA_ID);
    const cursorOption = {
      kind: "cursor" as const,
      available: true,

      models: [{ value: "grok-5-code", label: "Grok 5 Code", inPlan: true }],
      defaultModel: null,
    };
    const { state, dialog, choose } = await connect({
      computers: [{ ...MAC, brains: { claude_code: true, codex: true, cursor: true } }],
      brain: { options: [...base.options, cursorOption] },
    });
    await choose("Cursor");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Cursor" });
    expect(panel.textContent).toContain("Pro, Pro+, Ultra ou Teams, ou uma chave de API do Cursor");
    expect(aiSelect(dialog).querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("cursor");
    // Nothing starts before its button; the sign-in asks the computer for Cursor's page, no code to paste.
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
    const { popup } = await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com Cursor" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([[ORG_ID, "machine_1", "cursor"]]);
    expect(popup.location.href).toBe("https://cursor.com/loginDeepControl?challenge=fake");
    expect(shownText(panel)).toContain("Entre na página do Cursor. O MacBook termina sozinho.");
    expect(within(panel).queryByLabelText("Código do Claude")).toBeNull();
  });

  test("Cursor's API key instead of its sign-in: the key goes sealed to the computer, never in a request", async () => {
    const base = fakeAgentBrain(ADA_ID);
    const cursorOption = {
      kind: "cursor" as const,
      available: true,

      models: [],
      defaultModel: null,
    };
    const { state, dialog, choose } = await connect({ brain: { options: [...base.options, cursorOption] } });
    await choose("Cursor");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Cursor" });
    await click(within(panel).getByRole("button", { name: "Usar uma chave de API do Cursor" }));
    expect(within(panel).getByRole("link", { name: "Abrir cursor.com" }).getAttribute("href")).toBe(
      "https://cursor.com/dashboard?tab=integrations",
    );
    const keyBox = within(panel).getByLabelText("Chave do Cursor");
    await type(keyBox, "key_fake_0000000000001234");
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    // The fake computer is signed in before the key lands: the panel moves on while the key is still being sealed.
    await waitFor(() => expect(calls(state, "machines.sendAccountCode")).toHaveLength(1), { timeout: 10_000 });
    await settle(8);
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([
      ORG_ID,
      "machine_1",
      "cursor",
      { provider: "cursor" },
    ]);
    expect(JSON.stringify(state.calls)).not.toContain("key_fake_0000000000001234");
  });

  test("Gemini (ADR 0143): Google's warning said plainly on a personal plan, gone for Gemini Enterprise, which signs in as one", async () => {
    const base = fakeAgentBrain(ADA_ID);
    const geminiOption = { kind: "antigravity" as const, available: true, models: [], defaultModel: null };
    const { state, dialog, choose } = await connect({
      computers: [{ ...MAC, brains: { claude_code: true, codex: true, antigravity: true } }],
      brain: { options: [...base.options, geminiOption] },
    });
    await choose("Gemini");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Gemini" });
    expect(panel.textContent).toContain("Google AI Pro, Google AI Ultra ou Gemini Enterprise");
    const warning =
      "O Google diz que usar um plano pessoal do Gemini dentro de outros apps pode suspender a conta. Para não correr esse risco, use uma chave de API ou o Gemini Enterprise.";
    expect(shownText(panel)).toContain(warning);
    await click(within(panel).getByRole("button", { name: "Usar o Gemini Enterprise" }));
    expect(shownText(panel)).not.toContain(warning);
    expect(shownText(panel)).toContain("A sua conta do Gemini Enterprise");
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com Google" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([
      ORG_ID,
      "machine_1",
      "antigravity",
      { provider: "enterprise" },
    ]);
    // Its second step is Google's: the code its page shows, or that page's address. Claude is named nowhere.
    expect(shownText(panel)).toContain("Cole o código que o Google mostrar");
    const field = within(panel).getByRole("textbox", { name: "Código ou link" });
    expect(field.getAttribute("placeholder")).toBe("Código ou link");
    expect(shownText(panel)).not.toContain("Claude");
  });

  test("a sign-in starting: the line under its title says the computer is asked, until it answers, and only then", async () => {
    const { api, dialog, choose } = await connect();
    // The computer answers only when let.
    const begin = api.machines.beginAccountLogin;
    let answer = () => {};
    api.machines.beginAccountLogin = async (...args) => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return begin(...args);
    };
    const signIn = async (plan: string) => {
      const panel = within(dialog).getByRole("region", { name: `Seu plano do ${plan}` });
      expect(shownText(panel)).not.toContain("Pedindo ao MacBook…");
      await withPopup(async () => {
        await click(within(panel).getByRole("button", { name: `Entrar com ${plan}` }));
        expect(shownText(panel)).toContain("Pedindo ao MacBook…");
        await act(async () => answer());
        await settle(6);
      });
      expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
      expect(shownText(panel)).not.toContain("Pedindo ao MacBook…");
    };
    await signIn("Claude");
    await choose("ChatGPT");
    await signIn("ChatGPT");
  });

  test("ChatGPT: the same account twice is refused, and the page says how to add another", async () => {
    const { machines, dialog, choose } = await connect();
    machines?.endLogin("login_1", { state: "failed", duplicate: { label: "Trabalho" } });
    await choose("ChatGPT");
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(8);
    expect(dialog.textContent).toContain(
      "O ChatGPT entrou como Trabalho, uma conta que você já conectou. Para usar outra, saia na página do ChatGPT e tente de novo.",
    );
    // What went wrong, then its button under the note's words.
    const retry = within(dialog).getByRole("button", { name: "Tentar de novo" });
    expect(retry.parentElement?.className).toBe("ai-panel__row");
    expect(retry.parentElement?.querySelector(":scope > .ac-setnote")).not.toBeNull();
  });

  test("a plan's panel: its body starts at the panel's edge, every lead centred in the numbers' column, an even well", async () => {
    const layout = await stylesheet("../src/layout.css");
    const plan = ruleOf(layout, ".ai-panel--plan");
    expect(plan).toContain("--mark: 30px");
    expect(plan).toContain("--lead: 20px");
    // No empty column on the body's left: nothing pushes its lines or the option cards in to the head's text column.
    expect(layout).not.toContain("--text-edge");
    expect(layout).not.toContain(".ai-panel--plan > .grid-options {");
    // 14px icons and 20px numbers, centred in the numbers' 20px, 12px before the words. Only the panel's own lines: a
    // note inside a step's words ("Isso não parece uma chave…") keeps its icon on the step's text.
    const own = ".ai-panel--plan > :is(.ac-setnote, .setup-line, .ac-card__foot).ac-iconline";
    const row = ".ai-panel--plan .ai-panel__row > .ac-setnote";
    expect(layout).toContain(`\n${own},\n${row} {\n  gap: 12px;`);
    expect(layout).toContain(
      `\n${own} > :first-child,\n${row} > :first-child {\n  margin-inline: calc((var(--lead) - 14px) / 2);`,
    );
    expect(layout).not.toContain(".ai-panel--plan :is(.ac-setnote");
    expect(ruleOf(layout, ".ai-panel--plan .agp-addacct__step > i")).toContain(
      "margin-inline: calc((var(--lead) - 20px) / 2)",
    );
    // The well spans the panel's content, as far in from its right edge as from its left.
    const well = ruleOf(layout, ".ai-panel__wait");
    expect(well).toContain("padding: 12px 14px;");
    expect(well).not.toContain("margin");
    // Under the steps' bar its short lines break into two of a length, and so does its status or hold line without
    // the bar: at 320 px the panel's pretty wrap ends "Esperando um computador disponível" on its last word alone.
    // Without the bar the e-mail line runs the bar's column in the panel's wrap, so the well isn't empty on its right,
    // and balances where pretty isn't supported, which would end it on a word alone.
    expect(well).not.toContain("text-wrap");
    expect(ruleOf(layout, '.ai-panel__wait:has(> .setup-progress),\n.ai-panel__wait > [role="status"]')).toContain(
      "text-wrap: balance",
    );
    expect(ruleOf(layout, ".ai-panel")).toContain("text-wrap: pretty");
    expect(layout).toContain("@supports not (text-wrap: pretty) {\n  .ai-panel__wait {\n    text-wrap: balance;\n");
    // A step's wait goes under its words: its spinner in the numbers' column, its word where a numbered step's are.
    expect(ruleOf(layout, ".ai-panel--plan .agp-addacct__step > .agp-addacct__wait")).toContain(
      "margin-left: calc((var(--lead) - 14px) / 2)",
    );
    // So does the line standing in for a field while its code goes, from inside the step's words.
    expect(ruleOf(layout, ".ai-panel--plan .agp-addacct__busy")).toContain(
      "margin-left: calc((var(--lead) - 14px) / 2)",
    );
    expect(ruleOf(layout, ".ai-panel--plan .agp-addacct__step.ac-iconline .agp-addacct__busy")).toContain(
      "margin-left: calc((var(--lead) - 14px) / 2 - var(--lead) - 12px)",
    );
    // The head's hairline runs edge to edge, as the foot's does; for whom ends the name's line (a MediaRow's end), no
    // rise of its own.
    expect(ruleOf(layout, ".ai-panel__head")).toContain("margin-inline: calc(-1 * var(--card-pad))");
    expect(ruleOf(layout, ".ai-panel__agent")).not.toContain("margin-top");
    expect(ruleOf(layout, ".ai-panel__agent")).not.toContain("height");
  });

  test("a step's button sits right under its words, on their column, at every width; a failure's note sits in its button's middle", async () => {
    const layout = await stylesheet("../src/layout.css");
    // The words take the row and what acts on them wraps under: no width puts a button across the row from them.
    expect(ruleOf(layout, ".agp-addacct__step")).toContain("flex-wrap: wrap");
    expect(ruleOf(layout, ".agp-addacct__step")).toContain("line-height: 20px");
    // As far under the words as a field is under its title (the words' 4px gap and the field's 4px margin), and
    // nearer them than the next step, as far as a panel's groups.
    expect(ruleOf(layout, ".agp-addacct__step")).toContain("gap: 8px 12px");
    expect(layout).toContain("--ai-steps-gap: 16px");
    expect(ruleOf(layout, ".agp-addacct__text")).toContain("gap: 4px");
    expect(ruleOf(layout, ".agp-addacct__paste,\n.agp-addacct__code")).toContain("margin: 4px 0");
    expect(ruleOf(layout, ".agp-addacct__step:not(.ac-iconline) > .agp-addacct__text")).toContain("flex-basis: 100%");
    expect(ruleOf(layout, ".agp-addacct__step.ac-iconline > .agp-addacct__text")).toContain(
      "flex-basis: calc(100% - 32px)",
    );
    expect(ruleOf(layout, ".agp-addacct__step.ac-iconline > :not(i, .agp-addacct__text)")).toContain(
      "margin-left: 32px",
    );
    // A plan's panel adds nothing of its own: a step's button starts where its words do, as anywhere else.
    expect(layout).not.toContain(".ai-panel--plan .agp-addacct__step.ac-iconline > .agp-addacct__text");
    expect(layout).not.toContain(".ai-panel--plan .agp-addacct > .agp-addacct__step:not(.ac-iconline)");
    // None of it waits for a narrow screen, and nothing pulls the words down to a button beside them.
    for (const rule of [".agp-addacct__step {", ".agp-addacct__step:not(.ac-iconline) > .agp-addacct__text {"])
      expect(layout).toContain(`\n${rule}`);
    expect(layout).not.toContain(".agp-addacct__step:has(> .ac-btn--sm)");
    expect(layout).not.toContain("> .agp-addacct__step > .ac-btn--sm)");
    expect(await stylesheet("../src/responsive.css")).not.toContain(".agp-addacct__step");
    expect(ruleOf(layout, ".ai-panel__row")).toContain("align-items: center");
    expect(ruleOf(layout, ".ai-panel__row > .ac-setnote")).toContain("margin: 0");
    // In a plan's panel what went wrong is the sign-in's state: its buttons under the note's words, as a step's.
    expect(layout).toContain("\n.ai-panel--plan .ai-panel__row > .ac-setnote {\n  flex-basis: 100%;\n}");
    expect(ruleOf(layout, ".ai-panel--plan .ai-panel__row > :not(.ac-setnote)")).toContain(
      "margin-left: calc(var(--lead) + 12px)",
    );
    // A key's field takes its line: "Enviar ao Computador da Costa Atelier" goes under it, whatever the name.
    expect(ruleOf(layout, ".agp-addacct__paste .ac-input-affix")).toContain("flex: 1 1 100%");
  });

  test("a computer the person connected: the account their agents share, saved for the agent at once; or one just for it", async () => {
    const { state, dialog } = await connect({
      brain: { ownSignIn: true },
      computers: [{ ...MAC, own: { claude_code: { plan: "max" } } }],
    });
    // Who shares the sign-in, in the person's words, with the plan the computer says: never which computer it's on.
    const own = within(dialog).getByRole("button", { name: /^A conta que os seus agentes dividem/ });
    expect(own.querySelector(".ac-option__title")?.textContent).toBe("A conta que os seus agentes dividem");
    expect(own.querySelector(".ac-option__desc")?.textContent).toBe("Claude Max");
    expect(shownText(dialog)).not.toMatch(/login no|MacBook\b.*conta|Outra conta|todos os seus/);
    // Small columns, so the two cards sit side by side on the panel's text column in the setup too.
    expect(own.parentElement?.className).toBe("grid-options grid-options--sm");
    // Who it replies to is the foot's, once, either way.
    expect(within(dialog).getAllByRole("switch", { name: "Atende outras pessoas" })).toHaveLength(1);
    // One just for Ada: its title alone; then the sign-in, which asks for no address: Claude's own page does.
    const one = within(dialog).getByRole("button", { name: "Uma conta só para a Ada" });
    expect(one.textContent).toBe("Uma conta só para a Ada");
    await click(one);
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    expect(within(dialog).getAllByRole("switch", { name: "Atende outras pessoas" })).toHaveLength(1);
    expect(panel.querySelector("input")).toBeNull();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(shownText(panel)).not.toMatch(/Qual conta|Email da conta|opcional/);
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com Claude" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [ORG_ID, "machine_1", "claude_code"],
    ]);
    await click(own);
    await settle(4);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([ORG_ID, ADA_ID, { brain: "claude_code", account: null }]);
    expect(dialog.textContent).toContain("Ada agora pensa com a conta que os seus agentes dividem.");
  });

  test("all of them on a computer the person connected: the account their agents share, or one just for them, signed in for each", async () => {
    const { dialog } = await connect({
      crew: true,
      brain: { ownSignIn: true },
      computers: [{ ...MAC, own: { claude_code: { plan: "max" } } }],
    });
    await pickPlan(dialog, "Claude");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    // Never one agent's name while the panel is for all of them.
    expect(within(panel).queryByRole("button", { name: /^Uma conta só para (a|o) / })).toBeNull();
    await click(within(panel).getByRole("button", { name: "Uma conta só para eles" }));
    // Then one at a time, the first one's turn said above the faces, its sign-in the dialog's own action.
    expect(shownText(panel)).toContain("Entre no Claude para a Ada");
    expect(within(dialog).getByRole("button", { name: "Entrar no Claude" })).toBeTruthy();
  });

  test("a computer the person connected whose Claude isn't signed in: no account to share, only the sign-in", async () => {
    // The computer says its own sign-ins (`own`); with none for Claude Code, the first card would name no account.
    const { dialog, choose } = await connect({ brain: { ownSignIn: true } });
    const panel = () => within(dialog).getByRole("region", { name: /^Seu plano do/ });
    expect(within(dialog).queryByRole("button", { name: /^A conta que os seus agentes dividem/ })).toBeNull();
    expect(within(panel()).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    expect(within(panel()).getAllByRole("switch", { name: "Atende outras pessoas" })).toHaveLength(1);
    // ChatGPT's alike: none reported for Codex, so only its sign-in.
    await choose("ChatGPT");
    expect(within(panel()).queryByRole("button", { name: "A conta que os seus agentes dividem" })).toBeNull();
    expect(within(panel()).getByRole("button", { name: "Entrar com ChatGPT" })).toBeTruthy();
  });

  test("ChatGPT's own sign-in to share once the computer reports it (the usage it read with it)", async () => {
    const usage = { windows: [], source: "probe" as const, at: "2026-10-30T12:00:00.000Z" };
    const { dialog, choose } = await connect({
      brain: { ownSignIn: true },
      computers: [{ ...MAC, own: { codex: { usage } } }],
    });
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    expect(within(panel).getByRole("button", { name: "A conta que os seus agentes dividem" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Uma conta só para a Ada" })).toBeTruthy();
  });

  test("a plan its computer can't take: its logo dims, and its panel says why, with the key one click away", async () => {
    const { dialog, choose } = await connect({
      computers: [{ ...MAC, keys: false, brains: { claude_code: true, codex: false } }],
      brain: {
        options: [
          { kind: "model", available: true, models: [], defaultModel: null },
          { kind: "claude_code", available: true, models: [], defaultModel: "sonnet" },
          {
            kind: "codex",
            available: false,
            reason: "not_installed",

            models: [],
            defaultModel: null,
          },
        ],
      },
    });
    const rows = await openAiSelect(dialog);
    const dimmed = (name: string) => rows.find((o) => o.textContent === name)?.querySelector(".ac-brand--off") != null;
    expect(dimmed("Claude")).toBe(false);
    expect(dimmed("ChatGPT")).toBe(true);
    expect(dimmed("Kimi Code")).toBe(true);
    await closeAiSelect();
    await choose("ChatGPT");
    expect(dialog.textContent).toContain("O Codex não está instalado no MacBook.");
    await choose("Kimi Code");
    expect(dialog.textContent).toContain("Atualize o agentes no computador para usar a chave de um plano");
    await click(within(dialog).getByRole("button", { name: "Usar uma chave de API agora" }));
    expect(payWith(dialog, "Com chave de API").getAttribute("aria-checked")).toBe("true");
  });

  test("a plan whose tool is off on its computer: what it means, then three plain steps, or the command on Linux", async () => {
    const reason = async (os: string, name: string) => {
      cleanup();
      const options = fakeAgentBrain(ADA_ID).options.map((o) =>
        o.kind === "codex" ? { ...o, available: false, reason: "tool_off" as const } : o,
      );
      const { dialog, choose } = await connect({
        machine: { os, name, mode: "system" },
        brain: { computer: { machineId: "machine_1", name, online: true }, options },
      });
      await choose("ChatGPT");
      return dialog.textContent;
    };
    const server = await reason("linux", "Servidor");
    expect(server).toContain("O Servidor está conectado, mas o Codex está desligado nele.");
    expect(server).toContain("No Servidor");
    expect(server).toContain("No terminal do computador, rode:");
    expect(server).toContain("sudo agentes-runner tools enable codex");
    const mac = await reason("darwin", "MacBook");
    expect(mac).toContain("O MacBook está conectado, mas o Codex está desligado nele.");
    expect(mac).toContain("Clique no ícone do agentes.chat");
    expect(mac).toContain("Abra Preferências");
    expect(mac).toContain("Em Ferramentas, ligue Codex");
    // The arrow of hidden icons is a PC's.
    expect(mac).not.toContain("No Windows");
    expect(mac).toContain("Esperando você ligar. Esta tela muda sozinha.");
    expect(mac).toContain("Usar uma chave de API agora");
  });

  test("self-host with no computer for the agent: plans dim, the key comes first, and a plan's panel says to connect one", async () => {
    const { dialog, router } = await connect({ computers: [], brain: { computer: null, machines: [] } });
    expect(payWith(dialog, "Com chave de API").getAttribute("aria-checked")).toBe("true");
    await click(payWith(dialog, "Com um plano"));
    expect(aiSelect(dialog).querySelector(".ac-brand--off")).not.toBeNull();
    expect(dialog.textContent).toContain("As contas ficam num computador conectado. Conecte um seu primeiro.");
    await click(within(dialog).getByRole("button", { name: "Conectar um computador" }));
    await settle(4);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices`);
  });

  test("before the server says which edition this is: a wait, never a computer to connect", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [], computers: [] });
    // The Cloud's answer still on its way: self-host's words would send its people to pair a computer.
    api.machines.computerSetup = () => new Promise(() => {});
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(6);
    await click(screen().getByRole("button", { name: "Conectar uma IA" }));
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    expect(within(dialog).queryByRole("button", { name: "Conectar um computador" })).toBeNull();
    expect(dialog.textContent).not.toMatch(/Conecte um seu|computador conectado/);
  });

  test("on the Cloud while its computer is prepared: the wait in the panel, sign-in off, no computer to connect", async () => {
    const { state, dialog } = await connect({
      computers: [],
      brain: { computer: null, machines: [] },
      setup: {
        step: "installing",
        secondsLeft: 330,
        expectedReadyAt: new Date(Date.now() + 330_000).toISOString(),
        notifyByEmail: true,
      },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    // The computer's wait in one well: the team's line, how far, the time left, and the owner's email line (no
    // address, no clock).
    const well = panel.querySelector(".ai-panel__wait") as HTMLElement;
    expect(shownText(well)).toBe(
      "A Ada está arrumando as ferramentasPasso 3 de 4 · Instalando os programasFaltam uns 6 minAvisamos você por e-mail quando o computador ficar pronto. Pode fechar esta página.",
    );
    expect(panel.textContent).not.toContain("walter@");
    // "Ready" once, in the well: the sign-in's step says nothing more of when.
    const step = within(panel).getByText("A conta com o seu plano").closest(".agp-addacct__step") as HTMLElement;
    expect(shownText(step)).not.toContain("pronto");
    expect(panel.textContent?.split("pronto")).toHaveLength(2);
    expect((within(panel).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Conectar um computador" })).toBeNull();
    expect(dialog.textContent).not.toMatch(/Conecte um seu|computador conectado|seu computador/);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
  });

  test("on the Cloud waiting for a computer: the well's status line, then the owner's email line", async () => {
    const { dialog } = await connect({
      computers: [],
      brain: { computer: null, machines: [] },
      setup: { state: "waiting", reason: "capacity", notifyByEmail: true },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    const well = panel.querySelector(".ai-panel__wait") as HTMLElement;
    // layout.css balances the status line by its role, and lets the email line run the well's width.
    expect([...well.children].map((p) => [p.textContent, p.getAttribute("role")])).toEqual([
      ["Esperando um computador disponível", "status"],
      ["Avisamos você por e-mail quando o computador ficar pronto. Pode fechar esta página.", null],
    ]);
  });

  test("an admin while the Cloud's computer is prepared: no email for them, so the well says when the step turns on", async () => {
    const { dialog, choose } = await connect({
      role: "admin",
      computers: [],
      brain: { computer: null, machines: [] },
      setup: {
        step: "installing",
        secondsLeft: 330,
        expectedReadyAt: new Date(Date.now() + 330_000).toISOString(),
        notifyByEmail: true,
      },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(shownText(panel.querySelector(".ai-panel__wait") as HTMLElement)).toBe(
      "A Ada está arrumando as ferramentasPasso 3 de 4 · Instalando os programasFaltam uns 6 minVocê entra aqui assim que o computador ficar pronto.",
    );
    expect(panel.textContent?.split("pronto")).toHaveLength(2);
    // A coding plan's step sends a key.
    await choose("GLM Coding");
    const glm = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    expect(glm.querySelector(".ai-panel__wait")?.lastElementChild?.textContent).toBe(
      "Você envia a chave assim que o computador ficar pronto.",
    );
  });

  test("on the Cloud, its computer not answering: said by name, looked after, a key meanwhile", async () => {
    const workspace: AiComputer = { ...MAC, machineId: "managed_1", name: "Computador da Acme", online: false };
    const { dialog } = await connect({
      computers: [workspace],
      setup: { state: "ready" },
      brain: { computer: { machineId: "managed_1", name: "Computador da Acme", online: false } },
    });
    expect(dialog.textContent).toContain(
      "O Computador da Acme está reiniciando ou se reconectando. Isto muda sozinho quando ele voltar.",
    );
    expect(within(dialog).getByRole("button", { name: "Usar uma chave de API agora" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/Seu computador está desligado|desligado/);
  });

  test("on the Cloud, a plan's program being installed: said so, a key meanwhile, and its sign-in once it's there", async () => {
    const workspace: AiComputer = { ...MAC, machineId: "managed_1", name: "Computador da Acme" };
    const options = (available: boolean) =>
      fakeAgentBrain(ADA_ID).options.map((o) =>
        o.kind === "codex" ? { ...o, available, ...(available ? {} : { reason: "not_installed" as const }) } : o,
      );
    const where = { machineId: "managed_1", name: "Computador da Acme", online: true };
    const { api, dialog, choose, services } = await connect({
      computers: [workspace],
      setup: { state: "ready", machineId: "managed_1", since: new Date().toISOString() },
      brain: { computer: where, options: options(false) },
    });
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    expect(panel.textContent).toContain(
      "O Codex está sendo instalado no Computador da Acme. Isto muda sozinho quando terminar.",
    );
    expect(panel.textContent).not.toContain("Ainda não está pronto");
    expect(within(panel).getByRole("button", { name: "Usar uma chave de API agora" })).toBeTruthy();
    // The computer says it found the program: the panel signs in, with no reload.
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await viewOf(orgId, agentId)), options: options(true) });
    await act(async () => {
      applyMachineEvent(services.queryClient, ORG_ID, {
        type: "machine.updated",
        machineId: "managed_1",
        executors: true,
      } as { type: string });
    });
    await settle(6);
    expect(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })).toBeTruthy();
    expect(panel.textContent).not.toContain("sendo instalado");
  });

  test("on the Cloud, a program that never arrived: no promise of an install, and a key is the way on", async () => {
    const options = fakeAgentBrain(ADA_ID).options.map((o) =>
      o.kind === "codex" ? { ...o, available: false, reason: "not_installed" as const } : o,
    );
    const { dialog, choose } = await connect({
      computers: [{ ...MAC, machineId: "managed_1", name: "Computador da Acme" }],
      setup: { state: "ready", machineId: "managed_1", since: "2026-01-01T00:00:00.000Z" },
      brain: { computer: { machineId: "managed_1", name: "Computador da Acme", online: true }, options },
    });
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    expect(panel.textContent).toContain("não vai mudar sozinho");
    expect(panel.textContent).not.toContain("sendo instalado");
    expect(within(panel).getByRole("button", { name: "Usar uma chave de API agora" })).toBeTruthy();
  });

  test("on the Cloud, the program not allowed there: it's on our side, never a wait", async () => {
    const options = fakeAgentBrain(ADA_ID).options.map((o) =>
      o.kind === "codex" ? { ...o, available: false, reason: "tool_off" as const } : o,
    );
    const { dialog, choose } = await connect({
      computers: [{ ...MAC, machineId: "managed_1", name: "Computador da Acme" }],
      setup: { state: "ready", machineId: "managed_1" },
      brain: { computer: { machineId: "managed_1", name: "Computador da Acme", online: true }, options },
    });
    await choose("ChatGPT");
    expect(dialog.textContent).toContain(
      "O Codex ainda não está liberado no Computador da Acme. Isso é do nosso lado: tente de novo mais tarde.",
    );
    expect(within(dialog).getByRole("button", { name: "Usar uma chave de API agora" })).toBeTruthy();
  });

  test("the email's link on a cold load: once the agents arrive, Claude's sign-in for the viewer's agent", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    machines?.pair({ id: "machine_1", name: "MacBook", agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }] });
    machines?.setAiAccounts({ accounts: [], computers: [MAC] });
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await viewOf(orgId, agentId)), ownSignIn: false });
    // The agents' list answers only after the dialog opened.
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const list = api.agents.list;
    api.agents.list = async (orgId) => {
      await arrived;
      return list(orgId);
    };
    await renderApp(`/org/${ORG_ID}?connect=ai`, { api });
    // Nobody named, and Ada already thinks: nobody to wake, so once the agents are known it is the picker, on Claude.
    await act(async () => arrive());
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    expect(dialog.querySelector(".ac-spinner, .ac-pixspin")).toBeNull();
  });

  test("Outro provedor in the panel: its Salvar e testar comes up once the form can be saved, no greyed button before", async () => {
    const { dialog } = await connect();
    await chooseAi(dialog, "Chave de API");
    await chooseAi(dialog, "Outro provedor", true);
    await settle(3);
    expect(within(dialog).queryByRole("button", { name: "Salvar e testar" })).toBeNull();
    await type(within(dialog).getByLabelText("Nome"), "OpenGateway");
    await type(within(dialog).getByLabelText("Endereço"), "https://gw.example/v1");
    const typed = within(dialog).getByLabelText("Adicionar um modelo");
    await type(typed, "llama-4");
    await act(async () => fireEvent.keyDown(typed, { key: "Enter" }));
    await settle();
    expect(within(dialog).getByRole("button", { name: "Salvar e testar" }).hasAttribute("disabled")).toBe(false);
  });

  test("a plan for Ada, then the API key for the rest: its field is there, and only a saved key says it's saved", async () => {
    const { state, machines, dialog, choose } = await connect();
    machines?.endLogin("login_1", { state: "done", account: claudeMax });
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(8);
    expect(dialog.textContent).toContain("Ada agora pensa com Claude Max.");
    await choose("Chave de API");
    const panel = within(dialog).getByRole("region", { name: "Chave de API" });
    // Right under its select; Claude's panel is gone from above it.
    expect(aiSelect(dialog, "Provedor").closest(".ac-select")?.nextElementSibling).toBe(panel);
    expect(within(dialog).queryByRole("region", { name: "Seu plano do Claude" })).toBeNull();
    // The way to pay just chosen already names it: no head again, and who charges for it, once.
    expect(panel.querySelector(".ai-panel__head")).toBeNull();
    expect(shownText(panel).split("Você paga pelo uso, direto ao provedor.")).toHaveLength(2);
    expect(shownText(panel)).toContain("Todo agente sem plano pensa com ela.");
    // Every maker, the most used first; a workspace's own endpoint last (ADR 0146).
    const makers = await openAiSelect(dialog, "Provedor");
    expect(makers.map((o) => o.textContent)).toEqual([
      "Claude",
      "OpenAI",
      "Gemini",
      "OpenRouter",
      "DeepSeek",
      "Kimi",
      "Z.ai",
      "MiniMax",
      expect.stringContaining("Outro provedor"),
    ]);
    await closeAiSelect();
    // OpenRouter passes what is sent on to other providers: its privacy settings say who may keep it, in the ⓘ.
    await chooseAi(dialog, "OpenRouter", true);
    expect(hintOf("Crie a sua chave de API OpenRouter", panel)).toMatchObject({
      text: "As configurações de privacidade da OpenRouter decidem quais provedores podem guardar o que seus agentes enviam.",
      hidden: true,
    });
    expect(within(panel).getByRole("link", { name: "Abrir openrouter.ai" }).getAttribute("href")).toBe(
      "https://openrouter.ai/keys",
    );
    expect(within(panel).getByLabelText("Cole aqui").getAttribute("placeholder")).toBe("sk-or-v1-…");
    // A maker with coding plans: where a plan's key goes is the first step's ⓘ, with no line under it.
    await chooseAi(dialog, "Kimi", true);
    expect(hintOf("Crie a sua chave de API Kimi", panel).text).toBe(
      "A chave de um plano de código vai na opção dele, acima.",
    );
    expect(shownText(panel)).not.toContain("plano de código");
    // Gemini: its free tier may use what the agents send, so the first step's ⓘ says to turn on billing.
    await chooseAi(dialog, "Gemini", true);
    expect(hintOf("Crie a sua chave de API Gemini", panel)).toMatchObject({
      text: "Ative o faturamento no projeto da chave. Sem faturamento, o Google pode usar o que os agentes enviam.",
      hidden: true,
    });
    expect(shownText(panel)).not.toContain("faturamento");
    expect(within(panel).getByRole("link", { name: "Abrir aistudio.google.com" }).getAttribute("href")).toBe(
      "https://aistudio.google.com/api-keys",
    );
    expect(within(panel).getByLabelText("Cole aqui").getAttribute("placeholder")).toBe("AQ.…");
    // A maker that publishes no prefix for its keys: no example in the field, never a bare "…".
    await chooseAi(dialog, "Z.ai", true);
    expect(within(panel).getByLabelText("Cole aqui").hasAttribute("placeholder")).toBe(false);
    await chooseAi(dialog, "Claude", true);
    expect(within(panel).getByLabelText("Cole aqui").getAttribute("placeholder")).toBe("sk-ant-…");
    expect(within(panel).queryByRole("button", { name: /^Sobre Crie a sua chave/ })).toBeNull();
    expect(panel.textContent).not.toContain("Salva.");
    // No greyed Save under an empty field: it comes up with a key to save.
    expect(within(panel).queryByRole("button", { name: "Salvar chave" })).toBeNull();
    await type(within(panel).getByLabelText("Cole aqui"), "sk-ant-api03-abcdefghijklmnop");
    await click(within(panel).getByRole("button", { name: "Salvar chave" }));
    await settle(4);
    expect(calls(state, "agents.addCredential")).toHaveLength(1);
    expect(panel.textContent).toContain("Salva. Todo agente sem plano pensa com ela.");
  });

  test("while a key saves, nothing that belongs to it moves: the way to pay, its maker, the field", async () => {
    const { api, dialog, choose } = await connect();
    api.agents.addCredential = () => new Promise(() => {});
    await choose("Chave de API");
    const panel = within(dialog).getByRole("region", { name: "Chave de API" });
    await type(within(panel).getByLabelText("Cole aqui"), "sk-ant-api03-abcdefghijklmnop");
    await click(within(panel).getByRole("button", { name: "Salvar chave" }));
    expect(within(panel).getByLabelText("Cole aqui").closest("fieldset[disabled]")).not.toBeNull();
    expect(aiSelect(dialog, "Provedor").hasAttribute("disabled")).toBe(true);
    expect(payWith(dialog, "Com um plano").hasAttribute("disabled")).toBe(true);
  });

  test("a sign-in started once the computer is ready is stopped on that computer when its panel goes", async () => {
    const workspace: AiComputer = { ...MAC, machineId: "managed_1", name: "Computador da Acme" };
    const { state, api, machines, dialog, choose, services } = await connect({
      computers: [],
      brain: { computer: null, machines: [] },
      setup: {
        step: "installing",
        secondsLeft: 330,
        expectedReadyAt: new Date(Date.now() + 330_000).toISOString(),
        notifyByEmail: true,
      },
    });
    const signIn = () =>
      within(dialog).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement | HTMLAnchorElement;
    expect((signIn() as HTMLButtonElement).disabled).toBe(true);
    // It turns ready while the person watches.
    const waiting = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await waiting(orgId, agentId)),
      computer: { machineId: "managed_1", name: "Computador da Acme", online: true },
    });
    machines?.setAiAccounts({ accounts: [], computers: [workspace] });
    machines?.setSetup({ state: "ready", machineId: "managed_1" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(8);
    await withPopup(() => click(signIn()));
    await settle(4);
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([ORG_ID, "managed_1", "claude_code"]);
    // Another plan: the sign-in stops where it runs.
    await choose("ChatGPT");
    expect(calls(state, "machines.cancelAccountLogin").map((c) => c.args)).toEqual([[ORG_ID, "managed_1", "login_1"]]);
  });

  test("on the Cloud the account's sign-in says the computer, never its name: asking it, the button, the code sent", async () => {
    const workspace: AiComputer = { ...MAC, machineId: "managed_1", name: "Computador da Acme" };
    const { state, api, dialog } = await connect({
      computers: [workspace],
      setup: { state: "ready", machineId: "managed_1" },
      brain: { computer: { machineId: "managed_1", name: "Computador da Acme", online: true } },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    const begin = api.machines.beginAccountLogin;
    let answer = () => {};
    api.machines.beginAccountLogin = async (...args) => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return begin(...args);
    };
    await withPopup(async () => {
      await click(within(panel).getByRole("button", { name: "Entrar com Claude" }));
      expect(shownText(panel)).toContain("Pedindo ao computador…");
      await act(async () => answer());
      await settle(6);
    });
    await type(within(panel).getByRole("textbox", { name: "Código do Claude" }), "c0de");
    expect(within(panel).getByRole("button", { name: "Enviar ao computador" })).toBeTruthy();
    // This sign-in's code goes by itself.
    await type(within(panel).getByRole("textbox", { name: "Código do Claude" }), "c0de#st4te");
    await sealed(panel, 4);
    expect(calls(state, "machines.sendAccountCode")).toHaveLength(1);
    expect(shownText(panel)).toContain("Código enviado. O computador está terminando de entrar.");
    // Its hints too.
    expect(panel.querySelector(".agp-addacct")?.textContent).not.toContain("Acme");
    // English puts the unnamed computer ("the computer") mid-sentence, never where a capital would go.
    const lines = (o: unknown): string[] => (typeof o === "string" ? [o] : Object.values(o as object).flatMap(lines));
    expect(lines(en.agentPage.work.brain.add).filter((l) => /(^|[.?!]\s+)\{\{computer\}\}/.test(l))).toEqual([]);
  });

  test("the agent's view failing to load again mid-sign-in: the steps stay, and nothing is stopped", async () => {
    const { state, api, dialog, services } = await connect();
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(6);
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
    api.agents.brain = async () => {
      throw new ApiError(503, "unavailable", "Restarting");
    };
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.agentBrain(ORG_ID, ADA_ID) }));
    await settle(6);
    expect(panel.textContent).not.toContain("Não foi possível carregar");
    expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("for which agent: another plan keeps the one chosen; once it thinks with a plan, the next one moves on", async () => {
    const { state, machines, dialog, choose, services } = await connect({ mine: [ADA_ID, ATLAS_ID] });
    state.aiStatus = {
      any: false,
      agents: [
        { agentId: ADA_ID, state: "no_ai", reason: "no_key" },
        { agentId: ATLAS_ID, state: "no_ai", reason: "no_key" },
      ],
    };
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
    await settle(4);
    const agent = () => within(dialog).getByRole("combobox", { name: "Agentes que usam este plano" });
    expect(agent().textContent).toContain("Ada");
    agent().focus();
    await act(async () => fireEvent.keyDown(agent(), { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Atlas" }));
    await choose("ChatGPT");
    expect(agent().textContent).toContain("Atlas");
    // Atlas signs in with ChatGPT: the next plan is for Ada.
    machines?.endLogin("login_1", {
      state: "done",
      account: account({ id: "acct_plus", kind: "codex", label: "ChatGPT Plus", provider: null, keyHint: null }),
    });
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(8);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ATLAS_ID,
      { brain: "codex", account: "acct_plus" },
    ]);
    expect(dialog.textContent).toContain("Atlas agora pensa com ChatGPT Plus.");
    await choose("Claude");
    expect(agent().textContent).toContain("Ada");
  });

  test("a hold on the workspace while its computer is prepared: the panel says the hold alone, sign-in off", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const me = state.me;
    if (me) me.organizations = me.organizations.map((o) => ({ ...o, standing: { state: "hold", reason: null } }));
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ step: "installing", secondsLeft: 330, notifyByEmail: true });
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [], computers: [] });
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await viewOf(orgId, agentId)),
      ownSignIn: false,
      computer: null,
      machines: [],
    });
    await renderApp(`/org/${ORG_ID}?connect=ai`, { api });
    await settle(8);
    const panel = within(screen().getByRole("dialog", { name: "Conectar uma IA" })).getByRole("region", {
      name: "Seu plano do Claude",
    });
    expect(panel.textContent).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(panel.textContent).not.toMatch(/Faltam|Avisamos|Você entra aqui/);
    expect((within(panel).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Atende outras pessoas, in the plan's panel", () => {
  const replies = (inside: HTMLElement, name = "Atende outras pessoas") => within(inside).getByRole("switch", { name });

  test("off by default; on before the sign-in, the move carries it; after, it changes at once", async () => {
    const { state, machines, dialog, choose } = await connect();
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    const line = () => panel.querySelector(".plan-replies__terms > span")?.textContent;
    expect(replies(panel).getAttribute("aria-checked")).toBe("false");
    expect(line()).toBe("A Ada só atende você, pelo seu plano do ChatGPT.");
    expect(hintOf("os termos do plano", panel).text).toContain("Os planos do ChatGPT são para uso pessoal.");
    // Nothing thinks with the plan yet: nothing to save, and the line already says what on does.
    await click(replies(panel));
    expect(replies(panel).getAttribute("aria-checked")).toBe("true");
    expect(line()).toBe("A Ada atende quem pode falar com ela, pelo seu plano do ChatGPT.");
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
    machines?.endLogin("login_1", {
      state: "done",
      account: account({ id: "acct_plus", kind: "codex", label: "ChatGPT Plus", provider: null, keyHint: null }),
    });
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(8);
    expect(calls(state, "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { brain: "codex", account: "acct_plus", onlyOwner: false }],
    ]);
    expect(dialog.textContent).toContain("Ada agora pensa com ChatGPT Plus.");
    // Ada thinks with it now: off saves at once, with nothing asked.
    await click(replies(panel));
    expect(calls(state, "agents.setBrain").at(-1)?.args).toEqual([ORG_ID, ADA_ID, { onlyOwner: true }]);
    expect(replies(panel).getAttribute("aria-checked")).toBe("false");
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
  });

  test("an agent already on the plan's brain shows its own, and the account their agents share keeps it", async () => {
    const { state, dialog } = await connect({
      brain: { ownSignIn: true },
      computers: [{ ...MAC, own: { claude_code: { plan: "max" } } }],
      ada: { brain: { kind: "claude_code", model: "Sonnet" }, audience: { mode: "everyone", userIds: [] } },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(replies(panel).getAttribute("aria-checked")).toBe("true");
    await click(within(panel).getByRole("button", { name: /^A conta que os seus agentes dividem/ }));
    await settle(4);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "claude_code", account: null, onlyOwner: false },
    ]);
  });

  test("Só algumas pessoas with nobody picked: on lets nobody in, so it goes back off and says to pick people", async () => {
    const { state, dialog } = await connect({
      ada: { brain: { kind: "claude_code", model: "Sonnet" }, audience: { mode: "people", userIds: [] } },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(replies(panel).getAttribute("aria-checked")).toBe("false");
    await click(replies(panel));
    await settle(4);
    expect(calls(state, "agents.setBrain").at(-1)?.args).toEqual([ORG_ID, ADA_ID, { onlyOwner: false }]);
    expect(replies(panel).getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain(
      "A Ada só atende as pessoas escolhidas, e ninguém foi escolhido ainda. Escolha em Quem pode falar.",
    );
  });

  test("an agent on the computer's own sign-in, a Team seat there: the seat's words before anything is chosen", async () => {
    const { dialog } = await connect({
      brain: { brain: "claude_code", account: null, ownSignIn: true },
      computers: [{ ...MAC, own: { claude_code: { plan: "team" } } }],
      ada: { brain: { kind: "claude_code", model: "Sonnet" } },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.querySelector(".plan-replies__terms > span")?.textContent).toBe(
      "A Ada atende quem pode falar com ela, pelo seu assento do Claude.",
    );
    expect(hintOf("os termos do plano", panel).text).toBe(
      "Cada assento do Claude é de uma pessoa só. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do Claude.",
    );
  });
});

describe("All agents: one plan for the team, a login per agent", () => {
  test("the team's first screen: whom on one line, the AIs as the list, a plan asking one login per agent says so", async () => {
    const { dialog } = await connect({ crew: true });
    expect(inBand(dialog)).toBe(true);
    expect(shownText(dialog)).toContain("Conectar uma IA para o time");
    const line = dialog.querySelector(".arrival-forline") as HTMLElement;
    expect(line.querySelectorAll(".ac-avatar")).toHaveLength(3);
    expect(shownText(line)).toBe("3 agentes sem IAEscolher");
    // No tabs and no select: the AIs are the list. On the MacBook each agent signs in to Claude on its own.
    expect(dialog.querySelector(".ai-picker")).toBeNull();
    const tag = (name: RegExp) => within(dialog).getByRole("button", { name }).querySelector(".arrival-opts__tag");
    expect(tag(/^Claude/)?.textContent).toBe("Um login por agente");
    expect(tag(/^ChatGPT/)?.textContent).toBe("Um login por agente");
    // The footer: the quiet note at its start, "Not now" at its end.
    expect(shownText(dialog.querySelector(".ac-dialog__foot") as HTMLElement)).toBe(
      "Sem uma IA, os agentes não respondem.Agora não",
    );
    cleanup();
    // Where one sign-in thinks for all of them, nothing to warn about.
    const SHARING: AiComputer = { ...MAC, shares: { claude_code: true, codex: true, key: true } };
    const shared = await connect({ crew: true, computers: [SHARING] });
    expect(
      within(shared.dialog)
        .getByRole("button", { name: /^Claude/ })
        .querySelector(".arrival-opts__tag"),
    ).toBeNull();
  });

  test("Choose: one row per agent, all checked; the footer counts them, and the plan's steps are for those kept", async () => {
    const { dialog } = await connect({ crew: true });
    const boxes = () => within(dialog).getAllByRole("checkbox");
    await click(within(dialog).getByRole("button", { name: "Escolher" }));
    expect(shownText(dialog)).toContain("Para quais agentes");
    expect([...dialog.querySelectorAll(".arrival-pick__name")].map((n) => n.textContent)).toEqual([
      "Ada",
      "Atlas",
      "Lia",
    ]);
    expect(boxes().map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    await click(boxes()[2] as HTMLElement);
    expect(shownText(dialog)).toContain("2 de 3 marcados.");
    // Back leaves it as it was.
    await click(within(dialog).getByRole("button", { name: "Voltar" }));
    expect(shownText(dialog)).toContain("3 agentes sem IA");
    await click(within(dialog).getByRole("button", { name: "Escolher" }));
    for (const box of boxes()) await click(box);
    expect((within(dialog).getByRole("button", { name: /^Usar este/ }) as HTMLButtonElement).disabled).toBe(true);
    await click(boxes()[0] as HTMLElement);
    await click(boxes()[1] as HTMLElement);
    await click(within(dialog).getByRole("button", { name: "Usar estes 2" }));
    expect(shownText(dialog)).toContain("2 de 3 agentes sem IA");
    await pickPlan(dialog, "Claude");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect([...panel.querySelectorAll(".ai-strip__face")].map((li) => li.getAttribute("title"))).toEqual([
      "Ada",
      "Atlas",
    ]);
    expect(shownText(panel)).toContain("1 de 2");
  });

  test("Claude for all: one sign-in per agent, the first one's account the next ones' hint, each agent its own login", async () => {
    const { state, machines, dialog } = await connect({ crew: true });
    const max = (n: number) =>
      account({
        id: `acct_${n}`,
        label: "Claude Max",
        plan: "max",
        provider: null,
        keyHint: null,
        email: "walt@acme.com",
      });
    for (const n of [1, 2, 3]) machines?.endLogin(`login_${n}`, { state: "done", account: max(n) });
    await pickPlan(dialog, "Claude");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(facesOf(panel)).toEqual(["now", "next", "next"]);
    // One instruction at a time: how far along, whose turn, the help under it; the sign-in is the dialog's action.
    expect(shownText(panel)).toContain("É a mesma conta. O Claude só pede o login de novo para cada agente.");
    expect(shownText(panel)).not.toContain("Um login por agente, com a mesma conta.");
    for (const [n, line] of [
      [1, "Entre no Claude para a Ada"],
      [2, "Entre no Claude para o Atlas"],
      [3, "Entre no Claude para a Lia"],
    ] as const) {
      expect(shownText(panel)).toContain(`${n} de 3`);
      expect(shownText(panel)).toContain(line);
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar no Claude" })));
      await settle(8);
    }
    // The first asks for no account; each next one names the first's to Claude's page, unseen.
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      undefined,
      { email: "walt@acme.com" },
      { email: "walt@acme.com" },
    ]);
    // Each agent thinks with a login of its own, all under the account's name; none refused, none removed.
    expect(calls(state, "agents.setBrain").map((c) => [c.args[1], c.args[2]])).toEqual([
      [ADA_ID, { brain: "claude_code", account: "acct_1" }],
      [ATLAS_ID, { brain: "claude_code", account: "acct_2" }],
      [LIA_ID, { brain: "claude_code", account: "acct_3" }],
    ]);
    expect(calls(state, "machines.removeAccount")).toHaveLength(0);
    // They all woke: the team's words, every face checked, and whom they answer with the way to let the team in.
    expect(shownText(dialog)).toContain("O time acordou");
    expect(shownText(dialog)).toContain("Eles já pensam com o seu Claude");
    expect(facesOf(dialog)).toEqual(["done", "done", "done"]);
    expect(shownText(dialog)).toContain("Com a sua assinatura, eles respondem só a você.");
    await click(within(dialog).getByRole("button", { name: "Liberar para o time" }));
    await settle(4);
    expect(
      calls(state, "agents.setBrain")
        .slice(3)
        .map((c) => [c.args[1], c.args[2]]),
    ).toEqual([
      [ADA_ID, { onlyOwner: false }],
      [ATLAS_ID, { onlyOwner: false }],
      [LIA_ID, { onlyOwner: false }],
    ]);
  });

  test("a login that didn't end for one agent: said in its place, Skip passes over that agent, and the end says who stayed", async () => {
    const { state, machines, dialog } = await connect({ crew: true });
    const max = (n: number) =>
      account({
        id: `acct_${n}`,
        label: "Claude Max",
        plan: "max",
        provider: null,
        keyHint: null,
        email: "walt@acme.com",
      });
    machines?.endLogin("login_1", { state: "done", account: max(1) });
    machines?.endLogin("login_2", { state: "failed" });
    machines?.endLogin("login_3", { state: "done", account: max(3) });
    await pickPlan(dialog, "Claude");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    for (const _ of [1, 2]) {
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar no Claude" })));
      await settle(8);
    }
    expect(shownText(panel)).toContain("2 de 3");
    expect(shownText(panel)).toContain("O login do Atlas não terminou");
    expect(shownText(panel)).toContain("Não deu para entrar nessa conta. Tente de novo.");
    expect(facesOf(panel)).toEqual(["done", "failed", "next"]);
    // Its way on is the footer: skip him, or try again.
    expect([...dialog.querySelectorAll(".arrival-chat__acts .ac-btn")].map((b) => b.textContent)).toEqual([
      "Pular o Atlas",
      "Tentar de novo",
    ]);
    await click(within(dialog).getByRole("button", { name: "Pular o Atlas" }));
    expect(shownText(panel)).toContain("Entre no Claude para a Lia");
    expect(facesOf(panel)).toEqual(["done", "failed", "now"]);
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar no Claude" })));
    await settle(8);
    expect(calls(state, "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID, LIA_ID]);
    expect(shownText(dialog)).toContain("2 agentes acordaram");
    expect(shownText(dialog)).toContain("O Atlas ficou sem IA: o login dele não terminou.");
    expect(facesOf(dialog)).toEqual(["done", "failed", "done"]);
    // Connecting him starts over for him alone: one agent, so no faces, only the sign-in.
    await click(within(dialog).getByRole("button", { name: "Conectar o Atlas" }));
    expect(within(dialog).getByRole("region", { name: "Seu plano do Claude" })).toBeTruthy();
    expect(dialog.querySelector(".ai-strip")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
  });

  test("Claude for all where one sign-in thinks for all of them: one sign-in, then every agent on that account", async () => {
    const SHARING: AiComputer = { ...MAC, shares: { claude_code: true, codex: true, key: true } };
    const { state, machines, dialog } = await connect({ crew: true, computers: [SHARING] });
    machines?.endLogin("login_1", { state: "done", account: { ...claudeMax, shared: true } });
    await pickPlan(dialog, "Claude");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(hintOf("Um login só para todos.", panel).text).toBe("Todos dividem os limites do seu plano.");
    expect(shownText(panel)).not.toContain("Um login por agente");
    // No one at a time: one sign-in, its own words, and no faces.
    expect(panel.querySelector(".ai-strip")).toBeNull();
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(8);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(1);
    expect(calls(state, "agents.setBrain").map((c) => [c.args[1], c.args[2]])).toEqual([
      [ADA_ID, { brain: "claude_code", account: "acct_max" }],
      [ATLAS_ID, { brain: "claude_code", account: "acct_max" }],
      [LIA_ID, { brain: "claude_code", account: "acct_max" }],
    ]);
    expect(shownText(dialog)).toContain("O time acordou");
    expect(shownText(dialog)).toContain("Eles já pensam com o seu Claude");
  });

  test("an account of the plan that already thinks for all of the person's agents: Use it, with no sign-in", async () => {
    const SHARING: AiComputer = { ...MAC, shares: { claude_code: true, codex: true, key: true } };
    const shared = { ...claudeMax, shared: true, usedBy: ["Atlas"] };
    const { state, dialog } = await connect({ brain: { accounts: [shared] }, computers: [SHARING] });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    const use = within(panel).getByRole("button", { name: /^Usar Claude Max/ });
    expect(use.querySelector(".ac-option__desc")?.textContent).toBe("Também usada por Atlas");
    // The sign-in waits behind Another account.
    expect(within(panel).queryByRole("button", { name: "Entrar com Claude" })).toBeNull();
    await click(within(panel).getByRole("button", { name: "Outra conta" }));
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    await click(use);
    await settle(4);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "claude_code", account: "acct_max" },
    ]);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
    expect(dialog.textContent).toContain("Ada agora pensa com Claude Max.");
  });

  test("an agent on the API key stays out of All agents: a plan would make it answer only its owner", async () => {
    const { state, dialog, choose, services } = await connect({ crew: true });
    state.aiStatus = {
      any: true,
      agents: [
        { agentId: ADA_ID, state: "no_ai", reason: "no_key" },
        { agentId: ATLAS_ID, state: "ready" },
        { agentId: LIA_ID, state: "no_ai", reason: "no_key" },
      ],
    };
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
    await settle(4);
    await choose("Claude");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect([...panel.querySelectorAll(".ai-strip__face")].map((li) => li.getAttribute("title"))).toEqual([
      "Ada",
      "Lia",
    ]);
    expect(shownText(panel)).toContain("1 de 2");
  });

  test("GLM for all: one paste, the key sealed to one login per agent (in no request), each agent on its own", async () => {
    const { state, machines, dialog, choose } = await connect({ crew: true });
    const acct = (n: number) =>
      account({ id: `acct_${n}`, label: "GLM Coding", usedBy: [], provider: "zai", keyHint: "MnOp" });
    for (const n of [1, 2, 3]) machines?.endLogin(`login_${n}`, { state: "done", account: acct(n) });
    await choose("GLM Coding");
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    // The steps look like one agent's: no sign-in per agent to say.
    expect(shownText(panel)).not.toContain("Um login por agente");
    expect(machines?.logins()).toEqual([]);
    const KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";
    await type(within(panel).getByLabelText("Chave do GLM Coding"), KEY);
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await sealed(panel);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual(
      [1, 2, 3].map(() => [ORG_ID, "machine_1", "claude_code", { provider: "zai" }]),
    );
    const boxes = machines?.logins().map((l) => JSON.stringify(l.box)) ?? [];
    expect(new Set(boxes).size).toBe(3);
    expect(JSON.stringify(state.calls)).not.toContain("0123456789abcdef");
    expect(calls(state, "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { brain: "claude_code", account: "acct_1" }],
      [ORG_ID, ATLAS_ID, { brain: "claude_code", account: "acct_2" }],
      [ORG_ID, LIA_ID, { brain: "claude_code", account: "acct_3" }],
    ]);
    // They all woke: the team's words in place of the panel.
    expect(shownText(dialog)).toContain("Eles já pensam com o seu GLM Coding");
    expect(within(dialog).queryByRole("button", { name: "Enviar ao MacBook" })).toBeNull();
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("GLM for all, closed midway: only the logins still running stop", async () => {
    const { state, machines, dialog, choose } = await connect({ crew: true });
    machines?.endLogin("login_1", { state: "done", account: account({ id: "acct_1" }) });
    await choose("GLM Coding");
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    await type(
      within(panel).getByLabelText("Chave do GLM Coding"),
      "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp",
    );
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await sealed(panel);
    await click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(calls(state, "machines.cancelAccountLogin").map((c) => c.args[2])).toEqual(["login_2", "login_3"]);
  });

  test("GLM for all as the server moves each agent: whom it's for and its steps hold while the logins land a poll apart", async () => {
    const { state, api, machines, dialog, choose, services } = await connect({ crew: true });
    serverMoves(state, api, GLM);
    const land = (n: number) =>
      machines?.endLogin(`login_${n}`, { state: "done", account: account({ id: `acct_${n}` }) });
    land(1);
    await choose("GLM Coding");
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    await type(within(panel).getByLabelText("Chave do GLM Coding"), GLM_KEY);
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await sealed(panel);
    // Ada has an AI now, the first that had none: the panel stays on everyone, the key sent once.
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(3);
    // Until the last login lands, a line stands in for the key's field and its buttons.
    expect(within(panel).queryByLabelText("Chave do GLM Coding")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Enviar ao MacBook" })).toBeNull();
    expect(shownText(panel)).toContain("Chave enviada. O MacBook está terminando de entrar.");
    for (const n of [2, 3]) {
      land(n);
      const poll = keys.accountLogin(ORG_ID, "machine_1", `login_${n}`);
      await act(() => services.queryClient.invalidateQueries({ queryKey: poll }));
      await settle(12);
    }
    // They all woke: the team's words in place of the panel.
    expect(shownText(dialog)).toContain("Eles já pensam com o seu GLM Coding");
    expect(calls(state, "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID, LIA_ID]);
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("GLM for all, one login failing: that agent waits, and Try again signs in only that one", async () => {
    const { state, api, machines, dialog, choose } = await connect({ crew: true });
    serverMoves(state, api, GLM);
    machines?.endLogin("login_1", { state: "done", account: account({ id: "acct_1" }) });
    machines?.endLogin("login_2", { state: "done", account: account({ id: "acct_2" }) });
    machines?.endLogin("login_3", { state: "failed" });
    await choose("GLM Coding");
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    const send = async () => {
      await type(within(panel).getByLabelText("Chave do GLM Coding"), GLM_KEY);
      await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
      await sealed(panel);
    };
    await send();
    expect(shownText(panel)).toContain("Não deu para entrar nessa conta. Tente de novo.");
    // Lia's login ended without her: nothing signs her in until the key goes again.
    expect(calls(state, "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID]);
    machines?.endLogin("login_4", { state: "done", account: account({ id: "acct_4" }) });
    await click(within(panel).getByRole("button", { name: "Tentar de novo" }));
    await send();
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(4);
    expect(calls(state, "agents.setBrain").map((c) => [c.args[1], (c.args[2] as { account: string }).account])).toEqual(
      [
        [ADA_ID, "acct_1"],
        [ATLAS_ID, "acct_2"],
        [LIA_ID, "acct_4"],
      ],
    );
    // They all woke: the team's words in place of the panel.
    expect(shownText(dialog)).toContain("Eles já pensam com o seu GLM Coding");
  });

  test("every agent already on the plan: All agents says so, with no key to send", async () => {
    const { state, dialog, choose, services } = await connect({ crew: true });
    const crew = [ADA_ID, ATLAS_ID, LIA_ID];
    for (const a of state.agents) if (crew.includes(a.id)) a.brain = GLM;
    state.aiStatus = { any: true, agents: crew.map((agentId) => ({ agentId, state: "ready" })) };
    await act(async () => {
      await services.queryClient.invalidateQueries({ queryKey: keys.agents(ORG_ID) });
      await services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) });
    });
    await settle(4);
    await choose("GLM Coding");
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    expect(shownText(panel)).toContain("Ada, Atlas e Lia agora pensam com GLM Coding.");
    expect(within(panel).queryByLabelText("Chave do GLM Coding")).toBeNull();
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
  });

  test("ChatGPT for all, once one login per agent holds: one sign-in at a time, the faces ticking", async () => {
    const was = LOGIN_PER_AGENT.codex;
    (LOGIN_PER_AGENT as { codex: boolean }).codex = true;
    try {
      const { state, machines, dialog, choose } = await connect({ crew: true });
      const plus = (n: number, email: string) =>
        account({ id: `acct_${n}`, kind: "codex", label: "ChatGPT Plus", provider: null, keyHint: null, email });
      machines?.endLogin("login_1", { state: "done", account: plus(1, "walt@acme.com") });
      machines?.endLogin("login_2", { state: "done", account: plus(2, "other@acme.com") });
      await choose("ChatGPT");
      const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
      expect(facesOf(panel)).toEqual(["now", "next", "next"]);
      expect(shownText(panel)).toContain("Entre no ChatGPT para a Ada");
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar no ChatGPT" })));
      await settle(8);
      expect(calls(state, "agents.setBrain")[0]?.args).toEqual([ORG_ID, ADA_ID, { brain: "codex", account: "acct_1" }]);
      expect(facesOf(panel)).toEqual(["done", "now", "next"]);
      expect(drawnAs(panel.querySelector('.ai-strip__face[data-state="done"] .ai-strip__badge svg'), "check")).toBe(
        true,
      );
      // Atlas lands on another account than Ada's, whose limits they all share: said in the turn's place, nothing
      // assigned until the person chooses, in the footer: skip him, use it, or try again.
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar no ChatGPT" })));
      await settle(8);
      expect(shownText(panel)).toContain("O login do Atlas não terminou");
      expect(shownText(panel)).toContain(
        "O ChatGPT entrou como other@acme.com, não como walt@acme.com. Saia na página do ChatGPT e tente de novo.",
      );
      expect(calls(state, "agents.setBrain")).toHaveLength(1);
      expect(calls(state, "machines.removeAccount")).toHaveLength(0);
      expect(within(dialog).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
      await click(within(dialog).getByRole("button", { name: "Usar other@acme.com" }));
      await settle(4);
      expect(calls(state, "agents.setBrain")[1]?.args).toEqual([
        ORG_ID,
        ATLAS_ID,
        { brain: "codex", account: "acct_2" },
      ]);
      expect(facesOf(panel)).toEqual(["done", "done", "now"]);
      expect(calls(state, "machines.removeAccount")).toHaveLength(0);
    } finally {
      (LOGIN_PER_AGENT as { codex: boolean }).codex = was;
    }
  });

  test("a turn that came back as another account than the first's: Try again removes that new login first", async () => {
    const was = LOGIN_PER_AGENT.codex;
    (LOGIN_PER_AGENT as { codex: boolean }).codex = true;
    try {
      const { state, machines, dialog, choose } = await connect({ crew: true });
      const plus = (n: number, email: string) =>
        account({ id: `acct_${n}`, kind: "codex", label: "ChatGPT Plus", provider: null, keyHint: null, email });
      machines?.endLogin("login_1", { state: "done", account: plus(1, "walt@acme.com") });
      machines?.endLogin("login_2", { state: "done", account: plus(2, "other@acme.com") });
      await choose("ChatGPT");
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar no ChatGPT" })));
      await settle(8);
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar no ChatGPT" })));
      await settle(8);
      await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
      expect(calls(state, "machines.removeAccount").map((c) => c.args[2])).toEqual(["acct_2"]);
      expect(calls(state, "agents.setBrain")).toHaveLength(1);
      const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
      expect(shownText(panel)).toContain("Entre no ChatGPT para o Atlas");
      expect(within(dialog).getByRole("button", { name: "Entrar no ChatGPT" })).toBeTruthy();
    } finally {
      (LOGIN_PER_AGENT as { codex: boolean }).codex = was;
    }
  });

  test("ChatGPT signs in as an account already there: said plainly, with Try again, and Use while it's free", async () => {
    const { state, machines, dialog, choose } = await connect();
    machines?.endLogin("login_1", { state: "failed", duplicate: { label: "ChatGPT Plus", account: chatgptPlus } });
    await choose("ChatGPT");
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(8);
    expect(shownText(dialog)).toContain(
      "O ChatGPT entrou como rafael@gmail.com, uma conta que você já conectou. Para usar outra, saia na página do ChatGPT e tente de novo.",
    );
    // No address the person never typed, and nothing saved until they choose.
    expect(shownText(dialog)).not.toMatch(/Para usar \S+@/);
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
    // Its two buttons under the note's words; they stack when they don't fit.
    const use = within(dialog).getByRole("button", { name: "Usar rafael@gmail.com" });
    expect(use.parentElement?.className).toBe("ac-acts");
    expect(use.parentElement?.parentElement?.className).toBe("ai-panel__row");
    await click(use);
    await settle(4);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "codex", account: "acct_plus" },
    ]);
    expect(dialog.textContent).toContain("Ada agora pensa com ChatGPT Plus.");
  });

  test("an account already there that thinks for another agent, or one an older server doesn't send: only Try again", async () => {
    for (const duplicate of [
      { label: "ChatGPT Plus", account: { ...chatgptPlus, usedBy: ["Theo"] } },
      { label: "ChatGPT Plus", account: { ...chatgptPlus, status: "signed_out" as const } },
      { label: "ChatGPT Plus" },
    ]) {
      const { machines, dialog, choose } = await connect();
      machines?.endLogin("login_1", { state: "failed", duplicate });
      await choose("ChatGPT");
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com ChatGPT" })));
      await settle(8);
      const who = "account" in duplicate ? "rafael@gmail.com" : "ChatGPT Plus";
      expect(shownText(dialog)).toContain(`O ChatGPT entrou como ${who}, uma conta que você já conectou.`);
      const retry = within(dialog).getByRole("button", { name: "Tentar de novo" });
      expect(retry.parentElement?.className).toBe("ai-panel__row");
      expect(within(dialog).queryByRole("button", { name: /^Usar / })).toBeNull();
      cleanup();
    }
  });

  test("a ChatGPT account already on the computer, signed out: Entrar de novo on it by default, Outra conta for a new one", async () => {
    const gpt = {
      ...account({ id: "acct_gpt", kind: "codex", label: "ChatGPT", provider: null, keyHint: null }),
      email: "walt@acme.com",
      status: "signed_out" as const,
      machineId: "machine_1",
      computer: "MacBook",
    };
    const { state, dialog, choose } = await connect({ accounts: [gpt] });
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    expect(panel.textContent).toContain(
      "ChatGPT saiu da conta aqui. Entre de novo nela e os agentes dela continuam com ela.",
    );
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [ORG_ID, "machine_1", "codex", { accountId: "acct_gpt" }],
    ]);
    // Another account instead: the sign-in on the computer stops, and a new one starts on its button.
    await click(within(panel).getByRole("button", { name: "Outra conta" }));
    expect(calls(state, "machines.cancelAccountLogin").map((c) => c.args)).toEqual([[ORG_ID, "machine_1", "login_1"]]);
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)[1]).toEqual([ORG_ID, "machine_1", "codex"]);
  });

  test("a ChatGPT account already signed in there for no agent: Entrar de novo first, beside Outra conta, so a retry makes no new one", async () => {
    const gpt = {
      ...account({ id: "acct_gpt", kind: "codex", label: "ChatGPT", provider: null, keyHint: null }),
      email: "walt@acme.com",
      machineId: "machine_1",
      computer: "MacBook",
    };
    const { state, dialog, choose } = await connect({ accounts: [gpt] });
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    expect(panel.textContent).toContain("Você já tem ChatGPT aqui. Entre de novo nela, ou use outra conta.");
    expect(within(panel).queryByRole("button", { name: "Entrar com ChatGPT" })).toBeNull();
    const again = within(panel).getByRole("button", { name: "Entrar de novo" });
    expect(again.className).toContain("primary");
    await click(again);
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [ORG_ID, "machine_1", "codex", { accountId: "acct_gpt" }],
    ]);
  });

  test("another agent's own ChatGPT login is never offered again: signing in to it would sign that agent out", async () => {
    const gpt = {
      ...account({ id: "acct_gpt", kind: "codex", label: "ChatGPT", provider: null, keyHint: null }),
      email: "walt@acme.com",
      usedBy: ["Atlas"],
      shared: false,
      machineId: "machine_1",
      computer: "MacBook",
    };
    const { state, dialog, choose } = await connect({ accounts: [gpt] });
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    expect(panel.textContent).not.toContain("Você já tem ChatGPT aqui");
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([[ORG_ID, "machine_1", "codex"]]);
  });

  test("signing in again: no address asked, the account's own goes to Claude's sign-in as its hint", async () => {
    const out = { ...claudeMax, status: "signed_out" as const, email: "walt@acme.com" };
    const { state, dialog } = await connect({
      brain: { brain: "claude_code", account: "acct_max", accounts: [out] },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.querySelector("input")).toBeNull();
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com Claude" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [ORG_ID, "machine_1", "claude_code", { accountId: "acct_max", email: "walt@acme.com" }],
    ]);
    // Nothing on screen names the address, before the code or after.
    expect(shownText(panel)).not.toContain("walt@acme.com");
    expect([...panel.querySelectorAll("input")].map((i) => i.getAttribute("aria-label"))).toEqual(["Código do Claude"]);
  });

  test("signing in again as another account: the account stays, both addresses said, Try again signs in to it once more", async () => {
    const out = { ...claudeMax, status: "signed_out" as const, email: "walt@acme.com" };
    const pessoal = { ...claudeMax, id: "acct_pessoal", label: "Pessoal", email: "walt@gmail.com" };
    for (const duplicate of [{ label: "Pessoal", account: pessoal }, undefined]) {
      const { state, machines, dialog } = await connect({
        brain: { brain: "claude_code", account: "acct_max", accounts: [out] },
      });
      machines?.endLogin("login_1", {
        state: "failed",
        signedInAs: "walt@gmail.com",
        ...(duplicate ? { duplicate } : {}),
      });
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
      await settle(8);
      expect(shownText(dialog)).toContain(
        "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
      );
      expect(calls(state, "agents.setBrain")).toHaveLength(0);
      // One the person already connected, free, may think for Ada instead; an account of its own isn't connected.
      expect(within(dialog).queryByRole("button", { name: "Usar walt@gmail.com" }) !== null).toBe(Boolean(duplicate));
      await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
      await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
      await settle(6);
      expect(calls(state, "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
        { accountId: "acct_max", email: "walt@acme.com" },
        { accountId: "acct_max", email: "walt@acme.com" },
      ]);
      expect(calls(state, "machines.removeAccount")).toHaveLength(0);
      cleanup();
    }
  });

  test("a hint the server refuses only steered Claude's page: the sign-in starts again without it", async () => {
    const out = { ...claudeMax, status: "signed_out" as const, email: "o'brien@acme.com" };
    const { state, api, dialog } = await connect({
      brain: { brain: "claude_code", account: "acct_max", accounts: [out] },
    });
    const begin = api.machines.beginAccountLogin;
    api.machines.beginAccountLogin = async (orgId, machineId, kind, options = {}) => {
      if (options.email) throw new ApiError(400, "account.invalid_email", "Use a plain email address");
      return begin(orgId, machineId, kind, options);
    };
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(6);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([{ accountId: "acct_max" }]);
    expect(within(dialog).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
    expect(shownText(dialog)).not.toContain("não respondeu");
  });

  test("the API key's note leads with an agent, not an ⓘ that looks pressable", async () => {
    const { dialog, choose } = await connect();
    await choose("Chave de API");
    const note = within(dialog).getByText("Todo agente sem plano pensa com ela.").closest(".ac-setnote");
    expect(drawnAs(note?.querySelector("svg"), "agent")).toBe(true);
  });
});

describe("A sign-in through a restart of the server or a reconnect of its computer", () => {
  afterEach(() => setSystemTime());

  /**
   * "Conectar uma IA" with the clock stopped; `ask(after, error)` asks everything again `after` ms later, each read of
   * a sign-in failing with `error`, or with what it gives for that login (none: the computer's answer).
   */
  async function reconnecting(options: Parameters<typeof connect>[0] = {}) {
    const start = Date.now();
    setSystemTime(new Date(start));
    const env = await connect(options);
    const { api, services } = env;
    const read = api.machines.accountLogin;
    const ask = async (after: number, error?: Error | ((loginId: string) => Error | undefined)) => {
      setSystemTime(new Date(start + after));
      api.machines.accountLogin = async (orgId, machineId, loginId) => {
        const failed = typeof error === "function" ? error(loginId) : error;
        if (failed) throw failed;
        return read(orgId, machineId, loginId);
      };
      await act(() => services.queryClient.invalidateQueries());
      await settle(8);
    };
    return { ...env, ask };
  }
  const offline = new ApiError(409, "machine.offline", "The computer MacBook is offline.");
  const proxy = new ApiError(502, "http_502", "Bad Gateway");
  /** Ada's view says her computer is online only while `online()` does. */
  const viewOnline = (api: ReturnType<typeof createFakeApi>, online: () => boolean) => {
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => {
      const view = await viewOf(orgId, agentId);
      return { ...view, computer: view.computer && { ...view.computer, online: online() } };
    };
  };

  test("reads failing for 20 s, then signed in: Reconectando meanwhile, never a failure, and the agent thinks with it", async () => {
    const { state, machines, dialog, choose, ask } = await reconnecting();
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(6);
    expect(shownText(panel)).toContain("Esperando");
    // The server restarts: no answer, then only the proxy's, then its computer reconnecting.
    for (const [after, error] of [
      [2_000, new TypeError("Failed to fetch")],
      [9_000, new ApiError(502, "http_502", "Bad Gateway")],
      [20_000, offline],
    ] as const) {
      await ask(after, error);
      expect(shownText(panel)).toContain("Reconectando…");
      expect(within(panel).getByLabelText("Código para o ChatGPT").textContent).toBe("ABCD-1234");
      expect(shownText(panel)).not.toMatch(/Não deu para entrar|não respondeu/);
    }
    machines?.endLogin("login_1", { state: "done", account: chatgptPlus });
    await ask(22_000);
    expect(shownText(dialog)).toContain("Ada agora pensa com ChatGPT Plus.");
    expect(shownText(dialog)).not.toMatch(/Não deu para entrar|não respondeu/);
    expect(calls(state, "agents.setBrain").map((c) => c.args[2])).toEqual([{ brain: "codex", account: "acct_plus" }]);
  });

  test("reads failing for the whole wait from the first: the computer didn't answer, with Tentar de novo, which starts nothing", async () => {
    const { state, dialog, ask } = await reconnecting();
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com Claude" })));
    await settle(6);
    // The first failed read comes after five quiet minutes (a page in the background reads nothing): the wait
    // starts there.
    const quiet = 5 * 60_000;
    await ask(quiet, proxy);
    expect(shownText(panel)).toContain("Reconectando…");
    await ask(quiet + LOGIN_RECONNECT_MS - 1_000, proxy);
    expect(shownText(panel)).toContain("Reconectando…");
    expect(within(panel).getByRole("textbox", { name: "Código do Claude" })).toBeTruthy();
    await ask(quiet + LOGIN_RECONNECT_MS, proxy);
    expect(shownText(panel)).toContain("O MacBook não respondeu. Tente de novo em instantes.");
    expect(within(panel).queryByRole("textbox", { name: "Código do Claude" })).toBeNull();
    await click(within(panel).getByRole("button", { name: "Tentar de novo" }));
    // That sign-in stops on the computer; the next starts on its button.
    expect(calls(state, "machines.cancelAccountLogin").map((c) => c.args[2])).toEqual(["login_1"]);
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(1);
  });

  test("what the computer says while reads fail shows at once: the CLI that exited without signing in", async () => {
    const { machines, dialog, choose, ask } = await reconnecting();
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(6);
    await ask(5_000, offline);
    expect(shownText(panel)).toContain("Reconectando…");
    machines?.endLogin("login_1", { state: "failed", error: "Codex couldn't sign in" });
    await ask(6_000);
    expect(shownText(panel)).toContain("Não deu para entrar nessa conta. Tente de novo.");
    expect(within(panel).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  test("its computer offline for a moment mid-sign-in: the steps stay, and the same sign-in ends it, never a second", async () => {
    const { state, api, machines, dialog, choose, ask } = await reconnecting();
    let online = true;
    viewOnline(api, () => online);
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(6);
    // Its runner reconnects: the agent's view says offline, and the sign-in can't be read.
    online = false;
    await ask(10_000, offline);
    expect(shownText(panel)).toContain("Reconectando…");
    expect(within(panel).getByLabelText("Código para o ChatGPT").textContent).toBe("ABCD-1234");
    expect(shownText(panel)).not.toContain("está offline agora");
    expect(within(panel).queryByRole("button", { name: "Usar uma chave de API agora" })).toBeNull();
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
    // Back, and the person typed the code on ChatGPT's page meanwhile.
    online = true;
    machines?.endLogin("login_1", { state: "done", account: chatgptPlus });
    await ask(25_000);
    expect(shownText(dialog)).toContain("Ada agora pensa com ChatGPT Plus.");
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(1);
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("GLM for all while the logins can't be read: Reconectando, then each agent on its own login", async () => {
    const { state, api, machines, dialog, choose, ask } = await reconnecting({ crew: true });
    serverMoves(state, api, GLM);
    machines?.endLogin("login_1", { state: "done", account: account({ id: "acct_1" }) });
    await choose("GLM Coding");
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    // The server restarts right after the key went to the first login.
    const read = api.machines.accountLogin;
    api.machines.accountLogin = async (orgId, machineId, loginId) => {
      if (loginId !== "login_1") throw new ApiError(502, "http_502", "Bad Gateway");
      return read(orgId, machineId, loginId);
    };
    await type(within(panel).getByLabelText("Chave do GLM Coding"), GLM_KEY);
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await sealed(panel);
    expect(shownText(panel)).toContain("Reconectando…");
    expect(shownText(panel)).not.toMatch(/Não deu para entrar|não respondeu/);
    for (const n of [2, 3]) machines?.endLogin(`login_${n}`, { state: "done", account: account({ id: `acct_${n}` }) });
    await ask(20_000);
    // They all woke: the team's words in place of the panel.
    expect(shownText(dialog)).toContain("Eles já pensam com o seu GLM Coding");
    expect(calls(state, "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID, LIA_ID]);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(3);
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("not one read answered from the sign-in's start, for the whole wait: the computer didn't answer", async () => {
    const { api, dialog, choose, ask } = await reconnecting();
    await choose("ChatGPT");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    api.machines.accountLogin = async () => {
      throw proxy;
    };
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(6);
    expect(shownText(panel)).toContain("Reconectando…");
    await ask(LOGIN_RECONNECT_MS - 1_000, proxy);
    expect(shownText(panel)).toContain("Reconectando…");
    await ask(LOGIN_RECONNECT_MS, proxy);
    expect(shownText(panel)).toContain("O MacBook não respondeu. Tente de novo em instantes.");
  });

  test("GLM for all: a login unanswered for the whole wait and one whose read fails once, both signed in after: each agent on its own login", async () => {
    const { state, api, machines, dialog, choose, ask } = await reconnecting({ crew: true });
    serverMoves(state, api, GLM);
    machines?.endLogin("login_1", { state: "done", account: account({ id: "acct_1" }) });
    await choose("GLM Coding");
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    // Atlas's login can't be read; Lia's first read gets the server's own error.
    const fails: Record<string, Error> = { login_2: proxy, login_3: new ApiError(500, "internal", "Internal error") };
    await ask(0, (loginId) => fails[loginId]);
    await type(within(panel).getByLabelText("Chave do GLM Coding"), GLM_KEY);
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await sealed(panel);
    expect(shownText(panel)).toContain("Não deu para entrar nessa conta. Tente de novo.");
    await ask(LOGIN_RECONNECT_MS, (loginId) => (loginId === "login_2" ? proxy : undefined));
    expect(shownText(panel)).toContain("O MacBook não respondeu. Tente de novo em instantes.");
    // Both went on on the computer, and an answer picks each up again.
    for (const n of [2, 3]) machines?.endLogin(`login_${n}`, { state: "done", account: account({ id: `acct_${n}` }) });
    await ask(LOGIN_RECONNECT_MS + 2_000);
    // They all woke: the team's words in place of the panel.
    expect(shownText(dialog)).toContain("Eles já pensam com o seu GLM Coding");
    expect(calls(state, "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID, LIA_ID]);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(3);
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("Claude's code pasted while its computer is offline mid-sign-in waits for Enviar: nothing blames the code, and it goes once the computer is back", async () => {
    const { state, api, dialog, ask } = await reconnecting();
    let online = true;
    viewOnline(api, () => online);
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    await withPopup(() => click(within(panel).getByRole("button", { name: "Entrar com Claude" })));
    await settle(6);
    online = false;
    const sendCode = api.machines.sendAccountCode;
    let tries = 0;
    api.machines.sendAccountCode = async () => {
      tries++;
      throw offline;
    };
    await ask(10_000, offline);
    expect(shownText(panel)).toContain("Reconectando…");
    const field = within(panel).getByRole("textbox", { name: "Código do Claude" }) as HTMLInputElement;
    await type(field, "c0de#st4te");
    await settle(6);
    expect(tries).toBe(0);
    expect(field.value).toBe("c0de#st4te");
    expect(shownText(panel)).not.toContain("Não deu para enviar o código");
    const send = within(panel).getByRole("button", { name: "Enviar ao MacBook" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    online = true;
    api.machines.sendAccountCode = sendCode;
    await ask(20_000);
    expect(send.disabled).toBe(false);
    await click(send);
    await sealed(panel, 6);
    expect(calls(state, "machines.sendAccountCode")).toHaveLength(1);
    expect(shownText(panel)).toContain("Código enviado. O MacBook está terminando de entrar.");
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(1);
  });
});
