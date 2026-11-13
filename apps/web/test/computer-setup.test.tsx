import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ComputerSetup, Machine } from "@agenteschat/client";
import { en, ptBR } from "@agenteschat/i18n";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  setSystemTime();
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

const SPECS = { cpus: 4, memoryGb: 8, diskGb: 100 };
/** No system, address, provider or tool list on these screens (ADR 0056 §10). */
const TECHNICAL = /Linux|\bIP\b|IPv4|VPS|Debian|Chrome|\bgit\b|Outro sistema/;
const NOTICE = "O computador do workspace";

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

/** The workspace's own computer as the server lists it: named by the server, no system, nobody paired it. */
const WORKSPACE_COMPUTER: Partial<Machine> & { name: string } = {
  name: "Computador da Acme",
  kind: "managed",
  os: "other",
  arch: "",
  hostname: "",
  workspace: null,
  pairedBy: null,
  mode: "system",
};

/** Acme where the workspace's computer is ready (Ada on it). */
async function readyWorkspace(path: string, patch: Partial<Machine> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  const m = machines.pair({ ...WORKSPACE_COMPUTER, ...patch });
  machines.setSetup({ state: "ready", machineId: m.id, specs: SPECS });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
  const r = await renderApp(path.replace("$machineId", m.id), { api });
  await settle(10);
  return { ...r, state, api, m };
}

/** The app at `path` where the workspace gets its own computer (`setup`), or where people pair theirs (null). */
async function open(
  path: string,
  setup: Partial<ComputerSetup> | null,
  state = seedState(),
  api = createFakeApi(state),
) {
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  if (setup) machines.setSetup(setup);
  const r = await renderApp(path, { api });
  await settle(8);
  // The onboarding opens no socket.
  const socket = r.sockets.sockets.at(-1);
  if (socket) await act(async () => socket.open());
  const push = async (event: Partial<ComputerSetup> & { type?: string }) => {
    await act(async () =>
      socket?.push({
        type: "event",
        scope: "org",
        event: {
          type: "machine.provisioning",
          state: "preparing",
          step: null,
          reason: null,
          since: new Date().toISOString(),
          requestedAt: new Date(Date.now() - 30_000).toISOString(),
          expectedReadyAt: null,
          secondsLeft: null,
          secondsWaited: 30,
          specs: SPECS,
          machineId: null,
          ...event,
        },
      }),
    );
    await settle(6);
  };
  return { ...r, api, machines, socket, push };
}

describe("the workspace's computer on its way: the notice on top of the work area", () => {
  test("how far it is, the time left and who waits for it, live, closed until the state changes, gone once ready", async () => {
    const { push } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { state: "waiting", reason: "capacity" });
    const notice = () => screen().getByRole("region", { name: NOTICE });
    const title = () => notice().querySelector(".outage__text > b")?.textContent;
    // In line nothing is prepared yet: its name alone, and its line says it waits.
    expect(title()).toBe("Computador da Acme");
    expect(notice().textContent).toContain("Esperando um computador disponível");
    expect(notice().textContent).not.toContain("Nada se perde");
    // Who waits for it: their faces, each named, and no sentence of names.
    expect(within(notice()).getByRole("img", { name: "Ada" })).toBeTruthy();
    expect(within(notice()).getByRole("img", { name: "Atlas" })).toBeTruthy();
    expect(notice().textContent).not.toContain("esperam por ele");
    // On a phone too, where other notices drop their faces: here nothing else says who waits.
    const css = await Bun.file(new URL("../src/responsive.css", import.meta.url).pathname).text();
    expect(css.split("\n  .setup-notice .outage__crew {")[1]?.split("}")[0]).toContain("display: inline-flex");
    expect(notice().textContent).not.toMatch(TECHNICAL);
    // This server sends no email: nothing is promised.
    expect(notice().textContent).not.toMatch(/avisamos/i);

    // Prepared before a step: the title says it all, no line saying it again ("Preparando o computador.").
    await push({ state: "preparing", step: null });
    const line = () => notice().querySelector(".outage__text > span")?.textContent;
    expect(title()).toBe("Preparando o computador da Acme");
    expect(line()).toBeUndefined();
    expect(notice().textContent).not.toContain("Preparando o computador.");
    // With the time left alone, it starts the line.
    await push({ state: "preparing", step: null, secondsLeft: 330 });
    expect(line()).toBe("Faltam uns 6 min");

    await push({ state: "preparing", step: "installing", secondsLeft: 330 });
    expect(title()).toBe("Preparando o computador da Acme");
    expect(line()).toBe("Passo 3 de 4 · Instalando os programas · faltam uns 6 min");
    await push({ state: "preparing", step: "starting" });
    expect(line()).toBe("Passo 2 de 4 · Iniciando");

    // Closed: it stays closed for this step, and comes back for the next one.
    await click(within(notice()).getByRole("button", { name: "Ocultar" }));
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
    await push({ state: "preparing", step: "starting" });
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
    await push({ state: "preparing", step: "installing" });
    expect(notice().textContent).toContain("Instalando os programas");

    await push({ state: "problem" });
    expect(notice().textContent).toContain("Algo deu errado ao preparar o computador");
    await push({ state: "ready", machineId: "00000000-0000-4000-8000-000000000999" });
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });

  test("waiting for an available computer: owners read they'll be emailed in its line, and members don't", async () => {
    const wait = { state: "waiting", reason: "capacity", notifyByEmail: true } as const;
    const line = () =>
      screen().getByRole("region", { name: NOTICE }).querySelector(".outage__text > span")?.textContent ?? null;
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, wait);
    expect(line()).toBe("Esperando um computador disponível. Avisamos por e-mail.");
    cleanup();
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, wait, member);
    expect(line()).toBe("Esperando um computador disponível");
  });

  test("what it is doing within its step, in the same words on every screen; a stage it has no words for is its step", async () => {
    const { push, router } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, {
      step: "installing",
      stage: "updating",
      secondsLeft: 330,
    });
    const notice = () => screen().getByRole("region", { name: NOTICE }).textContent;
    const card = () => screen().getByRole("region", { name: "Computador da Acme" }).textContent;
    // The notice over a conversation, then the card its See opens, which no notice covers.
    const both = async (words: string) => {
      expect(notice()).toContain(words);
      await act(async () =>
        router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "computers" } }),
      );
      await settle(6);
      expect(card()).toContain(words);
      await act(async () =>
        router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: ENG_ID } }),
      );
      await settle(6);
    };
    expect(notice()).toContain("Passo 3 de 4 · Atualizando o sistema · faltam uns 6 min");
    await both("Passo 3 de 4 · Atualizando o sistema");
    await push({ step: "installing", stage: "restarting", secondsLeft: 300 });
    await both("Passo 3 de 4 · Reiniciando depois da atualização");
    await push({ step: "installing", stage: "defragmenting", secondsLeft: 240 });
    await both("Passo 3 de 4 · Instalando os programas");
  });

  test("one time, read the same way everywhere: a screen opened later says what the notice says", async () => {
    // A minute and two seconds left: ten seconds on, before the notice repaints, it is under a minute.
    const { router } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { step: "installing", secondsLeft: 62 });
    const notice = () => screen().getByRole("region", { name: NOTICE }).textContent ?? "";
    expect(notice()).toContain("faltam uns 2 min");
    setSystemTime(new Date(Date.now() + 10_000));
    await act(async () =>
      router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "computers" } }),
    );
    await settle(6);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    const time = card.querySelector(".setup-eta")?.textContent ?? "";
    expect(time).toMatch(/^Falta/);
    // Back to the conversation, the notice says the same time.
    await act(async () =>
      router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: ENG_ID } }),
    );
    await settle(6);
    expect(notice()).toContain(time.charAt(0).toLowerCase() + time.slice(1));
  });

  test("the time line never steps back: almost ready only in the last step, a little longer once it runs out", async () => {
    const notice = () => screen().getByRole("region", { name: NOTICE }).textContent ?? "";
    const time = () =>
      screen().getByRole("region", { name: "Computador da Acme" }).querySelector(".setup-eta")?.textContent;
    /** The notice over a conversation says `line`; the card its See opens (no notice over it) says `left`. */
    const says = async (router: Awaited<ReturnType<typeof open>>["router"], line: string, left: string) => {
      expect(notice()).toContain(line);
      await act(async () =>
        router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "computers" } }),
      );
      await settle(6);
      expect(time()).toBe(left);
      await act(async () =>
        router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: ENG_ID } }),
      );
      await settle(6);
    };
    const first = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { step: "installing", stage: "apps", secondsLeft: 50 });
    await says(
      first.router,
      "Passo 3 de 4 · Instalando os programas · falta menos de um minuto",
      "Falta menos de um minuto",
    );
    // The apps end early: the last step, almost ready.
    await first.push({ step: "connecting", stage: "connecting", secondsLeft: 10 });
    await says(first.router, "Passo 4 de 4 · Conectando ao seu workspace · quase pronto…", "Quase pronto…");

    // Another wait whose time runs out during the apps: a little longer than expected, in the last step too.
    cleanup();
    const late = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { step: "installing", stage: "apps", secondsLeft: 0 });
    await says(
      late.router,
      "Passo 3 de 4 · Instalando os programas · demorando um pouco mais que o previsto",
      "Demorando um pouco mais que o previsto",
    );
    await late.push({ step: "connecting", stage: "connecting", secondsLeft: -20 });
    await says(
      late.router,
      "Passo 4 de 4 · Conectando ao seu workspace · demorando um pouco mais que o previsto",
      "Demorando um pouco mais que o previsto",
    );
  });

  test("where people connect their own computers, nothing changes: no notice", async () => {
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, null);
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });
});

describe("no AI yet while the workspace's computer is on its way", () => {
  test("the banner is the one it always is: its line, its ⓘ and Connect, nothing about the computer", async () => {
    // The Cloud: Jev picks, so asking in the chat is understood (the line's ⓘ).
    const state = seedState({
      aiStatus: {
        any: false,
        agents: [{ agentId: ADA_ID, state: "no_ai", reason: "no_key" }],
        routing: { by: "jev", mine: "jev", model: null, noSmallModel: null },
      },
    });
    const { push } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { step: "installing", secondsLeft: 330 }, state);
    const banner = () => document.querySelector(".noai-banner") as HTMLElement;
    const ask = "Você também pode pedir no chat, como “usar meu plano do Claude”.";
    expect(shownText(banner())).toBe("Os agentes ainda não têm uma\u00a0IA.Conectar uma IA");
    expect(hintOf("Conectar uma IA", banner()).text).toBe(ask);
    await push({ state: "ready", machineId: "00000000-0000-4000-8000-000000000999" });
    expect(shownText(banner())).toBe("Os agentes ainda não têm uma\u00a0IA.Conectar uma IA");
    expect(hintOf("Conectar uma IA", banner()).text).toBe(ask);
  });
});

describe("Configurações → Computadores: the workspace's own computer", () => {
  test("on hold with none ready: paused, nothing on its way and no notice; active again, its wait shows", async () => {
    const state = seedState();
    const me = state.me;
    if (!me) throw new Error("no me");
    me.organizations = me.organizations.map((o) => ({ ...o, standing: { state: "hold", reason: null } }));
    // The server says no state for a workspace on hold whose computer isn't ready.
    const { machines, socket } = await open(`/org/${ORG_ID}/settings/computers`, { state: null }, state);
    const card = () => screen().getByRole("region", { name: "Computador da Acme" }).textContent ?? "";
    expect(card()).toContain("Pausado");
    expect(card()).toContain("Não está sendo preparado enquanto o workspace estiver em espera.");
    expect(card()).not.toContain("Sendo preparado");
    expect(card()).not.toContain("Avisamos");
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();

    // Active again: the app asks again, and the wait is back.
    machines.setSetup({ state: "preparing", step: "reserving" });
    await act(async () =>
      socket?.push({
        type: "event",
        scope: "org",
        event: { type: "org.standing", orgId: ORG_ID, state: "active", reason: null },
      }),
    );
    await settle(8);
    expect(card()).toContain("Sendo preparado");
    expect(card()).toContain("O Atlas está separando um para a gente");
    expect(card()).toContain("Passo 1 de 4 · Reservando o computador");
    // The notice's See leads here, where the card says it all: no notice on this page.
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });

  test("its card: steps, size, one user per agent; ready, online with its agents", async () => {
    const { push, machines } = await open(`/org/${ORG_ID}/settings/computers`, {
      state: "preparing",
      step: "starting",
      specs: SPECS,
    });
    const card = () => screen().getByRole("region", { name: "Computador da Acme" });
    // The team's line over the steps; "Sendo preparado" is the head's chip alone, never again over the steps.
    expect(card().querySelector(".setup-say[data-on]")?.textContent).toBe("O Atlas está colocando ele de pé");
    expect(card().textContent?.split("Sendo preparado")).toHaveLength(2);
    expect(card().textContent).toContain("Passo 2 de 4 · Iniciando");
    expect(card().textContent).toContain(
      "4\u00a0CPUs\u00a0· 8\u00a0GB\u00a0de\u00a0memória\u00a0· 100\u00a0GB\u00a0de\u00a0disco",
    );
    // One user per agent is the name's ⓘ, not a line of the card.
    const users = "Um usuário para cada agente: cada um tem a própria pasta.";
    expect(hintOf("Computador da Acme", card()).text).toBe(users);
    expect(shownText(card())).not.toContain("Um usuário para cada agente");
    expect(card().textContent).not.toMatch(TECHNICAL);

    // The chip is the one place the card says where it is, so its live region: a screen reader hears each change.
    expect(card().querySelector(".computers-card__head [role='status'] .ac-chip")?.textContent).toBe("Sendo preparado");
    await push({ state: "waiting", reason: "capacity" });
    // In line said once, by its chip: no line under it saying it waits, and no notice over the page.
    expect(card().textContent).toContain("Na fila");
    expect(card().textContent).not.toContain("Esperando um computador disponível");
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
    expect(card().querySelector(".computers-card__head [role='status'] .ac-chip")?.textContent).toBe("Na fila");

    // Its first hello: ready, its row among the computers, the agents on it (each with its own folder only).
    const m = machines.pair({
      ...WORKSPACE_COMPUTER,
      agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
      access: { folders: [], tools: { claude: true, codex: true, commands: true } },
    });
    await push({ state: "ready", machineId: m.id });
    // Ready: its setup card goes, and it's the devices list's first row; nothing else to pick.
    expect(screen().queryByRole("region", { name: "Computador da Acme" })).toBeNull();
    const first = document.querySelector(".dv-row") as HTMLElement;
    expect(first.querySelector(".dv-row__name")?.textContent).toBe("Computador da Acme");
    const words = document.body.textContent ?? "";
    expect(words).toContain(
      "Onde seus agentes trabalham: o computador do workspace e os dispositivos que as pessoas conectam.",
    );
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();

    // Its page: its name, size and agents, Open beside each; no system, folder, Remove or "Para liberar mais".
    await click(within(first).getByRole("link", { name: "Computador da Acme" }));
    await settle(6);
    expect(screen().getByRole("heading", { name: "Computador da Acme" })).toBeTruthy();
    expect(hintOf("Computador da Acme").text).toBe(users);
    // Each agent's own folder is that ⓘ: no line under the agent saying it again.
    expect(shownText(document.body)).not.toContain("Só a própria pasta");
    expect(screen().getByRole("button", { name: "Abrir: Computador da Ada" })).toBeTruthy();
    const page = document.body.textContent ?? "";
    expect(page).toContain("4\u00a0CPUs\u00a0· 8\u00a0GB\u00a0de\u00a0memória\u00a0· 100\u00a0GB\u00a0de\u00a0disco");
    expect(page).not.toMatch(TECHNICAL);
    expect(page).not.toContain("Pasta:");
    expect(page).not.toContain("Para liberar mais");
    const actions = screen().getByRole("button", { name: "Ações de Computador da Acme" });
    actions.focus();
    await act(async () => {
      fireEvent.keyDown(actions, { key: "Enter" });
      fireEvent.keyUp(actions, { key: "Enter" });
    });
    await settle(2);
    const menu = screen().getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Renomear" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Remover" })).toBeNull();
  });

  test("its page: what it is behind its name's ⓘ, its help page at the end, nothing to turn off that nobody here could turn back on", async () => {
    await readyWorkspace(`/org/${ORG_ID}/settings/computers/$machineId`, {
      agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
      access: {
        folders: [{ path: "/srv/shared", agents: [ADA_ID] }],
        tools: { claude: true, codex: true, commands: true, browser: true, desktop: true },
      },
      browser: {
        available: false,
        version: null,
        chrome: null,
        reason: "ETXTBSY: text file is busy; run `agentes-runner browser install`",
      },
      desktopUse: { available: false, reason: "Missing packages: run `sudo apt-get install xdotool`" },
    });
    expect(screen().getByRole("heading", { name: "Computador da Acme" })).toBeTruthy();
    expect(hintOf("Computador da Acme").text).toBe("Um usuário para cada agente: cada um tem a própria pasta.");
    // No card of what is on it, and no plans: what it is and how it works is its help page, linked once at the end.
    expect(screen().queryByRole("region", { name: "Neste computador" })).toBeNull();
    expect(document.body.textContent).not.toContain("plano de IA");
    const about = screen().getByRole("link", { name: "Sobre este computador" });
    const url = new URL(about.getAttribute("href") ?? "");
    expect(url.href).toBe("https://agentes.chat/pt/docs/workspace-computer");
    expect(about.className).toBe("ac-link ac-link--muted");
    expect(about.getAttribute("rel")).toBe("noopener noreferrer");
    const links = [...document.querySelectorAll("main a, .settings__body a")];
    expect(links.at(-1)).toBe(about);
    // Not the cards of a computer someone connected: folders, tools, browser, apps.
    for (const name of ["Pastas liberadas", "Ferramentas", "Navegador", "Apps nas telas dos agentes"])
      expect(screen().queryByRole("region", { name })).toBeNull();
    expect(screen().queryAllByRole("button", { name: /^Desligar/ })).toEqual([]);
    expect(screen().queryByRole("button", { name: "Ações de shared" })).toBeNull();
    const page = document.body.textContent ?? "";
    for (const word of ["ETXTBSY", "agentes-runner", "apt-get", "Preferências", "Linux"])
      expect(page).not.toContain(word);
  });

  test("an agent on it: no word about allowing more on the computer itself", async () => {
    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, {
      access: { folders: [], tools: { claude: true, codex: true, commands: true } },
    });
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Computador da Acme");
    // What it is, its name's ⓘ; its name once, with no read-only row naming it again.
    expect(hintOf("Computador da Acme", pc).text).toBe(
      "O computador do próprio workspace: sempre ligado, com um usuário só dele para cada agente.",
    );
    expect(pc.querySelector(".agp-ro")).toBeNull();
    expect(pc.textContent?.split("Computador da Acme").length).toBe(2);
    expect(pc.textContent).toContain("Usa só a própria pasta.");
    expect(pc.textContent).not.toContain("por quem o conectou");
    expect(within(pc).queryByRole("button", { name: "Sobre Pastas no computador" })).toBeNull();
  });

  test("ready: every agent works on the workspace's computer, with nothing to pick", async () => {
    await readyWorkspace(`/org/${ORG_ID}/settings/computers`);
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();
    expect(screen().queryByRole("combobox", { name: "Computador de Ada" })).toBeNull();
    cleanup();

    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    // Nothing to pick, so no cell for it: the page's computer entry says how the computer is.
    expect(work.textContent).not.toContain("Trabalha no");
    expect(screen().queryByRole("button", { name: "Mudar onde trabalha" })).toBeNull();
    expect(work.textContent).not.toMatch(/nuvem/i);
  });

  test("who hears when it's ready: owners of a server that sends email; anyone else reads it shows here", async () => {
    const wait = { state: "waiting", reason: "capacity", notifyByEmail: true } as const;
    const card = () => screen().getByRole("region", { name: "Computador da Acme" }).textContent ?? "";
    await open(`/org/${ORG_ID}/settings/computers`, wait);
    expect(card()).toContain("Avisamos\u00a0você\u00a0em walter@acme.com.br quando\u00a0ele\u00a0ficar\u00a0pronto.");
    expect(card()).not.toContain("Pode fechar esta página");
    expect(card()).not.toContain("Aparece aqui");
    cleanup();

    // Only owners get the email: nobody else is promised it.
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    await open(`/org/${ORG_ID}/settings/computers`, wait, member);
    expect(card()).toContain("Aparece aqui assim que ficar pronto.");
    expect(card()).not.toContain("Avisamos");
    cleanup();

    // A server that sends no email promises none, to owners either.
    await open(`/org/${ORG_ID}/settings/computers`, { ...wait, notifyByEmail: false });
    expect(card()).toContain("Aparece aqui assim que ficar pronto.");
    expect(card()).not.toContain("Avisamos");
  });

  test("while it is on its way: no picker either, the wait in its place", async () => {
    await open(`/org/${ORG_ID}/settings/computers`, { state: "waiting", reason: "capacity" });
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();
    expect(screen().getByRole("region", { name: "Computador da Acme" }).textContent).toContain("Na fila");
  });

  test("the team's lines while it's prepared: one every 3.5 s, held with reduced motion until the step moves, none with nobody they name", async () => {
    const card = () => screen().getByRole("region", { name: "Computador da Acme" });
    const shown = () => card().querySelector(".setup-say[data-on]")?.textContent;
    // Reduced motion (the screen tests' own): the first line holds, and the next stage brings its own.
    const { push } = await open(`/org/${ORG_ID}/settings/computers`, { state: "preparing", step: "starting" });
    expect(shown()).toBe("O Atlas está colocando ele de pé");
    expect(card().querySelector(".setup-says")?.getAttribute("aria-hidden")).toBe("true");
    await push({ step: "installing", stage: "booting" });
    expect(shown()).toBe("A Ada está contando os 8 GB de memória");
    cleanup();

    // Its size said only now, within the same stage: the line shown stays, and the memory's waits for its turn.
    const sized = await open(`/org/${ORG_ID}/settings/computers`, {
      state: "preparing",
      step: "reserving",
      stage: "ordering",
      specs: null,
    });
    expect(shown()).toBe("O Atlas encomendou um novinho");
    await sized.push({ step: "reserving", stage: "ordering" });
    expect(card().textContent).toContain("A Ada pediu 8 GB de memória");
    expect(shown()).toBe("O Atlas encomendou um novinho");
    cleanup();

    // Motion allowed: the next line every 3.5 s, round again.
    const device = domWindow().happyDOM.settings.device;
    const ticks: (() => void)[] = [];
    const timers = spyOn(globalThis, "setInterval").mockImplementation(((tick: () => void, ms?: number) => {
      if (ms === 3500) ticks.push(tick);
      return 0;
    }) as unknown as typeof setInterval);
    device.prefersReducedMotion = "no-preference";
    try {
      await open(`/org/${ORG_ID}/settings/computers`, { state: "preparing", step: "starting" });
      expect(shown()).toBe("O Atlas está colocando ele de pé");
      await act(async () => ticks.at(-1)?.());
      expect(shown()).toBe("A Ada está esquentando os motores");
      await act(async () => ticks.at(-1)?.());
      expect(shown()).toBe("O Atlas está colocando ele de pé");
    } finally {
      device.prefersReducedMotion = "reduce";
      timers.mockRestore();
    }
    cleanup();

    // None of the agents the lines name on the team: nothing over the steps; the head's chip says where it is, once.
    const strangers = seedState();
    strangers.agents = strangers.agents.map((a) => ({ ...a, handle: `${a.handle}-2` }));
    await open(`/org/${ORG_ID}/settings/computers`, { state: "preparing", step: "starting" }, strangers);
    expect(card().querySelector(".setup-says")).toBeNull();
    expect(card().querySelector(".setup-progress .ac-chip")).toBeNull();
    expect(card().querySelector(".computers-card__head [role='status'] .ac-chip")?.textContent).toBe("Sendo preparado");
    cleanup();

    // Nor anywhere else (an agent's computer, its window, the AI step's wait): no chip over the steps.
    await open(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { state: "preparing", step: "starting" }, strangers);
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Passo 2 de 4 · Iniciando");
    expect(pc.querySelector(".setup-progress .ac-chip")?.textContent).toBeUndefined();
  });
});

describe("an agent's computer while the workspace's is on its way", () => {
  test("the page's computer entry says why it waits: Como trabalha has no cell for it", async () => {
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, { state: "waiting", reason: "capacity" });
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).not.toContain("Trabalha no");
    const entry = screen().getByRole("region", { name: "Computador da Ada" });
    expect(entry.querySelector(".cmp-entry__line")?.textContent).toContain("Esperando um computador disponível");
    // No line under the card saying the agent waits.
    expect(document.body.textContent).not.toContain("começa a usar assim que ele ficar pronto");
  });

  test("once ready, the page's computer entry is the agent's: no cell to change, no line saying it waits", async () => {
    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).not.toContain("Trabalha no");
    expect(screen().getByRole("region", { name: "Computador da Ada" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("A Ada começa a usar");
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });

  test("Configurações › its computer: the progress", async () => {
    await open(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { state: "preparing", step: "installing" });
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Computador da Acme");
    expect(pc.textContent).toContain("Passo 3 de 4 · Instalando os programas");
    expect(pc.textContent).not.toContain("começa a usar assim que ele ficar pronto");
    // Its name already shows there: no read-only row naming it again.
    expect(pc.textContent?.split("Computador da Acme")).toHaveLength(2);
    expect(pc.querySelector(".agp-ro")).toBeNull();
    expect(pc.textContent).not.toMatch(TECHNICAL);
  });
});

describe("a computer connected in system mode (each agent its own user)", () => {
  test("its page says so instead of the folder it was connected from, and allowing takes its administrator", async () => {
    const { machines, router, socket } = await open(`/org/${ORG_ID}/settings/computers`, null);
    const box = machines.pair({ name: "Servidor", os: "linux", mode: "system", workspace: "/root/agentes" });
    const laptop = machines.pair({ name: "Notebook", os: "linux", workspace: "/home/ana/agentes" });
    const mac = machines.pair({ name: "MacBook", os: "darwin", workspace: "/Users/ana/agentes" });
    await act(async () =>
      socket?.push({
        type: "event",
        scope: "org",
        event: { type: "machine.paired", machineId: box.id, name: box.name },
      }),
    );
    await settle(6);
    const page = async (id: string) => {
      await act(async () =>
        router.navigate({ to: "/org/$orgId/settings/computers/$machineId", params: { orgId: ORG_ID, machineId: id } }),
      );
      await settle(8);
      return document.body.textContent ?? "";
    };

    const system = await page(box.id);
    expect(system).toContain("Cada agente trabalha com o próprio usuário, na própria pasta.");
    expect(system).not.toContain("/root/agentes");
    expect(system).toContain("Liberar é no próprio computador, no Terminal dele, como administrador:");
    expect(system).toContain("sudo agentes-runner folders allow <pasta> --agent <agente>");
    expect(system).not.toContain("app do agentes.chat");

    // One user for every agent: the folder it was connected from is theirs, and the Terminal needs no sudo.
    const single = await page(laptop.id);
    expect(single).toContain("Pasta: /home/ana/agentes");
    expect(single).toContain("Liberar é no próprio computador, no Terminal dele:");
    expect(single).not.toContain("sudo");
    expect(single).not.toContain("app do agentes.chat");

    // A Mac keeps the app first, the terminal as the way without it.
    const onMac = await page(mac.id);
    expect(onMac).toContain("abra o app do agentes.chat nele (Preferências → Pastas).");
    expect(onMac).toContain("Sem o app? No terminal do computador:");
  });
});

describe("the computer's wait in words: one edge for the words, whole phrases, even ink", () => {
  const sheet = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
  const rule = (text: string, selector: string) => text.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  const preparing = {
    state: "preparing",
    step: "starting",
    stage: "wiping",
    secondsLeft: 900,
    notifyByEmail: true,
    specs: SPECS,
  } as const;

  test("one edge for every word, the icons hanging before it: in the window, on setup's step and in Settings", async () => {
    const layout = await sheet("../src/layout.css");
    // What leads a line is 14 px and the kit's icon line puts 8 px after it: the lines that lead with nothing (the
    // steps' bar and step, the time left) start 22 px in, where the others' words do.
    expect(
      rule(layout, ":is(.setup-wait, .setup-card) > :is(.setup-progress:not(.ac-iconline), .setup-eta)"),
    ).toContain("margin-left: 22px");
    expect(rule(await sheet("../../../packages/ui/src/styles/components.css"), ".ac-iconline")).toContain("gap: 8px");
    // The window keeps that room after the words too, so the words' column is the one centred under the portrait.
    expect(rule(await sheet("../src/components/computer/computer.css"), ".cmp-prep .setup-wait")).toContain(
      "padding-inline-end: 22px",
    );
    // Settings › Computers: the lines the rule finds, where it finds them, each icon 14 px.
    await open(`/org/${ORG_ID}/settings/computers`, preparing);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    expect(card.querySelector(":scope > .setup-progress:not(.ac-iconline) .ac-steps")).toBeTruthy();
    expect(card.querySelector(":scope > .setup-eta")?.textContent).toBe("Faltam uns 15 min");
    const led = [...card.querySelectorAll(":scope > .setup-line.ac-iconline")];
    expect(led).toHaveLength(2);
    for (const line of led) expect((line.firstElementChild as HTMLElement).style.width).toBe("14px");
  });

  test("the steps' bar ends as far from the right as it starts from the left: setup's well and Settings' card", async () => {
    const layout = await sheet("../src/layout.css");
    // Setup's well: its icons hang in its 14 px, the bar and the words start 22 px further in, and end as far from its
    // right edge; the AI panel's well is as far in on both sides.
    const well = layout
      .split("\n.onb__wait {")
      .slice(1)
      .map((block) => block.split("}")[0] ?? "")
      .find((block) => block.includes("padding"));
    expect(well).toContain("padding: 12px 36px 12px 14px");
    expect(rule(layout, ".ai-panel__wait")).toContain("padding: 12px 14px");
    // Settings' card: its padding on both sides, and the 22 px after the wait's lines too.
    expect(rule(layout, ".setup-card > :is(.setup-progress, .setup-eta, .setup-line)")).toContain("margin-right: 22px");
    await open(`/org/${ORG_ID}/settings/computers`, preparing);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    const lines = [...card.querySelectorAll(":scope > :is(.setup-progress, .setup-eta, .setup-line)")];
    expect(lines.length).toBe(4);
    expect(card.querySelector(":scope > .setup-progress .ac-steps")).toBeTruthy();
  });

  test("its phrases stay whole: the step's own words where they fit, the email's and the size's by no-break spaces", async () => {
    expect(rule(await sheet("../src/layout.css"), ".setup-progress .ac-eyebrow > span")).toContain(
      "display: inline-block",
    );
    await open(`/org/${ORG_ID}/settings/computers`, preparing);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    const step = card.querySelector(".setup-progress .ac-eyebrow");
    expect(step?.textContent).toBe("Passo 2 de 4 · Limpando para começar do zero");
    expect(step?.querySelector(":scope > span")?.textContent).toBe("Limpando para começar do zero");
    // Lines break only between phrases: around the address, and after each of the size's dots.
    const breaks = (s: string) => s.split(" ");
    for (const [strings, you, specs] of [
      [ptBR, ["Avisamos você em", "{{email}}", "quando ele ficar pronto."], ["de memória"]],
      [en, ["We'll email you at", "{{email}}", "when it's ready."], ["of memory"]],
    ] as const) {
      expect(breaks(strings.computerSetup.email.you)).toEqual([...you]);
      expect(breaks(strings.computerSetup.specs)).toHaveLength(3);
      expect(strings.computerSetup.specs).toContain(specs[0]);
    }
    // A problem's last sentence wraps whole.
    expect(breaks(ptBR.computerSetup.status.problem).at(-1)).toBe("Já estamos cuidando.");
    expect(breaks(en.computerSetup.status.problem).at(-1)).toBe("We're on it.");
  });

  test("a problem's line wraps plainly, so its last sentence goes whole to the next line", async () => {
    // `pretty` takes that sentence, one phrase, for a short last line and pulls the word before it under it.
    expect(
      rule(
        await sheet("../src/layout.css"),
        ':is(.setup-wait, .setup-card) > .setup-progress--line[data-phase="problem"]',
      ),
    ).toContain("text-wrap: wrap");
    await open(`/org/${ORG_ID}/settings/computers`, { state: "problem", notifyByEmail: true, specs: SPECS });
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    expect(card.querySelector(':scope > .setup-progress--line[data-phase="problem"]')?.textContent).toBe(
      "Algo deu errado ao preparar o computador. Já estamos cuidando.",
    );
  });

  test("Settings › Computers' card ends as far under its last line's baseline as its drawing starts under its top", async () => {
    const layout = await sheet("../src/layout.css");
    // The card's padding under the baseline, as above the drawing (`--cap-top` and `--cap-mid` place the line's
    // capitals in its box), with the page's 22 px line where the lh unit is missing.
    expect(rule(layout, ".setup-card > p:last-child")).toContain(
      "margin-bottom: calc(var(--cap-top) - 2 * var(--cap-mid) - 11px)",
    );
    expect(layout.split("\n  .setup-card > p:last-child {")[1]?.split("}")[0]).toContain(
      "margin-bottom: calc(var(--cap-top) - 2 * var(--cap-mid) - 0.5lh)",
    );
    // The size is its last line on the way, a paragraph the rule finds.
    await open(`/org/${ORG_ID}/settings/computers`, preparing);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    expect(card.lastElementChild?.matches("p.setup-line")).toBe(true);
    expect(card.lastElementChild?.textContent).toContain("100 GB de disco");
  });
});
