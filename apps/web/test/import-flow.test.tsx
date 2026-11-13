import { afterEach, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ApiClient, ImportFileInput, ImportInput, ImportItemResult, ImportPlan } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/fileSaver";
import { ImportFlow, useImportFlow } from "@/components/ImportFlow";
import { EXPORT_PROMPT } from "@/lib/import";
import { zip } from "./archives";
import { createFakeApi, fakeAppsOf, ORG_ID, seedState } from "./fake-api";
import { type FakeApps, SERVER_URL } from "./fakes/apps";
import { renderApp, renderPage, screen, settle } from "./render";

const realSave = fileSaver.save;
afterEach(() => {
  cleanup();
  fileSaver.save = realSave;
});

const FIXTURES = join(import.meta.dir, "fixtures", "agent-import");
type State = ReturnType<typeof seedState>;

const go = async (state: State = seedState(), api: ApiClient = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/settings/import`, { api });
  await settle(6);
  return { ...r, state, api };
};
const button = (name: string | RegExp) => screen().getByRole("button", { name });
const radio = (name: string) => screen().getByRole("radio", { name });
const click = async (el: Element, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: State, method: string) => state.calls.filter((c) => c.method === method);
const applies = (state: State) => calls(state, "imports.apply").map((c) => c.args[1] as ImportInput);
const text = () => document.body.textContent ?? "";

/** Files into one of the flow's pickers ("Arquivos para importar", "Pasta para importar"). */
const pick = async (label: string, files: File[]) => {
  const input = screen().getByLabelText(label) as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => fireEvent.change(input));
  await settle(10);
};
/** A fixture folder as the folder picker gives it: every path under the folder's name. */
const folder = (name: string): File[] => {
  const root = join(FIXTURES, name);
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  return walk(root).map((path) => {
    const file = new File([readFileSync(path)], basename(path));
    Object.defineProperty(file, "webkitRelativePath", { value: `${name}/${relative(root, path)}` });
    return file;
  });
};
const fixture = (name: string) => new File([readFileSync(join(FIXTURES, name))], name);
/** A fixture folder as a drag-and-drop hands it over: a directory entry walked with its reader. */
const folderEntry = (dir: string, path: string): unknown => {
  const abs = join(FIXTURES, dir);
  if (!statSync(abs).isDirectory()) {
    return { isFile: true, isDirectory: false, fullPath: path, file: (ok: (f: File) => void) => ok(fixture(dir)) };
  }
  const children = readdirSync(abs)
    .sort()
    .map((n) => folderEntry(join(dir, n), `${path}/${n}`));
  return {
    isFile: false,
    isDirectory: true,
    fullPath: path,
    createReader: () => {
      let read = false;
      return {
        readEntries: (ok: (entries: unknown[]) => void) => {
          ok(read ? [] : children);
          read = true;
        },
      };
    },
  };
};
/** Drags `dt` over the flow and drops it. */
const drop = async (dt: { files: File[]; items: unknown[] }) => {
  const zone = document.querySelector(".imp-pick") as HTMLElement;
  const dataTransfer = { ...dt, types: ["Files"], dropEffect: "none" };
  await act(async () => fireEvent.dragOver(zone, { dataTransfer }));
  expect(text()).toContain("Pode soltar");
  await act(async () => fireEvent.drop(zone, { dataTransfer }));
  await settle(10);
};
/** The plan row whose title is `title`. */
const row = (title: string) => {
  const found = [...document.querySelectorAll(".imp-row")].find(
    (r) => r.querySelector(".imp-row__title")?.textContent === title,
  );
  if (!found) throw new Error(`no row ${title}`);
  return found as HTMLElement;
};
const chipOf = (title: string) => row(title).querySelector(".imp-row__chip")?.textContent;
/** A line led by an icon that `.ac-iconline` puts on the line's first row. */
const iconLine = (line: Element | null) =>
  !!line?.classList.contains("ac-iconline") && !!line.firstElementChild?.matches("svg.ac-icon");
/** What an app given `EXPORT_PROMPT` writes, naming itself `app`. */
const exportReply = (app: string, name: string) => ({
  format: "agenteschat.bundle",
  version: 1,
  source: { app, ref: "my-bots", name, files: [] },
  agents: [
    {
      key: "news",
      name: "Newsy",
      handle: "news",
      role: "Notícias do dia",
      instructions: "Resume as notícias do dia em cinco tópicos.",
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
});
/** A reply pasted in the link field as an app answers in its chat: some words, then the JSON in a code block. */
const pasteReply = async (reply: object) => {
  const field = screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app");
  const pasted = `Aqui está:\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\``;
  await act(async () => fireEvent.paste(field, { clipboardData: { getData: () => pasted } }));
  await settle(10);
};
/** `imports.apply` answering with `plan` for the dry run (and the default fake otherwise). */
const withPlan = (api: ApiClient, state: State, plan: (input: ImportInput) => ImportItemResult[]) => {
  const fake = api.imports.apply;
  api.imports = {
    ...api.imports,
    apply: async (orgId, input) => {
      if (!input.dryRun) return fake(orgId, input);
      state.calls.push({ method: "imports.apply", args: [orgId, input] });
      return { items: plan(input) };
    },
  };
};

describe("Configurações → Importar e exportar", () => {
  test("admins find it in the nav; the export downloads the bundle, says in one line what never goes, and links the rest", async () => {
    const saved: [string, string][] = [];
    fileSaver.save = (url, name) => saved.push([url, name]);
    await go();
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).getByRole("link", { name: "Importar e exportar" }).getAttribute("aria-current")).toBe("page");
    expect(screen().getByRole("heading", { level: 2, name: "Importar e exportar" })).toBeTruthy();

    // The import card's title alone: the page's subtitle says what importing is for.
    const imports = screen().getByRole("region", { name: "Importar" });
    expect(imports.querySelector(".ac-card__sub")).toBeNull();

    const card = screen().getByRole("region", { name: "Exportar" });
    expect(card.querySelector(".ac-card__sub, ul, .ac-card__foot")).toBeNull();
    // Whoever shares the file needs to know what never goes in it: one line. The full list is on the help page.
    expect(card.querySelector(".imp-note")?.textContent).toBe("Nunca leva chaves, senhas, logins nem conversas.");
    const whatsIn = within(card).getByRole("link", { name: "O que vai no arquivo" });
    expect(whatsIn.getAttribute("href")).toBe("https://agentes.chat/pt/docs/import#export");
    expect(whatsIn.className).toBe("ac-link ac-link--muted");
    expect([whatsIn.getAttribute("target"), whatsIn.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    await click(within(card).getByRole("button", { name: "Baixar o arquivo" }));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[0]).toBe(`/api/app/organizations/${ORG_ID}/export`);
    expect(saved[0]?.[1]).toMatch(/^agentes-chat-\d{4}-\d{2}-\d{2}\.json$/);
  });

  test("members don't see it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).queryByRole("link", { name: "Importar e exportar" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Exportar" })).toBeNull();
  });

  test("the most used apps first, each by its official logo, in the maker's own dark file when the app (not the system) is dark", async () => {
    const device = domWindow().happyDOM.settings.device;
    const logos = () =>
      [...document.querySelectorAll(".imp-source")].map((card) => [
        card.querySelector(".ac-option__title")?.textContent,
        card.querySelector(".imp-mark img")?.getAttribute("src") ?? null,
      ]);
    try {
      // The system is dark, but the app is set to light: the light files.
      device.prefersColorScheme = "dark";
      localStorage.setItem("agentes.theme", "light");
      await go();
      expect(logos()).toEqual([
        ["Grok Bot", "/brands/grok-bot.svg"],
        ["ChatGPT dots", "/brands/chatgpt-dots.svg"],
        ["OpenBot.run", "/brands/openbotrun.svg"],
        ["OpenMausBot", "/brands/openmausbot.svg"],
        ["Hermes Agent", "/brands/hermes.svg"],
        ["OpenClaw", "/brands/openclaw.svg"],
        ["Paperclip", "/brands/paperclip.svg"],
        ["agentes.chat", "/favicon.svg"],
        // It names many apps: no one maker's logo fits.
        ["Outro app", null],
      ]);
      cleanup();
      // The app set to dark: Grok Bot, Hermes and Paperclip by their dark files, the others read on both.
      localStorage.setItem("agentes.theme", "dark");
      await go();
      expect(logos()).toEqual([
        ["Grok Bot", "/brands/grok-bot-dark.svg"],
        ["ChatGPT dots", "/brands/chatgpt-dots.svg"],
        ["OpenBot.run", "/brands/openbotrun.svg"],
        ["OpenMausBot", "/brands/openmausbot.svg"],
        ["Hermes Agent", "/brands/hermes-dark.svg"],
        ["OpenClaw", "/brands/openclaw.svg"],
        ["Paperclip", "/brands/paperclip-dark.svg"],
        ["agentes.chat", "/favicon.svg"],
        ["Outro app", null],
      ]);
    } finally {
      device.prefersColorScheme = "light";
      localStorage.removeItem("agentes.theme");
    }
  });

  test("the picker: each app by its mark and name alone; the lock line keeps what matters, the rest in its ⓘ", async () => {
    await go();
    expect(document.querySelector(".imp-source .ac-option__desc")).toBeNull();
    expect(button("OpenClaw").textContent).toBe("OpenClaw");
    expect(document.querySelector(".imp-drop__area")?.textContent).toBe(
      "Solte aqui a pasta, o arquivo ou o .zipou clique para escolher",
    );
    // Read before anything is dropped, by whoever is about to drop a folder that holds keys.
    const lock = document.querySelector(".imp-pick > .imp-note") as HTMLElement;
    expect(iconLine(lock)).toBe(true);
    expect(lock.querySelector(".ac-hintline > span")?.textContent).toBe(
      "Lido no seu navegador. Arquivos de chaves e de login nunca são abertos.",
    );
    // Named by its subject, so a screen reader doesn't read the line's sentence a second time.
    const about = within(lock).getByRole("button", { name: "Sobre Privacidade" });
    const more = "Um link do GitHub passa pelo servidor do workspace. Nada muda aqui até você confirmar.";
    expect(document.getElementById(about.getAttribute("aria-describedby") ?? "")?.textContent).toBe(more);
    await click(about, 2);
    expect(screen().getByRole("tooltip").textContent).toBe(more);
  });

  test("Grok Bot: Conectar com MCP by default, in the bot's own steps, then the request; nothing to drop or paste", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (s: string) => void writes.push(s) },
    });
    await go();
    await click(button("Grok Bot"), 2);
    const how = screen().getByRole("radiogroup", { name: "Como trazer" });
    expect(
      within(how)
        .getAllByRole("radio")
        .map((r) => [r.textContent, r.getAttribute("aria-checked")]),
    ).toEqual([
      ["Conectar com MCP", "true"],
      ["Só o pedido", "false"],
    ]);
    const mcp = screen().getByRole("region", { name: "Conectar com MCP" });
    expect(mcp.querySelector("p")?.textContent).toBe(
      "O MCP deixa o Grok Bot acessar este workspace, e ele cria os agentes aqui sozinho.",
    );
    // In order: the access is picked where the sign-in asks, and the server is attached before the request.
    const steps = [...mcp.querySelectorAll("ol > li")];
    expect(steps.map((li) => (li.querySelector(".apps-step > span") ?? li).textContent)).toEqual([
      "Na conversa com o seu bot, mande:",
      "Clique em Add it e depois em Authorize.",
      "Entre com sua conta do agentes.chat na página que abrir e escolha Criar e editar agentes, rotinas e skills.",
      "Na conversa, digite @ e escolha agentes.",
      "Cole este pedido no app:",
    ]);
    expect([...mcp.querySelectorAll(".machine-command__code")].map((c) => c.textContent)).toEqual([
      `Add a custom MCP server called agentes at ${SERVER_URL}`,
    ]);
    const prompt = `Use o servidor MCP do agentes.chat que você acabou de conectar (${SERVER_URL}) para trazer o que você tem para o agentes.chat. Primeiro chame import_summary para ver o que já existe lá e não duplicar nada. Depois, para cada agente, instrução, skill e rotina que você tem, crie o equivalente com create_agent, create_skill e create_routine, e guarde o que cada agente deve lembrar com add_memory.`;
    expect((within(mcp).getByLabelText("Pedido para o seu app de IA") as HTMLTextAreaElement).value).toBe(prompt);
    await click(within(mcp).getByRole("button", { name: "Copiar o pedido" }), 2);
    expect(writes).toEqual([prompt]);
    expect(mcp.textContent).toContain("Esperando os agentes chegarem…");
    // What to check shows only once a while passes with nothing.
    expect(mcp.textContent).not.toContain("Nada depois de alguns minutos?");
    // Grok Bot's steps say where: no help link, and nothing here to drop or paste.
    expect(within(mcp).queryByRole("link")).toBeNull();
    expect(document.querySelector(".imp-drop")).toBeNull();
    expect(screen().queryByLabelText("Ou cole um link do GitHub ou a resposta do outro app")).toBeNull();

    // Só o pedido: today's request, the drop zone and the paste field.
    await click(radio("Só o pedido"), 2);
    expect(screen().queryByRole("region", { name: "Conectar com MCP" })).toBeNull();
    expect(screen().getByRole("region", { name: "Peça para o seu bot exportar" })).toBeTruthy();
    expect(document.querySelector(".imp-drop")).toBeTruthy();
    expect(screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app")).toBeTruthy();
    // The pick stays with its source: another card has its own default, and Grok Bot keeps Só o pedido.
    await click(button("Hermes Agent"), 2);
    expect(radio("Conectar com MCP").getAttribute("aria-checked")).toBe("true");
    await click(button("Grok Bot"), 2);
    expect(radio("Só o pedido").getAttribute("aria-checked")).toBe("true");
  });

  test("ChatGPT dots: Só o pedido by default; MCP shows ChatGPT's own steps and its notes", async () => {
    await go();
    await click(button("ChatGPT dots"), 2);
    expect(radio("Só o pedido").getAttribute("aria-checked")).toBe("true");
    expect(screen().getByRole("region", { name: "Peça para o seu dot exportar" })).toBeTruthy();
    await click(radio("Conectar com MCP"), 2);
    const mcp = screen().getByRole("region", { name: "Conectar com MCP" });
    expect(mcp.querySelector("p")?.textContent).toBe(
      "O MCP deixa o seu dot acessar este workspace por um plugin que você adiciona no ChatGPT, e ele cria os agentes aqui sozinho.",
    );
    const open = within(mcp).getByRole("link", { name: "Abrir o ChatGPT" });
    expect([open.getAttribute("href"), open.getAttribute("target")]).toEqual(["https://chatgpt.com/plugins", "_blank"]);
    expect(within(mcp).getByText(SERVER_URL)).toBeTruthy();
    expect(mcp.textContent).toContain("Não dá para adicionar pelo app do celular.");
    expect(mcp.textContent).toContain(
      "Entre com sua conta do agentes.chat na página que abrir e escolha Criar e editar agentes, rotinas e skills.",
    );
  });

  test("the file apps: MCP by default in each one's own words; Por arquivo brings back where its file is", async () => {
    await go();
    const codes = () => [...document.querySelectorAll(".machine-command__code")].map((c) => c.textContent);
    await click(button("Hermes Agent"), 2);
    expect(codes()).toEqual([`mcp_servers:\n  agentes:\n    url: "${SERVER_URL}"\n    auth: oauth`]);
    const words = () =>
      [...document.querySelectorAll(".apps-steps > li")].map(
        (li) => (li.querySelector(".apps-step > span") ?? li).textContent,
      );
    expect(words()).toEqual([
      "Cole em ~/.hermes/config.yaml:",
      "Para entrar, rode hermes mcp login agentes.",
      "Entre com sua conta do agentes.chat na página que abrir e escolha Criar e editar agentes, rotinas e skills.",
      "Depois digite /reload-mcp na conversa.",
      "Cole este pedido no app:",
    ]);
    expect(document.querySelector(".imp-tip")).toBeNull();
    expect(document.querySelector(".imp-drop")).toBeNull();
    await click(radio("Por arquivo"), 2);
    expect(document.querySelector(".imp-tip")?.textContent).toContain("hermes profile export");
    expect(document.querySelector(".imp-drop")).toBeTruthy();

    await click(button(/^OpenClaw$/), 2);
    // The Gateway starts again once the sign-in ends, before the request is pasted.
    expect(codes()).toEqual([
      `openclaw gateway stop\nopenclaw mcp set agentes '{"url":"${SERVER_URL}","transport":"streamable-http","auth":"oauth"}'\nopenclaw mcp login agentes\nopenclaw gateway start`,
    ]);

    await click(button("OpenMausBot"), 2);
    expect(text()).toContain("Abra Plugins\u00a0›\u00a0MCP servers.");
    expect(codes()).toEqual([SERVER_URL]);

    // No menu words documented: the generic step and the help page, in a new tab.
    await click(button(/^OpenBot\.run$/), 2);
    expect(text()).toContain("Cole o endereço no app. Ele abre esta página para você entrar.");
    const help = screen().getByRole("link", { name: "Como conectar, app por app" });
    expect([help.getAttribute("href"), help.getAttribute("target")]).toEqual([
      "https://agentes.chat/pt/docs/apps-de-ia#connect",
      "_blank",
    ]);

    // Paperclip and our own export take no MCP server: their tip alone.
    for (const name of [/^Paperclip$/, /^agentes\.chat$/]) {
      await click(button(name), 2);
      expect(screen().queryByRole("radiogroup", { name: "Como trazer" })).toBeNull();
      expect(document.querySelector(".imp-tip")).toBeTruthy();
      expect(document.querySelector(".imp-drop")).toBeTruthy();
    }
  });

  test("a server apps on the internet can't reach: no MCP choice, today's steps and one line saying why", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    (fakeAppsOf.get(api) as FakeApps).serverPublic = false;
    await go(state, api);
    await click(button("Grok Bot"), 2);
    expect(screen().queryByRole("radiogroup", { name: "Como trazer" })).toBeNull();
    expect(screen().getByRole("region", { name: "Peça para o seu bot exportar" })).toBeTruthy();
    expect(screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app")).toBeTruthy();
    expect(text()).toContain(
      "Conectar com MCP não está disponível neste servidor, porque apps na internet só alcançam um endereço https público.",
    );
  });

  test("the agents the app creates arrive live: only mine made after the step opened, each linked to its page", async () => {
    const state = seedState();
    const me = state.me?.user.id as string;
    const base = state.agents[0] as State["agents"][number];
    // Mine, but here before the step opened.
    state.agents.push({ ...base, id: "a-old", name: "Velho", handle: "velho", ownerUserId: me });
    const r = await go(state);
    await act(async () => r.sockets.last().open());
    await click(button("Grok Bot"), 4);
    expect(text()).toContain("Esperando os agentes chegarem…");
    state.agents.push(
      { ...base, id: "a-nina", name: "Nina", handle: "nina", ownerUserId: me },
      { ...base, id: "a-otto", name: "Otto", handle: "otto", ownerUserId: "u-someone-else" },
    );
    await act(async () => r.sockets.last().push({ type: "event", scope: "org", event: { type: "agents.changed" } }));
    await settle(6);
    const mcp = screen().getByRole("region", { name: "Conectar com MCP" });
    expect(mcp.querySelector(".imp-arrivals__line")?.textContent).toBe("1 agente chegou");
    expect(
      within(mcp)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    ).toEqual([["Nina", `/org/${ORG_ID}/agents/a-nina`]]);
    expect(mcp.textContent).not.toContain("Esperando os agentes chegarem…");
    // In place: nothing here moved the page.
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/import`);
  });

  test("embedded (as onboarding places it): outside the workspace's pages, it never links out or moves the page", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const me = state.me?.user.id as string;
    const base = state.agents[0] as State["agents"][number];
    function Embedded() {
      const flow = useImportFlow(ORG_ID);
      return <ImportFlow flow={flow} orgId={ORG_ID} />;
    }
    const r = await renderPage(<Embedded />, { api, path: "/onboarding" });
    await settle(6);
    await click(button("Grok Bot"), 4);
    expect(radio("Conectar com MCP").getAttribute("aria-checked")).toBe("true");
    state.agents.push({ ...base, id: "a-nina", name: "Nina", handle: "nina", ownerUserId: me });
    await act(async () => r.services.queryClient.invalidateQueries({ queryKey: ["org", ORG_ID, "agents"] }));
    await settle(6);
    expect(text()).toContain("1 agente chegou");
    expect(text()).toContain("Nina");
    expect(screen().queryByRole("link", { name: "Nina" })).toBeNull();
    expect(r.router.state.location.pathname).toBe("/onboarding");
  });

  test("the flow's own imports never count as arrived: Só o pedido, Importar outro arquivo, then MCP waits again", async () => {
    const { state } = await go();
    await click(button("Grok Bot"), 4);
    expect(text()).toContain("Esperando os agentes chegarem…");
    await click(radio("Só o pedido"), 2);
    await pasteReply(exportReply("grok-bot", "Minhas automações"));
    await click(button(/^Importar \d+ ite/), 8);
    expect(state.agents.some((a) => a.name === "Newsy")).toBe(true);
    await click(button("Importar outro arquivo"), 4);
    expect(button("Grok Bot").getAttribute("aria-pressed")).toBe("true");
    await click(radio("Conectar com MCP"), 6);
    const line = () => document.querySelector(".imp-arrivals__line")?.textContent;
    expect(line()).toBe("Esperando os agentes chegarem…");
    // Another source's MCP step counts from when it opened, not from the first one's.
    await click(button("Hermes Agent"), 6);
    expect(line()).toBe("Esperando os agentes chegarem…");
  });

  test("a file dropped on the MCP steps, then Trocar arquivo: focus lands on the steps, the drop zone isn't there", async () => {
    await go();
    await click(button("Grok Bot"), 4);
    const file = new File([JSON.stringify(exportReply("grok-bot", "Meu bot"))], "agentes-chat-export.json");
    await drop({ files: [file], items: [] });
    expect(text()).toContain("Veio do Grok Bot");
    await click(button("Trocar arquivo"), 4);
    expect(document.querySelector(".imp-drop")).toBeNull();
    expect(document.activeElement).toBe(screen().getByRole("region", { name: "Conectar com MCP" }));
  });

  test("the apps list fails: each source keeps its request or tip, with no MCP choice", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.apps = {
      ...api.apps,
      list: async () => {
        throw new ApiError(500, "internal", "boom");
      },
    };
    await go(state, api);
    await click(button("Grok Bot"), 6);
    expect(screen().queryByRole("radiogroup", { name: "Como trazer" })).toBeNull();
    expect(screen().getByRole("region", { name: "Peça para o seu bot exportar" })).toBeTruthy();
    expect(screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app")).toBeTruthy();
    await click(button("Hermes Agent"), 2);
    expect(document.querySelector(".imp-tip")?.textContent).toContain("hermes profile export");
  });

  test("the agents can't be read when the MCP step opens: it says why and reads them again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const list = api.agents.list;
    let fail = true;
    api.agents = {
      ...api.agents,
      list: async (orgId) => {
        if (fail) throw new ApiError(500, "internal", "boom");
        return list(orgId);
      },
    };
    await go(state, api);
    await click(button("Grok Bot"), 8);
    const mcp = () => screen().getByRole("region", { name: "Conectar com MCP" });
    expect(mcp().textContent).not.toContain("Esperando os agentes chegarem…");
    expect(within(mcp()).getByRole("alert")).toBeTruthy();
    fail = false;
    await click(within(mcp()).getByRole("button", { name: "Tentar de novo" }), 8);
    expect(mcp().textContent).toContain("Esperando os agentes chegarem…");
  });

  test("its notes and lists lead each line with an icon on the line's first row", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // The import leaves the routine out, so the report lists what didn't come.
    const fake = api.imports.apply;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        const { items } = await fake(orgId, input);
        if (input.dryRun) return { items };
        const left = (i: ImportItemResult): ImportItemResult => ({
          ...i,
          action: "skip",
          reason: "schedule_unsupported",
        });
        return { items: items.map((i) => (i.kind === "routine" ? left(i) : i)) };
      },
    };
    await go(state, api);
    const seen: [string, Element[]][] = [];
    const take = (...selectors: string[]) => {
      for (const s of selectors) seen.push([s, [...document.querySelectorAll(s)]]);
    };
    take(".imp-note");
    await click(button(/^Paperclip$/), 1);
    take(".imp-tip");
    await pick("Pasta para importar", folder("paperclip-company"));
    take(".imp-note");
    await click(button(/^Importar \d+ itens/), 8);
    take(".imp-missed li", ".imp-todo li");
    for (const [selector, lines] of seen) {
      expect([selector, lines.length > 0]).toEqual([selector, true]);
      for (const line of lines) expect([selector, iconLine(line)]).toEqual([selector, true]);
    }
  });

  test("a folder is recognized and planned on the server; unchecking an agent holds back what needs it; Importar applies and reports", async () => {
    const { state } = await go();
    // Each app the parsers read has a card with where its file is, but OpenBot, which few use: the drop zone reads
    // any of them, and the help behind Outro app says where OpenBot's files are.
    for (const name of ["OpenBot.run", "OpenMausBot", "Hermes Agent", "OpenClaw", "Paperclip"]) {
      expect(button(new RegExp(`^${name.replace(".", "\\.")}$`))).toBeTruthy();
    }
    expect(screen().queryByRole("button", { name: /^OpenBot$/ })).toBeNull();
    await click(button(/^OpenBot\.run$/), 1);
    await click(radio("Por arquivo"), 1);
    expect(text()).toContain("Solte o openbot-import.json");
    await click(button(/^agentes\.chat$/), 1);
    expect(text()).toContain("Configurações → Importar e exportar → Baixar o arquivo");

    await pick("Pasta para importar", folder("paperclip-company"));
    // Read here, planned there: nothing is written before Importar.
    expect(applies(state).map((i) => i.dryRun)).toEqual([true]);
    const title = screen().getByRole("heading", { name: "Corner Studio" });
    expect(document.activeElement === title).toBe(true);
    expect(text()).toContain("Veio do Paperclip");
    for (const group of ["Agentes", "Skills", "Rotinas", "Memória"]) {
      expect(screen().getByRole("region", { name: group })).toBeTruthy();
    }
    // A new row says nothing: no chip.
    expect(chipOf("Linus · Chief Technology Officer")).toBeUndefined();
    const routines = screen().getByRole("region", { name: "Rotinas" });
    // Skills arrive on and routines active: nothing to say, nothing to switch.
    expect(text()).not.toContain("Chegam");
    expect(screen().queryByRole("switch", { name: /^Ligar para/ })).toBeNull();

    const bring = (name: string) => screen().getByRole("checkbox", { name: `Trazer ${name}` });
    await click(bring("Ada"), 2);
    expect(bring("Ada").getAttribute("aria-checked")).toBe("false");
    // Her routines can't come without her, and say so.
    expect(within(routines).queryAllByRole("checkbox")).toHaveLength(0);
    expect(chipOf("Heartbeat")).toBe("pulado");
    expect(row("Heartbeat").textContent).toContain("O agente dela não vem.");

    // What to set up comes after the import; what doesn't come along isn't listed.
    expect(screen().queryByRole("list", { name: "Para configurar" })).toBeNull();
    expect(text()).not.toContain("O que não vem junto");
    expect(text()).not.toContain("gpt-imaginary-2");

    await click(button("Importar 3 itens"), 8);
    const applied = applies(state).filter((i) => !i.dryRun);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.pick).toEqual(["skill:review", "agent:cto", "note:COMPANY.md"]);
    expect("enableSkills" in (applied[0] ?? {})).toBe(false);
    // Every agent goes along, so the handles new ones get don't depend on the pick; only the picked one comes.
    expect(applied[0]?.bundle.agents.map((a) => a.key)).toEqual(["ceo", "cto"]);

    // The report: what came, with links, and focus on it.
    expect(document.activeElement === screen().getByRole("heading", { name: "Chegou tudo" })).toBe(true);
    const report = screen().getByRole("region", { name: "Chegou tudo" });
    expect(report.textContent).toContain("1 agente");
    expect(report.textContent).toContain("1 memória");
    const linus = within(report)
      .getAllByRole("link")
      .find((l) => l.textContent?.includes("Linus"));
    expect(linus?.getAttribute("href")).toStartWith(`/org/${ORG_ID}/agents/`);
    expect(within(report).getByRole("link", { name: "Abrir Skills" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/skills`,
    );
    const todo = screen().getByRole("list", { name: "Para configurar" });
    expect(
      within(todo)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Ada usa GH_TOKEN. Não vem no arquivo: o agente pede no chat.",
      "Ada e Linus usam OPENAI_API_KEY. Não vem no arquivo: os agentes pedem no chat.",
    ]);
    await click(button("Importar outro arquivo"), 2);
    expect(document.activeElement?.textContent).toContain("Solte aqui a pasta, o arquivo ou o .zip");
  });

  test("routines that arrived paused at their agent's limit are counted in the report", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const apply = api.imports.apply;
    api.imports.apply = async (orgId, input) => {
      const plan = await apply(orgId, input);
      if (input.dryRun) return plan;
      const items = plan.items.map((i) => (i.kind === "routine" ? { ...i, reason: "too_many_routines" as const } : i));
      return { ...plan, items };
    };
    await go(state, api);
    await pick("Pasta para importar", folder("paperclip-company"));
    const importIt = screen()
      .getAllByRole("button")
      .find((b) => /^Importar \d+ itens$/.test(b.textContent ?? ""));
    if (!importIt) throw new Error("no Importar");
    await click(importIt, 8);
    const report = screen().getByRole("region", { name: "Chegou tudo" });
    expect(report.textContent).toMatch(/\d+ rotinas? cheg(ou|aram) pausadas?: /);
  });

  test("dropping a file, or a whole folder (walked through its entries), reads it the same way", async () => {
    await go();
    await drop({ files: [fixture("sales-desk.openmaus.json")], items: [] });
    expect(screen().getByRole("heading", { name: "Sales desk" })).toBeTruthy();
    expect(text()).toContain("Veio do OpenMausBot");

    await click(button("Trocar arquivo"), 2);
    await drop({
      files: [],
      items: [{ webkitGetAsEntry: () => folderEntry("openclaw-workspace", "/openclaw-workspace") }],
    });
    expect(screen().getByRole("heading", { name: "Pinch" })).toBeTruthy();
    expect(text()).toContain("Veio do OpenClaw");
    expect(screen().getByRole("checkbox", { name: "Trazer Pinch" }).getAttribute("aria-checked")).toBe("true");
  });

  test("each row says what happens: already here, will update, joins a channel, renamed, skipped and why, cut to fit", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    withPlan(api, state, () => [
      { kind: "skill", key: "pricing-policy", label: "pricing-policy", action: "unchanged" },
      { kind: "skill", key: "research-brief", label: "research-brief", action: "skip", reason: "exists" },
      { kind: "skill", key: "objection-handling", label: "objection-handling", action: "create" },
      { kind: "agent", key: "lead", label: "Morgan", action: "create", renamedTo: "lead2" },
      { kind: "agent", key: "scout", label: "Scout", action: "update" },
      { kind: "agent", key: "writer", label: "Quill", action: "create", reason: "model_not_in_catalog" },
      { kind: "channel", key: "desk", label: "deal-desk", action: "update", reason: "exists" },
      { kind: "channel", key: "room", label: "vendas", action: "update" },
      { kind: "routine", key: "daily-digest", label: "Daily digest", action: "skip", reason: "schedule_unsupported" },
      { kind: "routine", key: "weekly-review", label: "Weekly pipeline review", action: "create" },
      {
        kind: "note",
        key: "lead/MEMORY.md",
        label: "- The team prefers short summaries.",
        action: "skip",
        reason: "secret_like",
      },
      { kind: "note", key: "lead/memory/pricing.md", label: "# Pricing", action: "create", trimmed: ["content"] },
    ]);
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);

    expect(chipOf("pricing-policy")).toBe("já está aqui");
    expect(chipOf("research-brief")).toBe("pulado");
    expect(row("research-brief").textContent).toContain("Já existe uma skill com esse nome aqui. Ela fica como está.");
    expect(chipOf("Morgan · Sales lead")).toBeUndefined();
    expect(row("Morgan · Sales lead").textContent).toContain("Vira @lead2: o @lead já existe aqui.");
    expect(chipOf("Scout · Prospect researcher")).toBe("vai atualizar");
    expect(row("Scout · Prospect researcher").textContent).toContain("Mudou no outro app desde a última importação");
    expect(row("Quill · Outreach writer").textContent).toContain("usa o padrão do workspace");
    expect(chipOf("#deal-desk")).toBe("já existe");
    expect(row("#deal-desk").textContent).toContain("Os agentes entram no #deal-desk que já existe.");
    // One an earlier import made: the agents come in, nothing of it "gives way".
    expect(chipOf("#vendas")).toBe("vai atualizar");
    expect(row("#vendas").textContent).toContain("Os agentes entram no #vendas que já existe.");
    expect(row("#vendas").textContent).not.toContain("Mudou no outro app");
    expect(chipOf("Daily digest")).toBe("pulado");
    expect(row("Daily digest").textContent).toContain("Esse horário não dá para agendar aqui.");
    expect(row("The team prefers short summaries.").textContent).toContain("parecido com uma chave ou senha");
    expect(row("Pricing").textContent).toContain("Cortado para caber: texto.");
    // What is already here or skipped isn't a choice; the rest is, checked.
    expect(screen().queryByRole("checkbox", { name: "Trazer pricing-policy" })).toBeNull();
    expect(screen().queryByRole("checkbox", { name: "Trazer Daily digest" })).toBeNull();
    expect(screen().getByRole("checkbox", { name: "Trazer Scout" }).getAttribute("aria-checked")).toBe("true");
    // Skipped rows go last in their group.
    const skills = screen().getByRole("region", { name: "Skills" });
    expect([...skills.querySelectorAll(".imp-row__title")].map((t) => t.textContent)).toEqual([
      "objection-handling",
      "pricing-policy",
      "research-brief",
    ]);
    expect(button("Importar 8 itens")).toBeTruthy();
  });

  test("an OpenBot.run export whose agents are ids: each row shows the @ the agent gets, never the id", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // The server names an agent whose handle is an id after the agent.
    const named = ["otavioofertas", "newagent"];
    withPlan(api, state, (input) =>
      input.bundle.agents.map((a, i) => ({
        kind: "agent",
        key: a.key,
        label: a.name,
        action: "create",
        renamedTo: named[i],
      })),
    );
    await go(state, api);
    const file = {
      format: "openbot-agent-import",
      version: 1,
      source: { app: "grok-bot" },
      agents: [
        { key: "agent-e9665a97-c8d5-423f-ae59-257f9ab85263", name: "Otávio Ofertas", title: "Vendas" },
        { key: "agent-925ca021-21e4-4053-9e0a-230b9e8c127a", name: "New agent" },
      ],
    };
    await pick("Arquivos para importar", [new File([JSON.stringify(file)], "openbot-import.json")]);

    expect(row("Otávio Ofertas · Vendas").textContent).toContain("@otavioofertas");
    expect(row("New agent").textContent).toContain("@newagent");
    expect(text()).not.toContain("@agent-");
    // Not a rename: the id was never a handle here.
    expect(text()).not.toContain("já existe aqui");
    // The bundle keeps the ids, so a file imported before still matches what it made.
    expect(applies(state)[0]?.bundle.agents.map((a) => a.handle)).toEqual([
      "agent-e9665a97-c8d5-423f-ae59-25",
      "agent-925ca021-21e4-4053-9e0a-23",
    ]);
  });

  test("nothing new, or nothing that can come: it says so instead of offering Importar", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let action: ImportItemResult["action"] = "unchanged";
    withPlan(api, state, (input) =>
      input.bundle.agents.map((a) => ({
        kind: "agent",
        key: a.key,
        label: a.name,
        action,
        ...(action === "skip" ? { reason: "secret_like" as const } : {}),
      })),
    );
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(text()).toContain("Tudo isso já está aqui.");
    expect(iconLine(document.querySelector(".imp-apply__none"))).toBe(true);
    expect(screen().queryByRole("button", { name: /^Importar \d/ })).toBeNull();

    action = "skip";
    await click(button("Trocar arquivo"), 2);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(text()).toContain("Nada daqui pode vir. O motivo está em cada item.");
    expect(screen().queryByRole("button", { name: /^Importar \d/ })).toBeNull();
  });

  test("Outro app: the export request to copy, a link to where each app answers, and a pasted reply read at once", async () => {
    const writes: string[] = [];
    let copyWorks = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (s: string) => {
          if (!copyWorks) throw new Error("denied");
          writes.push(s);
        },
      },
    });
    await go();
    await click(button(/^Outro app/), 2);
    await click(radio("Só o pedido"), 2);
    const other = screen().getByRole("region", { name: "Peça para o outro app exportar" });
    expect((within(other).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);
    // Where each app puts its file is on the help page, one link under the request.
    expect(other.querySelector("dl")).toBeNull();
    const where = within(other).getByRole("link", { name: "Onde cada app entrega" });
    expect(where.getAttribute("href")).toBe("https://agentes.chat/pt/docs/import#other-apps");
    expect(where.className).toBe("ac-link ac-link--muted");

    await click(within(other).getByRole("button", { name: "Copiar o pedido" }), 2);
    expect(within(other).getByRole("status").textContent).toContain("Não deu para copiar.");
    copyWorks = true;
    await click(within(other).getByRole("button", { name: "Copiar o pedido" }), 2);
    expect(writes).toEqual([EXPORT_PROMPT]);
    expect(within(other).getByRole("button", { name: "Copiado" })).toBeTruthy();
    expect(within(other).getByRole("status").textContent).toBe("Agora é só colar no outro app.");

    await pasteReply(exportReply("claude", "Minhas automações"));
    expect(screen().getByRole("heading", { name: "Minhas automações" })).toBeTruthy();
    expect(text()).toContain("Veio do Claude");
    expect(document.querySelector(".imp-head .imp-mark img")).toBeNull();
    expect(screen().getByRole("checkbox", { name: "Trazer Newsy" }).getAttribute("aria-checked")).toBe("true");
    await click(button("Trocar arquivo"), 2);
    expect(button(/^Outro app/).getAttribute("aria-pressed")).toBe("true");
  });

  test("Grok Bot and ChatGPT dots: the same request in each app's own words, and a reply lands on its own card", async () => {
    await go();
    await click(button("Grok Bot"), 2);
    await click(radio("Só o pedido"), 2);
    const grok = screen().getByRole("region", { name: "Peça para o seu bot exportar" });
    expect([...grok.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Copie o pedido abaixo.",
      "Cole na conversa com o seu bot.",
      "Ele responde com o JSON: copie a resposta inteira e cole no campo de baixo.",
    ]);
    expect((within(grok).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);
    // Its steps say where: the help page's list is for any other app.
    expect(within(grok).queryByRole("link")).toBeNull();

    await click(button("ChatGPT dots"), 2);
    const dots = screen().getByRole("region", { name: "Peça para o seu dot exportar" });
    expect([...dots.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Copie o pedido abaixo.",
      "Cole num chat novo.",
      "Baixe o arquivo que ele criar e solte aqui.",
    ]);
    expect((within(dots).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);

    // A Grok Bot reply pasted with any card picked: from Grok Bot, by its logo, and its card picked after.
    await click(button(/^Outro app/), 2);
    await click(radio("Só o pedido"), 2);
    await pasteReply(exportReply("grok-bot", "Minhas automações"));
    expect(text()).toContain("Veio do Grok Bot");
    expect(document.querySelector(".imp-head .imp-mark img")?.getAttribute("src")).toBe("/brands/grok-bot.svg");
    await click(button("Trocar arquivo"), 2);
    expect(button("Grok Bot").getAttribute("aria-pressed")).toBe("true");

    // The file a dot makes, dropped.
    const file = new File([JSON.stringify(exportReply("chatgpt-dots", "Meu dot"))], "agentes-chat-export.json");
    await drop({ files: [file], items: [] });
    expect(text()).toContain("Veio do ChatGPT dots");
    expect(document.querySelector(".imp-head .imp-mark img")?.getAttribute("src")).toBe("/brands/chatgpt-dots.svg");
  });

  test("what went wrong says what to do next, with Tentar de novo only where trying again helps", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const fake = api.imports.apply;
    let fail: ApiError | null = null;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        const error = fail;
        fail = null;
        if (error) throw error;
        return fake(orgId, input);
      },
    };
    await go(state, api);
    const alert = () => screen().getByRole("alert").textContent ?? "";
    const retry = () => screen().queryByRole("button", { name: "Tentar de novo" });

    await pick("Arquivos para importar", [new File(["Lista de compras: café, pão."], "notas.txt")]);
    expect(alert()).toContain("Não reconhecemos esses arquivos");
    expect(retry()).toBeNull();

    const field = screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app");
    await act(async () => fireEvent.change(field, { target: { value: "https://gitlab.com/acme/agents" } }));
    await click(button("Ler"), 6);
    expect(alert()).toContain("só lê links do GitHub");
    expect(calls(state, "agents.importFromGithub")).toHaveLength(0);

    await act(async () => fireEvent.paste(field, { clipboardData: { getData: () => "oi, tudo bem?" } }));
    await settle(6);
    // No card named: Grok Bot, ChatGPT dots and Outro app each show the request.
    expect(alert()).toContain(
      "Não reconhecemos esse texto. Cole a resposta inteira do outro app, com o JSON, ou copie o pedido de novo e peça outra vez.",
    );

    fail = new ApiError(500, "internal", "boom");
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(alert()).toContain("Lemos os arquivos, mas não deu para comparar com o workspace.");
    await click(retry() as HTMLElement, 10);
    expect(screen().getByRole("heading", { name: "Sales desk" })).toBeTruthy();

    await click(button("Trocar arquivo"), 2);
    fail = new ApiError(413, "import.too_large", "The import is too large (max 32 MB)");
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(alert()).toContain("É coisa demais para uma importação só (até 32 MB).");
    expect(retry()).toBeNull();
  });

  test("Cancelar stops waiting for a slow plan, and its answer is dropped", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let answer: (plan: ImportPlan) => void = () => {};
    api.imports = { ...api.imports, apply: () => new Promise<ImportPlan>((resolve) => (answer = resolve)) };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
    await click(button("Cancelar"), 2);
    expect(document.activeElement?.textContent).toContain("Solte aqui a pasta, o arquivo ou o .zip");
    await act(async () => answer({ items: [{ kind: "agent", key: "lead", label: "Morgan", action: "create" }] }));
    await settle(4);
    expect(screen().queryByRole("heading", { name: "Sales desk" })).toBeNull();
  });

  test("a file dropped while another is being read is caught (never opened by the browser) and not read", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let asked = 0;
    api.imports = {
      ...api.imports,
      apply: () => {
        asked++;
        return new Promise<ImportPlan>(() => {});
      },
    };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
    const zone = document.querySelector(".imp-pick") as HTMLElement;
    const dataTransfer = {
      files: [fixture("sales-desk.openmaus.json")],
      items: [],
      types: ["Files"],
      dropEffect: "copy",
    };
    let over = true;
    let dropped = true;
    await act(async () => {
      over = fireEvent.dragOver(zone, { dataTransfer });
    });
    expect(text()).not.toContain("Pode soltar");
    await act(async () => {
      dropped = fireEvent.drop(zone, { dataTransfer });
    });
    await settle(6);
    // Default prevented: the browser doesn't navigate to the file.
    expect([over, dropped]).toEqual([false, false]);
    expect(asked).toBe(1);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
  });

  test("an apply that fails keeps what came, says so, and Importar again brings the rest", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const fake = api.imports.apply;
    let failures = 1;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        if (!input.dryRun && failures-- > 0) throw new TypeError("Failed to fetch");
        return fake(orgId, input);
      },
    };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    await click(button("Importar 11 itens"), 8);
    expect(screen().getByRole("alert").textContent).toContain("Sem internet");
    await click(button("Importar 11 itens"), 8);
    expect(screen().getByRole("heading", { name: "Chegou tudo" })).toBeTruthy();
    expect(text()).toContain("3 agentes");
    expect(text()).not.toContain("pausadas");
    // What to set up: one plain line each, with where it's done.
    const hubspot = within(screen().getByRole("list", { name: "Para configurar" }))
      .getAllByRole("listitem")
      .find((li) => li.textContent?.startsWith("Esta importação usa o HubSpot."));
    expect(
      within(hubspot as HTMLElement)
        .getByRole("link", { name: "Conectar" })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/settings/connectors`);
  });

  describe("an OpenBot.run export with the agents' own files", () => {
    const openbot = (name: string) => readFileSync(join(FIXTURES, "openbot-run", name), "utf8");
    /** As the OpenBot.run export comes: a .zip with its folder inside, made on a Mac. */
    const exported = () =>
      new File(
        [
          zip({
            "openbot-export/openbot-import.json": openbot("openbot-import.json"),
            "openbot-export/agents/scout/skills/price-watch/SKILL.md": openbot(
              "agents/scout/skills/price-watch/SKILL.md",
            ),
            "openbot-export/agents/scout/files/INSTRUCTIONS.md": openbot("agents/scout/files/INSTRUCTIONS.md"),
            "openbot-export/agents/scout/files/rivals.txt": "northwind.example\ncontoso.example\n",
            "openbot-export/agents/scout/files/notes/pricing.md": "# Pricing",
            "openbot-export/agents/scout/files/charts/q3.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
            "openbot-export/agents/scout/files/.env": "NORTHWIND_TOKEN=fixture-never-read",
            "openbot-export/agents/scout/files/.DS_Store": "junk",
            "__MACOSX/openbot-export/agents/scout/files/._rivals.txt": "junk",
          }).slice(),
        ],
        "openbot-export-2026-10-18.zip",
      );
    const copies = (state: State) =>
      calls(state, "imports.copyFile").map((c) => c.args[1] as Omit<ImportFileInput, "file">);
    const driveTitles = async (api: ApiClient) =>
      (await api.artifacts.list(ORG_ID, { q: "Scout/" })).map((a) => a.title).sort();
    const importIt = async () => {
      const go = screen()
        .getAllByRole("button")
        .find((b) => /^Importar \d+ itens$/.test(b.textContent ?? ""));
      if (!go) throw new Error("no Importar");
      await click(go, 30);
    };

    test("the preview says how many and how big, copying on; Importar puts them in the agent's folder, says what stayed behind, and the agent knows where they are", async () => {
      const { state, api } = await go();
      await pick("Arquivos para importar", [exported()]);
      const files = screen().getByRole("region", { name: "Copiar os arquivos para o Drive" });
      expect(
        within(files).getByRole("switch", { name: "Copiar os arquivos para o Drive" }).getAttribute("aria-checked"),
      ).toBe("true");
      expect(files.textContent).toContain("Drive\u00a0›\u00a0Scout");
      expect(files.textContent).toContain("3 arquivos · 51 bytes");
      // What stays behind: system files here; keys aren't even listed.
      expect(files.textContent).toContain("Arquivos do sistema");
      expect(files.textContent).toContain(".DS_Store, ._rivals.txt");
      expect(text()).not.toContain("agents/scout/files/.env");
      expect(copies(state)).toEqual([]);

      await importIt();
      const scout = state.agents.find((a) => a.name === "Scout");
      if (!scout) throw new Error("Scout didn't come");
      expect(copies(state)).toEqual([
        { agentId: scout.id, path: "rivals.txt", name: "rivals.txt", note: "Trazido do OpenBot.run" },
        { agentId: scout.id, path: "notes/pricing.md", name: "pricing.md", note: "Trazido do OpenBot.run" },
        { agentId: scout.id, path: "charts/q3.png", name: "q3.png", note: "Trazido do OpenBot.run" },
      ]);
      expect(await driveTitles(api)).toEqual(["Scout/charts/q3.png", "Scout/notes/pricing.md", "Scout/rivals.txt"]);
      const report = screen().getByRole("region", { name: "Chegou tudo" });
      expect(report.textContent).toContain("3 arquivos no Drive");
      expect(within(report).getByRole("link", { name: "Drive › Scout" }).getAttribute("href")).toBe(
        `/org/${ORG_ID}/agents/${scout.id}?tab=files`,
      );
      const left = screen().getByRole("region", { name: "Arquivos que ficaram de fora" });
      expect(left.textContent).toContain("Chaves e logins nunca vão para o Drive.env");
      expect(left.textContent).toContain("Arquivos do sistema.DS_Store, ._rivals.txt");
      expect(text()).toContain("3 arquivos copiados para o Drive.");
      // One line in Scout's memory says where its files are.
      const pointer = applies(state).find((i) => i.pick?.[0] === "note:scout/drive-files");
      expect(pointer?.pick).toEqual(["note:scout/drive-files"]);
      expect(pointer?.bundle.notes).toEqual([
        {
          key: "scout/drive-files",
          agent: "scout",
          kind: "fact",
          content: "Seus arquivos do OpenBot.run estão em Drive\u00a0›\u00a0Scout.",
        },
      ]);

      // The same export again: what the folder has stays as it was.
      await click(button("Importar outro arquivo"), 2);
      await pick("Arquivos para importar", [exported()]);
      await importIt();
      expect(copies(state)).toHaveLength(6);
      expect(await driveTitles(api)).toEqual(["Scout/charts/q3.png", "Scout/notes/pricing.md", "Scout/rivals.txt"]);
      expect(screen().getByRole("region", { name: "Chegou tudo" }).textContent).toContain(
        "Nenhum arquivo novo no Drive",
      );
      expect(screen().getByRole("region", { name: "Arquivos que ficaram de fora" }).textContent).toContain(
        "Já estavam no Driverivals.txt, notes/pricing.md, charts/q3.png",
      );
    });

    test("past 500 files, copying starts off and says why", async () => {
      const { state } = await go();
      const files: Record<string, string> = {
        "openbot-export/openbot-import.json": openbot("openbot-import.json"),
      };
      for (let i = 0; i < 501; i++) files[`openbot-export/agents/scout/files/data/${i}.csv`] = `${i}`;
      await pick("Arquivos para importar", [new File([zip(files).slice()], "openbot-export.zip")]);
      const group = screen().getByRole("region", { name: "Copiar os arquivos para o Drive" });
      expect(
        within(group).getByRole("switch", { name: "Copiar os arquivos para o Drive" }).getAttribute("aria-checked"),
      ).toBe("false");
      expect(group.textContent).toContain("São 501 arquivos, então a cópia começa desligada.");
      await importIt();
      expect(copies(state)).toEqual([]);
    });

    test("turned off, nothing is copied", async () => {
      const { state, api } = await go();
      await pick("Arquivos para importar", [exported()]);
      await click(screen().getByRole("switch", { name: "Copiar os arquivos para o Drive" }), 2);
      expect(
        screen().getByRole("switch", { name: "Copiar os arquivos para o Drive" }).getAttribute("aria-checked"),
      ).toBe("false");
      await importIt();
      expect(screen().getByRole("heading", { name: "Chegou tudo" })).toBeTruthy();
      expect(copies(state)).toEqual([]);
      expect(await driveTitles(api)).toEqual([]);
      expect(text()).not.toContain("arquivos no Drive");
      expect(text()).not.toContain("Copiando os arquivos");
      expect(applies(state).some((i) => i.pick?.[0] === "note:scout/drive-files")).toBe(false);
    });
  });
});
