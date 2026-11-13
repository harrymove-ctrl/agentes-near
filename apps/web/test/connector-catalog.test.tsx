import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type AccessInput, type ConnectorDef, keys } from "@agenteschat/client";
import { connectedSummary } from "@agenteschat/client/lib/connected";
import { icons } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { authKind, searchCatalog } from "@/components/ConnectorCatalog";
import { createI18n } from "@/i18n";
import { setNavigateAway } from "@/lib/navigate";
import { pick, rowMenu, service } from "./catalog";
import { ADA_ID, ATLAS_ID, CATALOG, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const open = async (state = seedState({ connections: [] }), api = createFakeApi(state)) => {
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  return { state, dialog: screen().getByRole("dialog", { name: "Adicionar conector" }) };
};
/** The names of the tiles in the grid (the suggestions on top aren't tiles). */
const names = (dialog: HTMLElement) => [...dialog.querySelectorAll(".catalog-tile__name")].map((el) => el.textContent);
/** The category choices' words (without their counts). */
const filterNames = (cats: HTMLElement) =>
  within(cats)
    .getAllByRole("radio")
    .map((b) => b.firstChild?.textContent);
const pressEsc = (el: Element) => act(async () => fireEvent.keyDown(el, { key: "Escape" }));
/** Whether an icon is drawn as `name` (its shape's first path). */
const drawnAs = (svg: Element | null | undefined, name: keyof typeof icons) =>
  svg?.querySelector("path")?.getAttribute("d") === icons[name].find(([tag]) => tag === "path")?.[1].d;
/** A level's radio in the radiogroup named `group`. */
const levelIn = (inside: HTMLElement, group: string, level: string) =>
  within(within(inside).getByRole("radiogroup", { name: group })).getByRole("radio", { name: level });
/** The level checked in each radiogroup named in `groups` (null when none is). */
const levels = (inside: HTMLElement, groups: string[]) =>
  groups.map(
    (group) =>
      within(within(inside).getByRole("radiogroup", { name: group }))
        .queryAllByRole("radio")
        .find((r) => r.getAttribute("aria-checked") === "true")?.textContent ?? null,
  );
/** A backend whose catalog also lists Asana as the server does today: its vendor hasn't approved agentes.chat yet. */
const withSoonAsana = (state: FakeState) => {
  const api = createFakeApi(state);
  const asana: ConnectorDef = {
    ...(CATALOG.connectors.find((d) => d.id === "linear") as ConnectorDef),
    id: "asana",
    label: "Asana",
    description: "Asana tasks, projects and teams.",
    serverUrl: "https://mcp.asana.com/mcp",
    iconUrl: "/connectors/asana.svg",
    brandColor: "#F06A6A",
    available: false,
    soon: true,
  };
  api.connectors.catalog = async () => ({ ...CATALOG, connectors: [asana, ...CATALOG.connectors] });
  return api;
};
/** As the server leaves a first connection: every agent's, whole. */
const everyAgent = (api: ReturnType<typeof createFakeApi>, connectionId: string) =>
  (api.access as typeof api.access & { connected: (id: string, agents: string[]) => void }).connected(connectionId, [
    ADA_ID,
    ATLAS_ID,
  ]);

describe("Adicionar conector: one catalog", () => {
  test("even tiles with no tags; suggestions on top; categories with counts and search", async () => {
    const { dialog } = await open();
    // Suggested first (not connected yet, in a fixed order); they leave the grid below.
    const suggested = within(dialog).getByRole("region", { name: "Sugeridos para a Acme" });
    expect(
      within(suggested)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["GitHub", "Banco de dados", "Linear"]);
    const notion = within(dialog).getByRole("button", { name: "Notion" });
    expect(notion.textContent).toContain("Páginas e bancos de dados.");
    // No tags on a card: no category, no "Um clique".
    expect(notion.querySelectorAll(".ac-chip")).toHaveLength(0);
    expect(notion.textContent).not.toContain("Um clique");
    expect(notion.textContent).not.toContain("Docs");
    // The brand icon is a mask of our own file; Notion takes the ink, Linear its color.
    expect(notion.querySelector(".connector-icon__mark")?.getAttribute("style")).toContain("/connectors/notion.svg");
    const linear = within(dialog).getByRole("button", { name: "Linear" });
    expect(linear.querySelector(".connector-icon__mark")?.getAttribute("style")?.toLowerCase()).toContain("#5e6ad2");
    // Canva's mark keeps its colors: drawn as it is, not as a mask. No icon (Slack here): a monogram.
    expect(within(dialog).getByRole("button", { name: "Canva" }).querySelector("img")?.getAttribute("src")).toBe(
      "/brands/canva.svg",
    );
    expect(
      within(dialog).getByRole("button", { name: "Slack" }).querySelector(".connector-icon--mono")?.textContent,
    ).toBe("S");
    // Not configured on this server: last before "Não achou?", and its service can't connect.
    expect(names(dialog).slice(-2)).toEqual(["Slack", "Não achou?"]);
    await click(within(dialog).getByRole("button", { name: "Slack" }));
    const slack = service("Slack");
    expect(within(slack).getByRole("button", { name: "Em breve" }).hasAttribute("disabled")).toBe(true);
    expect(`${dialog.textContent} ${slack.textContent}`).not.toMatch(/MCP/);
    await click(within(slack).getByRole("button", { name: "Fechar detalhe" }));

    // "Todos" and "Conectados", then the categories by name: in the list beside the grid, and in the phone's row.
    const order = [
      "Todos",
      "Conectados",
      "Automação",
      "Desenvolvimento",
      "Docs",
      "Marketing",
      "Pagamentos",
      "Produto",
      "Suporte",
    ];
    const cats = within(dialog).getByRole("radiogroup", { name: "Categorias" });
    expect(filterNames(cats)).toEqual(order);
    const list = within(dialog).getByRole("navigation", { name: "Categorias" });
    expect([...list.querySelectorAll(".catalog__cat-name")].map((el) => el.textContent)).toEqual(order);
    await click(within(cats).getByRole("radio", { name: /^Docs/ }));
    expect(names(dialog)).toEqual(["Google Drive", "Notion", "Não achou?"]);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar conector" }), "notion");
    expect(names(dialog)).toEqual(["Notion", "Não achou?"]);
  });

  test("social networks: a category of their own, each tile in its brand's mark and color", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const whatsapp: ConnectorDef = {
      ...(CATALOG.connectors.find((d) => d.id === "drive") as ConnectorDef),
      id: "whatsapp",
      label: "WhatsApp",
      category: "social",
      description: "WhatsApp Business messages and templates.",
      serverUrl: "https://backend.composio.dev/api/v3.1/toolkits/whatsapp",
      iconUrl: "/connectors/whatsapp.svg",
      brandColor: "#25D366",
    };
    api.connectors.catalog = async () => ({ ...CATALOG, connectors: [...CATALOG.connectors, whatsapp] });
    const { dialog } = await open(state, api);
    const cats = within(dialog).getByRole("radiogroup", { name: "Categorias" });
    expect(filterNames(cats).slice(-2)).toEqual(["Redes sociais", "Suporte"]);
    await click(within(cats).getByRole("radio", { name: /^Redes sociais/ }));
    expect(names(dialog)).toEqual(["WhatsApp", "Não achou?"]);
    const tile = within(dialog).getByRole("button", { name: "WhatsApp" });
    expect(tile.textContent).toContain("Mensagens e modelos do WhatsApp Business.");
    const mark = tile.querySelector(".connector-icon__mark")?.getAttribute("style")?.toLowerCase();
    expect([mark?.includes("/connectors/whatsapp.svg"), mark?.includes("#25d366")]).toEqual([true, true]);
  });

  test("nothing found: one of our agents searching, with the way in by address", async () => {
    const { dialog } = await open();
    const search = within(dialog).getByRole("searchbox", { name: "Buscar conector" });
    const empty = () => dialog.querySelector<HTMLElement>(".catalog__empty");
    await type(search, " zzz ");
    // No grid behind it, not even "Não achou?": the empty state carries the way in.
    expect(names(dialog)).toEqual([]);
    const box = empty() as HTMLElement;
    expect(box.querySelector(".ac-empty__art[aria-hidden='true'] canvas.ac-searchpx")).not.toBeNull();
    expect(box.querySelector(".ac-empty__title")?.textContent).toBe("Nenhum conector com “zzz”");
    expect(box.querySelector(".ac-empty__text")?.textContent).toBe(
      "Você pode conectar qualquer serviço pelo endereço dele.",
    );
    // Its button opens what "Não achou?" opens.
    const byAddress = within(box).getByRole("button", { name: "Conectar pelo endereço" });
    expect(byAddress.getAttribute("aria-haspopup")).toBe("dialog");
    await click(byAddress);
    expect(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" })).toBeTruthy();
    await pressEsc(service("Outro serviço"));

    // A category with nothing in it: the same, in its own words.
    await type(search, "");
    expect(empty()).toBeNull();
    const cats = within(dialog).getByRole("radiogroup", { name: "Categorias" });
    await click(within(cats).getByRole("radio", { name: /^Conectados/ }));
    expect(names(dialog)).toEqual([]);
    expect(empty()?.querySelector(".ac-empty__title")?.textContent).toBe("Nenhum conector nesta categoria ainda");
    expect(within(empty() as HTMLElement).getByRole("button", { name: "Conectar pelo endereço" })).toBeTruthy();
  });

  test("a vendor that hasn't approved agentes.chat yet: greyed, a lock and 'Em breve', last, and its tile opens nothing", async () => {
    const state = seedState({ connections: [] });
    const { dialog } = await open(state, withSoonAsana(state));
    const tile = within(dialog).getByRole("button", { name: "Asana, em breve" }) as HTMLButtonElement;
    expect([tile.hasAttribute("data-soon"), tile.disabled, tile.hasAttribute("aria-haspopup")]).toEqual([
      true,
      true,
      false,
    ]);
    const chip = tile.querySelector(".ac-chip");
    expect(chip?.textContent).toBe("Em breve");
    expect(drawnAs(chip?.querySelector("svg"), "lock")).toBe(true);
    // In place of the description: the name keeps its whole row.
    expect(tile.querySelector(".catalog-tile__head")?.textContent).toBe("Asana");
    expect(tile.textContent).not.toContain("Tarefas, projetos e times.");
    // With what can't connect here, last before "Não achou?".
    expect(names(dialog).slice(-3)).toEqual(["Asana", "Slack", "Não achou?"]);
    await click(tile);
    expect(screen().queryByRole("dialog", { name: "Asana" })).toBeNull();
    expect(screen().getAllByRole("dialog")).toEqual([dialog]);
    const starts = ["customConnectors.connect", "connectors.startOAuth", "connectors.connectWithKey"];
    expect(state.calls.filter((c) => starts.includes(c.method))).toEqual([]);
  });

  test("a 'soon' one connected by its address (with a key) is a connection like any other: a check, no lock, it opens", async () => {
    const state = seedState({ connections: [] });
    const api = withSoonAsana(state);
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://mcp.asana.com/mcp",
      label: "Asana",
      apiKey: "asana_key_123456",
      returnTo: "/",
    });
    const { dialog } = await open(state, api);
    const tile = within(dialog).getByRole("button", { name: "Asana, conectado" }) as HTMLButtonElement;
    expect([tile.disabled, tile.hasAttribute("data-soon"), Boolean(tile.querySelector(".ac-chip"))]).toEqual([
      false,
      false,
      false,
    ]);
    expect(tile.querySelector(".catalog-icon__check")).toBeTruthy();
    expect(names(dialog).slice(-2)).toEqual(["Slack", "Não achou?"]);
    await click(tile);
    expect(
      within(service("Asana")).getByRole("button", { name: "Adicionar outra conta do Asana" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  test("a tile opens its service over the catalog: what agents could do, what asks, how it connects; Esc closes the service first", async () => {
    const { dialog } = await open();
    const tile = within(dialog).getByRole("button", { name: "Notion" });
    // It opens a dialog, it isn't a toggle.
    expect([tile.getAttribute("aria-haspopup"), tile.hasAttribute("aria-pressed")]).toEqual(["dialog", false]);
    await click(tile);
    const notion = service("Notion");
    expect(notion.textContent).toContain("O que os agentes poderão fazer");
    expect(notion.textContent).toContain("Buscar e ler páginas");
    expect(notion.textContent).toContain("Um clique: você autoriza na página do serviço");
    // What connecting changes, as one line under what it can do (no heading of its own).
    expect(notion.textContent).toContain("Ao conectar, todos os agentes podem usar. Dá para ajustar depois.");
    expect(within(notion).queryByRole("heading", { level: 4, name: "Depois de conectar" })).toBeNull();
    // × goes back to the catalog; another tile opens its own.
    await click(within(notion).getByRole("button", { name: "Fechar detalhe" }));
    expect(screen().queryByRole("dialog", { name: "Notion" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "GitHub" }));
    const github = service("GitHub");
    // What always asks for approval is marked.
    const asks = github.querySelector("[data-asks]");
    expect(asks?.textContent).toBe("Merge e deploy sempre pedem sua aprovação");
    expect(github.textContent).toContain("Você autoriza na página do serviço, ou usa uma chave de API");
    // Esc: the service closes, the catalog stays; again: the catalog closes.
    await pressEsc(github);
    expect(screen().queryByRole("dialog", { name: "GitHub" })).toBeNull();
    expect(screen().getByRole("dialog", { name: "Adicionar conector" })).toBe(dialog);
    await pressEsc(dialog);
    expect(screen().queryByRole("dialog", { name: "Adicionar conector" })).toBeNull();
  });

  test("from the keyboard: focus lands in the service; Esc closes only it, back on its tile, the catalog as it was", async () => {
    const { dialog } = await open();
    const search = within(dialog).getByRole("searchbox", { name: "Buscar conector" }) as HTMLInputElement;
    const docs = within(within(dialog).getByRole("radiogroup", { name: "Categorias" })).getByRole("radio", {
      name: /^Docs/,
    });
    await click(docs);
    await type(search, "notion");
    const list = within(dialog).getByRole("region", { name: "Conectores disponíveis" });
    list.scrollTop = 48;
    const tile = within(dialog).getByRole("button", { name: "Notion" });
    // Enter on a tile presses it with the focus on it.
    tile.focus();
    await click(tile);
    expect(service("Notion").contains(document.activeElement)).toBe(true);
    await pressEsc(document.activeElement as Element);
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Notion" })).toBeNull();
    expect(document.activeElement === tile).toBe(true);
    expect([search.value, docs.getAttribute("aria-checked"), list.scrollTop]).toEqual(["notion", "true", 48]);
    expect(names(dialog)).toEqual(["Notion", "Não achou?"]);
  });

  test("the service's Conectar starts its flow; 'Não achou?' connects by address", async () => {
    const { dialog } = await open();
    await pick(dialog, "Notion");
    expect(screen().getByRole("dialog", { name: "Conectar Notion" })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Notion" })).toBeNull();
    expect(screen().queryByRole("dialog", { name: "Adicionar conector" })).toBeNull();
  });

  test("what's connected has a check; then an MCP server adds an account, a catalog connector signs in again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.zapier.example/mcp/",
      label: "Zapier",
      returnTo: "/",
    });
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    const dialog = screen().getByRole("dialog", { name: "Adicionar conector" });
    const github = within(dialog).getByRole("button", { name: "GitHub, conectado" });
    expect(github.querySelector(".catalog-icon__check")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Zapier, conectado" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Notion" }).querySelector(".catalog-icon__check")).toBeNull();
    await click(github);
    const detail = service("GitHub");
    expect(detail.querySelector(".catalog-icon__check")).toBeTruthy();
    expect(detail.textContent).toContain("Já conectado");
    // A catalog connector has one account: connected, it signs in again.
    expect(within(detail).getByRole("button", { name: "Reconectar GitHub" }).textContent).toBe("Reconectar");
    await pressEsc(detail);
    // A server by address takes another account (a preset counts by its address).
    await click(within(dialog).getByRole("button", { name: "Zapier, conectado" }));
    expect(within(service("Zapier")).getByRole("button", { name: "Adicionar outra conta do Zapier" }).textContent).toBe(
      "Adicionar outra conta",
    );
    await pressEsc(service("Zapier"));
    await click(
      within(dialog).getByRole("radiogroup", { name: "Categorias" }).querySelectorAll("[role=radio]")[1] as Element,
    );
    expect(names(dialog)).toEqual(["GitHub", "Zapier", "Não achou?"]);
  });

  test("what connecting does to who uses it: a new service is everyone's, a new sign-in keeps who uses it, another account is everyone's too", async () => {
    const api = createFakeApi(seedState());
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.zapier.example/mcp/",
      label: "Zapier",
      returnTo: "/",
    });
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const catalog = async () => {
      await click(screen().getByRole("button", { name: "Adicionar conector" }));
      return screen().getByRole("dialog", { name: "Adicionar conector" });
    };
    let dialog = await catalog();
    const detail = async (tile: string, name: string) => {
      await click(within(dialog).getByRole("button", { name: tile }));
      const text = service(name).textContent;
      await pressEsc(service(name));
      return text;
    };
    const everyone = "Ao conectar, todos os agentes podem usar. Dá para ajustar depois.";
    expect(await detail("Notion", "Notion")).toContain(everyone);
    expect(await detail("GitHub, conectado", "GitHub")).toContain("Substitui o login atual. Quem usa continua igual.");
    expect(await detail("Zapier, conectado", "Zapier")).toContain("Cada conta tem quem usa e níveis próprios.");
    const database = await detail("Banco de dados", "Banco de dados");
    expect(database).toContain("Nenhum agente usa até você escolher.");
    expect(database).not.toContain(everyone);

    // A new sign-in for the catalog connector: step 1 says who uses it stays.
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await click(within(dialog).getByRole("button", { name: "GitHub, conectado" }));
    await click(within(service("GitHub")).getByRole("button", { name: "Reconectar GitHub" }));
    expect(screen().getByRole("dialog", { name: "Reconectar GitHub" })).toBe(flow());
    expect(flow().textContent).toContain("Substitui o login atual. Quem usa continua igual.");
    expect(flow().textContent).not.toContain("todos os agentes podem usar");
    await click(within(flow()).getByRole("button", { name: "Cancelar" }));

    // By address: the note follows the address typed (a server already connected takes another account).
    dialog = await catalog();
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
    expect(flow().textContent).toContain("Ao conectar, todos os agentes podem usar. Dá para ajustar depois.");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.zapier.example/mcp");
    // No account here was named by its provider, so step 1 can't tell accounts apart and asks for one not yet here.
    expect(flow().textContent).toContain(
      "Entre numa conta que ainda não está conectada, a gente não consegue conferir.",
    );
    expect(flow().textContent).not.toContain("sem agentes");
  });

  test("rules: how it connects, search", () => {
    const byId = (id: string) => CATALOG.connectors.find((d) => d.id === id);
    const kind = (id: string) => {
      const d = byId(id);
      return d ? authKind(d) : null;
    };
    expect([kind("linear"), kind("github"), kind("sentry")]).toEqual(["oneClick", "oauthOrKey", "key"]);
    expect(searchCatalog(CATALOG.connectors, "ciclos").map((d) => d.id)).toEqual(["linear"]);
  });

  test("the close sits on its big title's capitals' middle; a service's, in the corner, isn't lifted", async () => {
    const css = (await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const rule = (selector: string, from = css) => from.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".catalog .ac-dialog__head")).toContain("--title-cap-mid: 0.88px;");
    const phone = css.split("\n@media (max-width: 760px) {\n  .catalog__body {")[1] ?? "";
    expect(rule("  .catalog .ac-dialog__head", phone)).toContain("--title-cap-mid: 0.51px;");
    expect(rule(".catalog-svc .ac-dialog__close")).toContain("translate: none");
  });
});

const REVIEW = "Revise o que o agente pode fazer sozinho";
const WAITING = "Os agentes só recebem as ferramentas quando você continuar, nos níveis que sugerimos.";
/** "Ajustar" on the confirmation: on to the detail. */
const adjust = async () => {
  await click(within(screen().getAllByRole("dialog").at(-1) as HTMLElement).getByRole("button", { name: "Ajustar" }));
  await settle(4);
};

describe("the connect flow: conectar → conectado; Ajustar → o que faz → quem pode usar", () => {
  test("a one-click server that asks for a key; tools reviewed by subject; a level per agent", async () => {
    const { state, dialog } = await open();
    await pick(dialog, "Linear");
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(flow().textContent).toContain("Conectar Linear");
    const steps = within(flow()).getByRole("list", { name: "Passos" });
    expect(within(steps).getAllByRole("listitem")[0]?.getAttribute("aria-current")).toBe("step");
    expect(flow().textContent).toContain("Ao conectar, todos os agentes podem usar. Dá para ajustar depois.");

    await click(within(flow()).getByRole("button", { name: "Continuar no Linear" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
      serverUrl: "https://mcp.linear.app/mcp",
      label: "Linear",
      returnTo: `/org/${ORG_ID}/settings/connectors`,
    });
    // This server wants a key: the key form opens.
    expect(flow().textContent).toContain("Este servidor não aceita OAuth. Conecte com uma chave de API.");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    expect(flow().textContent).toContain("Cole a chave de API (pelo menos 8 caracteres).");
    await type(within(flow()).getByLabelText("Chave de API"), "lin_api_123456");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);

    // The confirmation: no steps, one sentence. No one gave this server's tools a level yet, and it says so.
    expect(screen().getByRole("dialog", { name: "Linear conectado" })).toBe(flow());
    expect(within(flow()).queryByRole("list", { name: "Passos" })).toBeNull();
    expect(flow().querySelector(".cflow__text")?.textContent).toBe(`${WAITING} 1 ação pede aprovação no chat.`);
    expect(document.body.textContent).not.toContain("Linear conectado.");
    await adjust();

    // Ajustar, step 2: everything comes classified; only the ambiguous tool waits for a decision.
    expect(screen().getByRole("dialog", { name: REVIEW })).toBeTruthy();
    expect(flow().textContent).toContain("Classificamos as 5 ferramentas do Linear.");
    const decide = within(flow()).getByRole("region", { name: "Precisam da sua decisão · 1" });
    expect(decide.textContent).toContain("Fechar chamado");
    expect(decide.textContent).toContain("Sugestão: muda coisas (não apaga nada nem gasta dinheiro)");
    expect(flow().textContent).toContain("Falta 1 decisão. Se continuar, vale a sugestão.");
    expect(within(flow()).queryByRole("region", { name: "Pronto. Tudo revisado." })).toBeNull();
    await click(within(decide).getByRole("button", { name: "Aceitar as sugestões" }));
    expect(within(flow()).queryByRole("region", { name: /Precisam da sua decisão/ })).toBeNull();
    const done = within(flow()).getByRole("region", { name: "Pronto. Tudo revisado." });
    expect(done.textContent).toContain("2 só consultam");
    expect(done.textContent).toContain("1 pede sua aprovação");
    expect(flow().textContent).toContain("Dá para mudar tudo isso depois.");

    // Sensitive: only "Aprovação" or "Desligada".
    await click(within(flow()).getByRole("button", { name: /^Clientes/ }));
    const del = within(flow()).getByRole("radiogroup", { name: "Nível de Apagar cliente" });
    expect(
      within(del)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Aprovação", "Desligada"]);
    await click(within(del).getByRole("radio", { name: "Desligada" }));
    await click(within(flow()).getByRole("button", { name: /^Chamados/ }));
    const create = within(flow()).getByRole("radiogroup", { name: "Nível de Criar chamado" });
    expect(
      within(create)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Consulta", "Muda", "Aprovação", "Desligada"]);
    await click(within(create).getByRole("radio", { name: "Aprovação" }));
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    const saved = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[2] as {
      tools: { name: string; access: string; confirmed: boolean }[];
    };
    expect(Object.fromEntries(saved.tools.map((x) => [x.name, x.access]))).toEqual({
      list_tickets: "read",
      get_ticket: "read",
      create_ticket: "approval",
      close_ticket: "write",
      delete_customer: "off",
    });
    expect(saved.tools.every((x) => x.confirmed)).toBe(true);

    // Step 3: everyone starts at "Ler e escrever" (the server gave it to every agent); then a level each.
    expect(screen().getByRole("dialog", { name: "Quem pode usar Linear" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de todos os agentes", "Ler"));
    await click(levelIn(flow(), "Nível de Ada", "Sem acesso"));
    expect(flow().textContent).toContain("1 ação sempre pede aprovação no chat.");
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const serverId = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[1] as string;
    const put = (agentId: string) =>
      state.calls.find((c) => c.method === "access.set" && c.args[1] === agentId)?.args[2] as AccessInput;
    // "Sem acesso": nothing of the server is left.
    expect(put(ADA_ID).connectors[serverId]).toBeUndefined();
    expect(put(ADA_ID).scopes.some((s) => s.connectionId === serverId)).toBe(false);
    // "Ler": its read scope, nothing else; the agent's other grants stay.
    expect(put(ATLAS_ID).connectors[serverId]).toBeUndefined();
    expect(put(ATLAS_ID).scopes).toContainEqual({ connectionId: serverId, scope: `custom:${serverId}:read` });
    expect(put(ATLAS_ID).scopes).toContainEqual({ connectionId: null, scope: "memory:write" });

    // The row: state, account, tools, who uses it.
    expect(screen().queryByRole("dialog")).toBeNull();
    const section = screen().getByRole("region", { name: "Conectores" });
    expect(section.textContent).toContain("Linear");
    expect(section.textContent).toContain("Ativo");
    expect(section.textContent).toContain("Conectado como mcp.linear.app");
    expect(section.textContent).toContain("4 ferramentas");
    expect(section.textContent).toContain("1 de 2 agentes");
  });

  test("a server whose OAuth only lets in apps it approved says so, with its own words, not 'no OAuth', and the key stays the way in", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const connect = api.customConnectors.connect;
    api.customConnectors.connect = async (orgId, input) =>
      input.apiKey
        ? connect(orgId, input)
        : { status: "needs_key", reason: "not_approved", detail: "invalid_redirect_uri: redirect_uri not allowed" };
    const { dialog } = await open(state, api);
    await pick(dialog, "Linear");
    const flow = screen().getByRole("dialog", { name: "Conectar Linear" });
    await click(within(flow).getByRole("button", { name: "Continuar no Linear" }));
    await settle(4);
    expect(flow.textContent).toContain(
      "Linear só deixa entrar apps que aprovou, e o agentes.chat ainda não foi aprovado. Se ele te der uma chave de API, dá para conectar com ela.",
    );
    // Under our words, the server's: which one refused and why.
    expect(flow.querySelector(".cflow__said")?.textContent).toBe(
      "O servidor respondeu: invalid_redirect_uri: redirect_uri not allowed",
    );
    expect(flow.textContent).not.toContain("não aceita OAuth");
    expect(flow.querySelector("details.cflow__more")?.hasAttribute("open")).toBe(true);
    await type(within(flow).getByLabelText("Chave de API"), "lin_api_123456");
    await click(within(flow).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Linear conectado" })).toBeTruthy();
  });

  test("a one-click server the catalog lists without a key (Intercom on the Cloud) offers no API key", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const intercom: ConnectorDef = {
      ...(CATALOG.connectors.find((d) => d.id === "linear") as ConnectorDef),
      id: "intercom",
      label: "Intercom",
      category: "support",
      description: "Intercom conversations and contacts.",
      serverUrl: "https://mcp.intercom.com/mcp",
      iconUrl: "/connectors/intercom.svg",
      brandColor: null,
      auth: ["oauth"],
    };
    api.connectors.catalog = async () => ({ ...CATALOG, connectors: [intercom, ...CATALOG.connectors] });
    const { dialog } = await open(state, api);
    await pick(dialog, "Intercom");
    const flow = screen().getByRole("dialog", { name: "Conectar Intercom" });
    expect(within(flow).getByRole("button", { name: "Continuar no Intercom" })).toBeTruthy();
    expect(flow.textContent).not.toContain("Conectar com uma chave de API");
    expect(within(flow).queryByLabelText("Chave de API")).toBeNull();
  });

  test("'Todos os agentes' is a row like an agent's, on top and raised: it sets every agent, and shows none when they differ", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(state) });
    await settle(8);
    await click(screen().getByRole("button", { name: "Quem usa GitHub" }));
    await settle(4);
    const flow = screen().getByRole("dialog", { name: "Quem pode usar GitHub" });
    const everyone = "Nível de todos os agentes";
    const groups = [everyone, "Nível de Ada", "Nível de Atlas"];
    // Connected before, and nobody uses it yet.
    expect(levels(flow, groups)).toEqual(["Sem acesso", "Sem acesso", "Sem acesso"]);
    const all = within(flow).getByRole("radiogroup", { name: everyone }).closest(".cflow-agent") as HTMLElement;
    expect(all.classList.contains("cflow-agent--all")).toBe(true);
    expect(all.textContent).toContain("Todos os agentes");
    expect(all.textContent).toContain("2 agentes");
    const ada = within(flow).getByRole("radiogroup", { name: "Nível de Ada" });
    expect(all.compareDocumentPosition(ada) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(all.contains(ada)).toBe(false);

    await click(levelIn(flow, everyone, "Ler e escrever"));
    expect(levels(flow, groups)).toEqual(["Ler e escrever", "Ler e escrever", "Ler e escrever"]);
    await click(levelIn(flow, "Nível de Atlas", "Ler"));
    expect(levels(flow, groups)).toEqual([null, "Ler e escrever", "Ler"]);
    await click(within(flow).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const put = (agentId: string) =>
      state.calls.find((c) => c.method === "access.set" && c.args[1] === agentId)?.args[2] as AccessInput;
    // "Ler e escrever": the whole connection (sensitive tools still ask).
    expect(put(ADA_ID).connectors["conn-gh"]).toBe(true);
    expect(put(ATLAS_ID).connectors["conn-gh"]).toBeUndefined();
    expect(put(ATLAS_ID).scopes.filter((g) => g.connectionId === "conn-gh")).toEqual([
      { connectionId: "conn-gh", scope: "github:repo.read" },
    ]);
  });

  test("a new connection: every agent at 'Ler e escrever', read fresh after connecting, so Liberar only confirms", async () => {
    // GitHub is connected: the page already read every agent's access, from before the new server.
    const { state, dialog } = await open(seedState());
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), "Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await adjust();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Quem pode usar Suporte" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    // Sensitive actions still ask, and the dialog says so.
    expect(flow().textContent).toContain("1 ação sempre pede aprovação no chat.");
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    expect(state.calls.filter((c) => c.method === "access.set")).toEqual([]);
    expect(document.body.textContent).toContain("Suporte: 2 agentes podem usar.");
  });

  test("ours with an OAuth app: 'Continuar no GitHub' leaves for GitHub and comes back to Conectores", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { state, dialog } = await open();
    await pick(dialog, "GitHub");
    const flow = screen().getByRole("dialog", { name: "Conectar GitHub" });
    // A key is the other way in, folded away.
    expect(within(flow).getByText("Conectar com uma chave de API")).toBeTruthy();
    await click(within(flow).getByRole("button", { name: "Continuar no GitHub" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")?.args).toEqual([
      ORG_ID,
      "github",
      { returnTo: `/org/${ORG_ID}/settings/connectors`, serverUrl: undefined },
    ]);
    expect(left[0]).toStartWith("https://github.com/login/oauth/authorize");
  });

  test("ours by API key, from the catalog's Conectar: what it does, then who can use it, every agent as the server left it", async () => {
    const { state, dialog } = await open();
    await pick(dialog, "GitHub");
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_abcdef123456");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de todos os agentes", "Ler"));
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const id = state.connections.find((c) => c.connector === "github")?.id ?? "";
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID]);
    for (const put of puts) {
      const input = put.args[2] as AccessInput;
      expect(input.connectors[id]).toBeUndefined();
      expect(input.scopes.filter((s) => s.connectionId === id)).toEqual([
        { connectionId: id, scope: "github:repo.read" },
      ]);
    }
  });

  test("the connection being made never reads as replacing one, though the list has it before the key is answered", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const send = api.connectors.connectWithKey;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    api.connectors.connectWithKey = async (...args) => {
      const made = await send(...args);
      await answered;
      return made;
    };
    const { services } = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    await pick(screen().getByRole("dialog", { name: "Adicionar conector" }), "GitHub");
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    const note = () => flow().querySelector(".ac-dialog__foot-note")?.textContent;
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_abcdef123456");
    const shown = note();
    expect(shown).toContain("Ao conectar, todos os agentes podem usar.");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    // The list is read again while the key is still being answered.
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.connections(ORG_ID) }));
    await settle(4);
    expect(services.queryClient.getQueryData<unknown[]>(keys.connections(ORG_ID))).toHaveLength(1);
    expect(note()).toBe(shown);
    await act(async () => answer());
    await settle(4);
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
  });

  test("back from OAuth (`?connected=github`): what it does (read-only, by scope), then 'Ler' = its read scopes", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    everyAgent(api, "conn-gh");
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=github`, { api });
    await settle(8);
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    // Ours are classified by scope: read-only, by subject; each tool shows its level.
    await type(within(flow()).getByRole("searchbox", { name: "Buscar ferramenta" }), "merge");
    const merge = flow().querySelector('[data-row="merge_pull_request"]') as HTMLElement;
    expect(merge.textContent).toContain("Pede sua aprovação");
    expect(merge.getAttribute("title")).toContain("merge_pull_request");
    expect(within(flow()).queryByRole("radiogroup")).toBeNull();
    await type(within(flow()).getByRole("searchbox", { name: "Buscar ferramenta" }), "");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de Ada", "Ler"));
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ADA_ID]);
    const input = puts[0]?.args[2] as AccessInput;
    expect(input.connectors["conn-gh"]).toBeUndefined();
    expect(input.scopes.filter((s) => s.connectionId === "conn-gh")).toEqual([
      { connectionId: "conn-gh", scope: "github:repo.read" },
    ]);
  });

  test("back from OAuth in the desktop app's window, Conectores already loaded: its tools, then who can use it", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    // As the server finishes it.
    api.connectors.completeOAuth = async (orgId, input) => {
      state.calls.push({ method: "connectors.completeOAuth", args: [orgId, input] });
      state.connections.push({
        id: "conn-new",
        connector: "github",
        label: "GitHub",
        serverUrl: "https://api.githubcopilot.com/mcp/",
        authType: "oauth",
        accountLabel: "acme",
        tokenExpiresAt: null,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      });
      everyAgent(api, "conn-new");
      return { connectionId: "conn-new", connector: "github", returnTo: `/org/${ORG_ID}/settings/connectors` };
    };
    const { router } = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    expect(screen().getByRole("region", { name: "Conectores" }).textContent).toContain("Conecte os apps do seu time");
    // The window moves in the page (no reload): the lists read before the sign-in are still cached.
    await act(async () => router.history.push(`/desktop/connector?org=${ORG_ID}&state=s1&code=c1`));
    await settle(12);
    expect(state.calls.find((c) => c.method === "connectors.completeOAuth")?.args[1]).toEqual({
      state: "s1",
      code: "c1",
    });
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de Atlas", "Sem acesso"));
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ATLAS_ID]);
    const input = puts[0]?.args[2] as AccessInput;
    expect(input.connectors["conn-new"]).toBeUndefined();
    expect(input.scopes.some((s) => s.connectionId === "conn-new")).toBe(false);
    expect(document.body.textContent).toContain("GitHub: 1 agente pode usar.");
  });

  test("any MCP server by address; back from its OAuth (`?connected=custom:{id}`) the review opens", async () => {
    const { state, dialog } = await open();
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "Conectar servidor MCP" })).toBeTruthy();
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "http://inseguro");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    expect(flow().textContent).toContain("Use um endereço que comece com https://.");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), "Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
    });
    expect(screen().getByRole("dialog", { name: "Suporte conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: REVIEW }).textContent).toContain("ferramentas do Suporte");
    cleanup();

    const api = createFakeApi(seedState());
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.himetrica.com",
      label: "himetrica",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await renderApp(`/org/${ORG_ID}/settings?connected=custom:${res.server.id}`, { api });
    await settle(8);
    expect(screen().getByRole("dialog", { name: "himetrica conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: REVIEW }).textContent).toContain("ferramentas do himetrica");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar himetrica" })).toBeTruthy();
    expect(levels(flow(), ["Nível de Ada", "Nível de Atlas"])).toEqual(["Ler e escrever", "Ler e escrever"]);
  });

  test("new tools on a reviewed server: the row asks for review; disconnecting always asks first", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await api.customConnectors.saveTools(ORG_ID, res.server.id, {
      label: "Suporte",
      tools: res.server.tools.map((x) => ({ name: x.name, access: x.sensitive ? "off" : "read", label: x.name })),
    });
    await api.customConnectors.refresh(ORG_ID, res.server.id);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    // A server the catalog doesn't list is an MCP: its own section, under the connectors.
    const section = () => screen().getByRole("region", { name: "MCPs" });
    expect(section().textContent).toContain("1 ferramenta nova para revisar");
    await click(within(section()).getByRole("button", { name: "Revisar Suporte" }));
    const review = screen().getByRole("dialog", { name: REVIEW });
    // The new tool comes classified (the server says it only reads), in its subject.
    await type(within(review).getByRole("searchbox", { name: "Buscar ferramenta" }), "exportar");
    const fresh = review.querySelector('[data-row="export_tickets"]') as HTMLElement;
    expect(fresh.textContent).toContain("Exportar chamados");
    await click(within(review).getByRole("button", { name: "Cancelar" }));
    await settle(2);

    await click(within(await rowMenu("Suporte")).getByRole("menuitem", { name: "Desconectar" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar Suporte?" });
    // Connected, it was every agent's.
    expect(confirm.textContent).toContain("2 agentes perdem o acesso na hora.");
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.disconnect")?.args).toEqual([ORG_ID, res.server.id]);
    expect(section().textContent).toContain("Os servidores MCP que você conectar pelo endereço aparecem aqui.");
  });

  test("MCPs: a section of its own with Adicionar MCP, which opens connecting by address; the catalog's stay above", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    expect(document.querySelector(".settings__body .ac-pagehead h2")?.textContent).toBe("Conectores e MCPs");
    const mcps = () => screen().getByRole("region", { name: "MCPs" });
    expect(mcps().textContent).toContain("Os servidores MCP que você conectar pelo endereço aparecem aqui.");
    await click(within(mcps()).getByRole("button", { name: "Adicionar MCP" }));
    const flow = screen().getByRole("dialog", { name: "Conectar servidor MCP" });
    await type(within(flow).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow).getByLabelText("Nome"), "Suporte");
    await click(within(flow).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await click(
      within(screen().getByRole("dialog", { name: "Suporte conectado" })).getByRole("button", { name: "Fechar" }),
    );
    await settle(4);
    expect(mcps().textContent).toContain("Suporte");
    expect(screen().getByRole("region", { name: "Conectores" }).textContent).not.toContain("Suporte");
  });
});

describe("several accounts of one service", () => {
  /** Conectores with Zapier connected twice (the second account "Zapier 2"), and who uses each. */
  const twoAccounts = async (oauthOnly = false) => {
    const state = seedState();
    const api = createFakeApi(state);
    if (oauthOnly) {
      // The catalog lists this server without a key, as it lists Intercom on the Cloud.
      const zapier: ConnectorDef = {
        ...(CATALOG.connectors.find((d) => d.id === "linear") as ConnectorDef),
        id: "zapier",
        label: "Zapier",
        serverUrl: "https://oauth.zapier.example/mcp",
        auth: ["oauth"],
      };
      api.connectors.catalog = async () => ({ ...CATALOG, connectors: [zapier, ...CATALOG.connectors] });
    }
    const connect = async () => {
      const res = await api.customConnectors.connect(ORG_ID, {
        serverUrl: "https://oauth.zapier.example/mcp",
        label: "Zapier",
        returnTo: "/",
      });
      if (res.status !== "connected") throw new Error("expected connected");
      return res.server;
    };
    const first = await connect();
    const second = await connect();
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    return { state, api, first, second };
  };
  const section = () => screen().getByRole("region", { name: "Conectores" });
  const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;

  test("each account is a row with its own name; only an MCP server's ⋯ adds another account", async () => {
    await twoAccounts();
    const names = [...section().querySelectorAll(".list-title > span:first-child")].map((el) => el.textContent);
    expect(names).toEqual(["GitHub", "Zapier", "Zapier 2"]);
    const zapier = await rowMenu("Zapier 2");
    expect(
      within(zapier)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Renomear", "Reconectar", "Adicionar outra conta", "Desconectar"]);
    await pressEsc(zapier);
    const github = await rowMenu("GitHub");
    expect(
      within(github)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Renomear", "Reconectar", "Desconectar"]);
  });

  test("Reconectar signs that account in again: its id goes along, a toast says it, nothing else to do", async () => {
    const { state, second } = await twoAccounts();
    await click(within(await rowMenu("Zapier 2")).getByRole("menuitem", { name: "Reconectar" }));
    expect(screen().getByRole("dialog", { name: "Reconectar Zapier 2" })).toBe(flow());
    expect(flow().textContent).toContain(
      "Entre na mesma conta de antes. A gente não consegue conferir qual é, e quem usa continua igual.",
    );
    await click(within(flow()).getByRole("button", { name: "Continuar no Zapier" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "customConnectors.connect").at(-1)?.args[1]).toMatchObject({
      serverUrl: "https://oauth.zapier.example/mcp",
      connectionId: second.id,
    });
    expect(document.body.textContent).toContain("Zapier 2 reconectado.");
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("an account of a server the catalog lists without a key: neither Reconectar nor another account offers one", async () => {
    await twoAccounts(true);
    await click(within(await rowMenu("Zapier 2")).getByRole("menuitem", { name: "Reconectar" }));
    expect(within(flow()).getByRole("button", { name: "Continuar no Zapier" })).toBeTruthy();
    expect(flow().textContent).not.toContain("Conectar com uma chave de API");
    await pressEsc(flow());
    await click(within(await rowMenu("Zapier")).getByRole("menuitem", { name: "Adicionar outra conta" }));
    expect(flow().textContent).not.toContain("Conectar com uma chave de API");
    expect(within(flow()).queryByLabelText("Chave de API")).toBeNull();
  });

  test("another account: every agent's too; Ajustar asks its name first, then its tools, then who uses it", async () => {
    const { state } = await twoAccounts();
    await click(within(await rowMenu("Zapier")).getByRole("menuitem", { name: "Adicionar outra conta" }));
    expect(screen().getByRole("dialog", { name: "Outra conta do Zapier" })).toBe(flow());
    // No account here was named by its provider, so step 1 can't tell accounts apart and asks for one not yet here.
    expect(flow().textContent).toContain(
      "Entre numa conta que ainda não está conectada, a gente não consegue conferir.",
    );
    expect(flow().textContent).not.toContain("sem agentes");
    await click(within(flow()).getByRole("button", { name: "Continuar no Zapier" }));
    await settle(4);
    const sent = state.calls.filter((c) => c.method === "customConnectors.connect").at(-1)?.args[1] as {
      connectionId?: string;
      label?: string;
    };
    expect([sent.connectionId, sent.label]).toEqual([undefined, "Zapier"]);
    expect(screen().getByRole("dialog", { name: "Zapier 3 conectado" })).toBe(flow());
    await adjust();
    // A name the server numbered: asked above its tools, and a name another account has is refused there.
    const name = within(flow()).getByLabelText("Nome desta conta") as HTMLInputElement;
    expect(name.value).toBe("Zapier 3");
    await type(name, "zapier 2");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(flow().textContent).toContain("Já existe um conector com esse nome.");
    expect(state.calls.some((c) => c.method === "customConnectors.saveTools")).toBe(false);
    await type(name, "Zapier Loja");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[2]).toMatchObject({
      label: "Zapier Loja",
    });
    expect(screen().getByRole("dialog", { name: "Quem pode usar Zapier Loja" })).toBe(flow());
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
  });

  test("Quem usa is per account, and every account starts as every agent's", async () => {
    await twoAccounts();
    const who = async (name: string) => {
      await click(within(section()).getByRole("button", { name: `Quem usa ${name}` }));
      await settle(4);
      const shown = levels(flow(), ["Nível de Ada", "Nível de Atlas"]);
      await click(within(flow()).getByRole("button", { name: "Voltar" }));
      await click(within(flow()).getByRole("button", { name: "Cancelar" }));
      return shown;
    };
    expect(await who("Zapier")).toEqual(["Ler e escrever", "Ler e escrever"]);
    expect(await who("Zapier 2")).toEqual(["Ler e escrever", "Ler e escrever"]);
  });

  test("Renomear: the new name everywhere, a name another connector has is refused in place", async () => {
    const { state, second } = await twoAccounts();
    await click(within(await rowMenu("Zapier 2")).getByRole("menuitem", { name: "Renomear" }));
    const dialog = screen().getByRole("dialog", { name: "Renomear Zapier 2" });
    const name = within(dialog).getByLabelText("Nome") as HTMLInputElement;
    expect(name.value).toBe("Zapier 2");
    await type(name, "GitHub");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(dialog.textContent).toContain("Já existe um conector com esse nome.");
    await type(name, "Zapier Loja");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "connectors.rename").at(-1)?.args).toEqual([
      ORG_ID,
      second.id,
      "Zapier Loja",
    ]);
    expect(document.body.textContent).toContain("Agora se chama Zapier Loja.");
    expect(within(section()).getByRole("button", { name: "Quem usa Zapier Loja" })).toBeTruthy();
  });

  test("back from OAuth, the outcome says what happened: only a new account gets the confirmation", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.zapier.example/mcp",
      label: "Zapier",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=custom:${res.server.id}&outcome=reconnected`, {
      api,
    });
    await settle(8);
    expect(document.body.textContent).toContain("Zapier reconectado.");
    expect(screen().queryByRole("dialog")).toBeNull();
  });
});

describe("the confirmation that ends connecting", () => {
  const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
  const sentence = () => flow().querySelector(".cflow__text")?.textContent;
  const buttons = () =>
    [...flow().querySelectorAll(".ac-dialog__foot button")].map((b) => (b as HTMLButtonElement).textContent);
  const connection = (connector: string, label: string) => ({
    id: `conn-${connector}`,
    connector,
    label,
    serverUrl: "https://mcp.example.com/mcp",
    authType: "api_key" as const,
    accountLabel: null,
    tokenExpiresAt: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });

  test("ours: everyone can use it and how many actions ask; Pronto closes and nothing is saved", async () => {
    const { state, dialog } = await open();
    await pick(dialog, "GitHub");
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_abcdef123456");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
    expect(sentence()).toBe("Todos os agentes podem usar. 1 ação pede aprovação no chat.");
    expect(buttons()).toEqual(["Ajustar", "Pronto"]);
    await click(within(flow()).getByRole("button", { name: "Pronto" }));
    await settle(4);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.filter((c) => c.method === "access.set" || c.method === "customConnectors.saveTools")).toEqual(
      [],
    );
    // Its detail stays one click away on its row.
    const section = screen().getByRole("region", { name: "Conectores" });
    expect(within(section).getByRole("button", { name: "Quem usa GitHub" })).toBeTruthy();
  });

  test("nothing asks: the sentence stops at who can use it, never '0 ações'", async () => {
    const state = seedState({ connections: [connection("sentry", "Sentry")] });
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=sentry`, { api: createFakeApi(state) });
    await settle(8);
    expect(screen().getByRole("dialog", { name: "Sentry conectado" })).toBe(flow());
    expect(sentence()).toBe("Todos os agentes podem usar.");
  });

  test("a server whose tools have no level yet: it says so, and Continuar saves the suggested ones", async () => {
    const { state, dialog } = await open();
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), "Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(sentence()).toBe(`${WAITING} 1 ação pede aprovação no chat.`);
    expect(buttons()).toEqual(["Ajustar", "Continuar"]);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().queryByRole("dialog")).toBeNull();
    const saved = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[2] as {
      tools: { name: string; access: string; confirmed: boolean }[];
    };
    expect(Object.fromEntries(saved.tools.map((x) => [x.name, x.access]))).toEqual({
      list_tickets: "read",
      get_ticket: "read",
      create_ticket: "write",
      close_ticket: "write",
      delete_customer: "approval",
    });
    // The one its name couldn't decide keeps waiting for a person, at our suggestion meanwhile.
    expect(saved.tools.filter((x) => !x.confirmed).map((x) => x.name)).toEqual(["close_ticket"]);
    expect(state.calls.filter((c) => c.method === "access.set")).toEqual([]);
  });

  test("a server whose tools already have their levels: Pronto, with what asks counted from them", async () => {
    const api = createFakeApi(seedState());
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await api.customConnectors.saveTools(ORG_ID, res.server.id, {
      label: "Suporte",
      tools: res.server.tools.map((x) => ({
        name: x.name,
        access: x.readOnlyHint ? "read" : "approval",
        label: x.name,
      })),
    });
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=custom:${res.server.id}`, { api });
    await settle(8);
    expect(sentence()).toBe("Todos os agentes podem usar. 3 ações pedem aprovação no chat.");
    expect(buttons()).toEqual(["Ajustar", "Pronto"]);
  });

  test("a name longer than a connection can take: whole in the title, the two buttons still there", async () => {
    const long = "Atendimento e Suporte ao Cliente da Loja de Departamentos Internacional Example (Produção 2)";
    expect(long.length).toBeGreaterThan(80);
    const { dialog } = await open();
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), long);
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: `${long} conectado` })).toBe(flow());
    expect(buttons()).toEqual(["Ajustar", "Continuar"]);
  });

  test("the sentence in both languages: one action, many, none", () => {
    const of = (lng: "pt-BR" | "en", sensitive: number) =>
      connectedSummary(createI18n(lng).t as TFunction, {
        server: null,
        pending: 0,
        def: {
          ...(CATALOG.connectors.find((d) => d.id === "github") as ConnectorDef),
          tools: Array.from({ length: 3 }, (_, i) => ({
            name: `tool_${i}`,
            scope: "github:x",
            sensitive: i < sensitive,
          })),
        },
      });
    expect([0, 1, 2].map((n) => of("pt-BR", n))).toEqual([
      "Todos os agentes podem usar.",
      "Todos os agentes podem usar. 1 ação pede aprovação no chat.",
      "Todos os agentes podem usar. 2 ações pedem aprovação no chat.",
    ]);
    expect([0, 1, 2].map((n) => of("en", n))).toEqual([
      "Every agent can use it.",
      "Every agent can use it. 1 action asks for approval in the chat.",
      "Every agent can use it. 2 actions ask for approval in the chat.",
    ]);
  });
});

describe("a server whose tools can't be read", () => {
  test("Conectores says so on the row: a dead sign-in Precisa reconectar with Reconectar; tools unread, Sem ferramentas agora", async () => {
    const state = seedState();
    const github = state.connections[0];
    if (github) github.status = "needs_reconnect";
    const api = createFakeApi(state);
    // A long name: the chip beside it still fits the row at any width.
    const label = "Suporte ao cliente das lojas da região sul e do centro-oeste";
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label,
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    const list = api.customConnectors.list;
    api.customConnectors.list = async (orgId) =>
      (await list(orgId)).map((s) => ({ ...s, toolsError: "Streamable HTTP error: upstream timed out" }));
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const row = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".connected-row")].find((r) =>
        r.querySelector(".list-title")?.textContent?.startsWith(name),
      ) as HTMLElement;
    expect(row("GitHub").querySelector(".list-title")?.textContent).toBe("GitHubPrecisa reconectar");
    expect(within(row("GitHub")).getByRole("button", { name: "Reconectar GitHub" })).toBeTruthy();
    expect(row(label).querySelector(".list-title")?.textContent).toBe(`${label}Sem ferramentas agora`);
  });

  test("the review says why with Tentar de novo, not '0 ferramentas'; a working retry lists them", async () => {
    const api = createFakeApi(seedState({ connections: [] }));
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    const reason = "Streamable HTTP error: Error POSTing to endpoint: upstream timed out";
    const list = api.customConnectors.list;
    let broken = true;
    api.customConnectors.list = async (orgId) =>
      (await list(orgId)).map((s) => (broken ? { ...s, tools: [], toolsError: reason } : s));
    const refresh = api.customConnectors.refresh;
    api.customConnectors.refresh = async (orgId, id) => {
      broken = false;
      return refresh(orgId, id);
    };
    await renderApp(`/org/${ORG_ID}/settings?connected=custom:${res.server.id}`, { api });
    await settle(8);
    // The confirmation says it too, under who can use it.
    const done = screen().getByRole("dialog", { name: "Suporte conectado" });
    expect(done.querySelector(".cflow__text")?.textContent).toBe("Todos os agentes podem usar.");
    expect(within(done).getByRole("alert").textContent).toBe(`Não deu para ler as ferramentas do conector: ${reason}`);
    await adjust();
    const review = () => screen().getByRole("dialog", { name: REVIEW });
    expect(within(review()).getByRole("alert").textContent).toBe(
      `Não deu para ler as ferramentas do conector: ${reason}`,
    );
    expect(review().textContent).not.toContain("Classificamos");
    expect(review().textContent).not.toContain("O servidor não ofereceu nenhuma ferramenta.");
    await click(within(review()).getByRole("button", { name: "Tentar de novo" }));
    await settle(4);
    expect(within(review()).queryByRole("alert")).toBeNull();
    // The fake finds one tool more on a refresh.
    expect(review().textContent).toContain("Classificamos as 6 ferramentas do Suporte.");
  });
});
