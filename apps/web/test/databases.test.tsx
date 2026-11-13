import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { defaultDatabasePolicy } from "@agenteschat/client/lib/databases";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { pick, service } from "./catalog";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeDatabasesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;

function databaseApi() {
  const state = seedState({ connections: [] });
  const api = createFakeApi(state);
  const databases = fakeDatabasesOf.get(api);
  if (!databases) throw new Error("no databases fake");
  return { state, api, databases };
}

const openCatalog = async (api: ReturnType<typeof createFakeApi>) => {
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  return screen().getByRole("dialog", { name: "Adicionar conector" });
};

describe("Conectores → Banco de dados", () => {
  test("the card is in Desenvolvimento, says how it connects, and no jargon", async () => {
    const { api } = databaseApi();
    const dialog = await openCatalog(api);
    await click(
      // The categories, each with its count ("Desenvolvimento 3").
      within(within(dialog).getByRole("radiogroup", { name: "Categorias" })).getByRole("radio", {
        name: /^Desenvolvimento/,
      }),
    );
    const card = within(dialog).getByRole("button", { name: "Banco de dados" });
    expect(card.textContent).toContain("só leitura");
    // How it connects, and that it never changes anything, in its dialog.
    await click(card);
    const detail = service("Banco de dados");
    expect(detail.textContent).toContain("Precisa do endereço do banco e de uma senha");
    expect(detail.textContent).toContain("Nunca altera nada");
    expect(`${dialog.textContent} ${detail.textContent}`).not.toMatch(/MCP server|scope/i);
  });

  test("connect → o que faz → quem pode usar → regras, with plain errors and the read-only user help", async () => {
    const { api, state, databases } = databaseApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Banco de dados");
    expect(flow().textContent).toContain("Conectar Banco de dados");
    // How to make a read-only user: the steps, the SQL to paste (with Copiar) and the provider's page.
    expect(flow().textContent).toContain("Como criar um usuário só de leitura?");
    expect(flow().textContent).toContain("create role agentes_leitura");
    expect(within(flow()).getByRole("button", { name: "Copiar" })).toBeTruthy();
    expect(within(flow()).getByRole("link", { name: "Abrir o Supabase" })).toBeTruthy();

    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    expect(flow().textContent).toContain("Cole um endereço que comece com postgres://");
    expect(state.calls.some((c) => c.method === "databases.connect")).toBe(false);

    await type(within(flow()).getByLabelText("Nome"), "Produção");
    await type(
      within(flow()).getByLabelText("Endereço do banco"),
      "postgres://agentes_leitura:pw@db.acme.com:6543/app",
    );
    databases.nextError = "blocked_host";
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(within(flow()).getByRole("alert").textContent).toContain("Esse servidor não é permitido.");

    databases.canWrite = true;
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "databases.connect").at(-1)?.args[1]).toMatchObject({
      provider: "supabase",
      label: "Produção",
    });
    // Step 2: the three tools, all "Consulta"; a user that can write gets the read-only recommendation.
    expect(screen().getByRole("dialog", { name: "O que Produção faz" })).toBeTruthy();
    expect(flow().textContent).toContain("Esse usuário pode alterar dados.");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    // Step 3: only "Sem acesso" and "Ler".
    expect(screen().getByRole("dialog", { name: "Quem pode usar Produção" })).toBeTruthy();
    const ada = within(flow()).getByRole("radiogroup", { name: "Nível de Ada" });
    expect(
      within(ada)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Sem acesso", "Ler"]);
    await click(within(ada).getByRole("radio", { name: "Ler" }));
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    const granted = state.calls.find((c) => c.method === "databases.setAgent");
    expect(granted?.args[1]).toBe(ADA_ID);
    expect(granted?.args[3]).toEqual({
      level: "read",
      policy: { tables: [], hiddenColumns: ["public.customers.cpf"], dailyQueryCap: null, timeoutSeconds: 15 },
    });
    // Step 4: Ada's rules, starting from the sensitive columns already hidden.
    expect(screen().getByRole("dialog", { name: "Regras em Produção" })).toBeTruthy();
    expect(flow().textContent).toContain("public.customers.cpf");
    await click(within(flow()).getByLabelText("orders"));
    await click(within(flow()).getByRole("radio", { name: "30 segundos" }));
    await click(within(flow()).getByRole("button", { name: "Salvar regras" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "databases.setAgent").at(-1)?.args[3]).toEqual({
      level: "read",
      policy: {
        tables: ["public.orders"],
        hiddenColumns: ["public.customers.cpf"],
        dailyQueryCap: null,
        timeoutSeconds: 30,
      },
    });
    // The connected row: name, active, read-only, who reads it.
    const row = (await screen().findByText("Produção")).closest(".connected-row") as HTMLElement;
    expect(row.textContent).toContain("Só lê");
    expect(row.textContent).toContain("agentes_leitura@db.acme.com/app");
    expect(row.textContent).toContain("1 de");
  });
});

describe("Regras em: remove all, copy to other agents", () => {
  test("Remover tudo empties the hidden columns with Desfazer, Copiar regras gives Atlas Ada's rules", async () => {
    const { api, state } = databaseApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Banco de dados");
    await type(within(flow()).getByLabelText("Nome"), "Produção");
    await type(within(flow()).getByLabelText("Endereço do banco"), "postgres://reader:pw@db.acme.com:6543/app");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    for (const name of ["Ada", "Atlas"]) {
      const level = within(flow()).getByRole("radiogroup", { name: `Nível de ${name}` });
      await click(within(level).getByRole("radio", { name: "Ler" }));
    }
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Regras em Produção" })).toBeTruthy();
    const hidden = () => within(flow()).queryAllByRole("button", { name: /^Remover public\./ });

    // One chip: no "Remover tudo" yet.
    expect(within(flow()).queryByRole("button", { name: "Remover tudo de Colunas que ele nunca vê" })).toBeNull();
    await type(within(flow()).getByRole("textbox", { name: "Colunas que ele nunca vê" }), "users.password_hash");
    await click(within(flow()).getByRole("button", { name: "Adicionar em Colunas que ele nunca vê" }));
    expect(hidden()).toHaveLength(2);
    // The live regions are there, empty, before anything is announced.
    const [clearStatus, copyStatus] = within(flow()).getAllByRole("status");
    expect(clearStatus?.textContent).toBe("");
    expect(copyStatus?.textContent).toBe("");
    await click(within(flow()).getByRole("button", { name: "Remover tudo de Colunas que ele nunca vê" }));
    expect(hidden()).toHaveLength(0);
    expect(clearStatus?.textContent).toContain("2 itens removidos.");
    expect(document.activeElement?.textContent).toBe("Desfazer");
    await click(within(flow()).getByRole("button", { name: "Desfazer" }));
    expect(hidden()).toHaveLength(2);
    await click(within(flow()).getByRole("button", { name: "Remover tudo de Colunas que ele nunca vê" }));
    await click(within(flow()).getByLabelText("orders"));

    // Copy Ada's rules to Atlas: Atlas's tab shows them, and both save.
    const copy = within(flow()).getByRole("button", { name: "Copiar regras" }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    await click(within(flow()).getByLabelText("Atlas"));
    await click(copy);
    expect(flow().textContent).toContain("Copiadas para Atlas. Salve para aplicar.");
    await click(within(flow()).getByRole("radio", { name: "Atlas" }));
    await settle(4);
    expect(hidden()).toHaveLength(0);
    await click(within(flow()).getByRole("button", { name: "Salvar regras" }));
    await settle(6);
    const saves = state.calls.filter((c) => c.method === "databases.setAgent").slice(-2);
    const policy = { tables: ["public.orders"], hiddenColumns: [], dailyQueryCap: null, timeoutSeconds: 15 };
    expect(saves.map((c) => c.args[1]).sort()).toEqual([ADA_ID, ATLAS_ID].sort());
    for (const c of saves) expect(c.args[3]).toEqual({ level: "read", policy });
  });
});

describe("Regras em: undo a copy", () => {
  test("Desfazer after Copiar regras gives Atlas back its own unsaved edits", async () => {
    const { api, state } = databaseApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Banco de dados");
    await type(within(flow()).getByLabelText("Nome"), "Produção");
    await type(within(flow()).getByLabelText("Endereço do banco"), "postgres://reader:pw@db.acme.com:6543/app");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    for (const name of ["Ada", "Atlas"]) {
      const level = within(flow()).getByRole("radiogroup", { name: `Nível de ${name}` });
      await click(within(level).getByRole("radio", { name: "Ler" }));
    }
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    // Atlas's own edit, then Ada's rules copied over it.
    await click(within(flow()).getByRole("radio", { name: "Atlas" }));
    await settle(4);
    await click(within(flow()).getByLabelText("orders"));
    await click(within(flow()).getByRole("radio", { name: "Ada" }));
    await settle(4);
    await click(within(flow()).getByLabelText("Atlas"));
    await click(within(flow()).getByRole("button", { name: "Copiar regras" }));
    const status = within(flow()).getAllByRole("status").at(-1) as HTMLElement;
    expect(status.textContent).toContain("Copiadas para Atlas.");
    await click(within(status).getByRole("button", { name: "Desfazer" }));
    expect(status.textContent).toBe("");
    await click(within(flow()).getByRole("button", { name: "Salvar regras" }));
    await settle(6);
    const atlas = state.calls.filter((c) => c.method === "databases.setAgent" && c.args[1] === ATLAS_ID).at(-1);
    expect((atlas?.args[3] as { policy?: { tables: string[] } } | undefined)?.policy?.tables).toEqual([
      "public.orders",
    ]);
  });
});

describe("the agent's database access", () => {
  test("Ler and the rules save on their own, from the sensitive columns hidden by default", async () => {
    const { api, state, databases } = databaseApi();
    await databases.client.connect(ORG_ID, { label: "Produção", url: "postgres://reader:pw@db.acme.com/app" });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    expect(screen().getByRole("heading", { name: "Bancos de dados" })).toBeTruthy();
    const level = screen().getByRole("radiogroup", { name: "Nível em Produção" });
    expect(
      within(level)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Sem acesso", "Ler"]);
    await click(within(level).getByRole("radio", { name: "Ler" }));
    const row = level.closest("li") as HTMLElement;
    await click(within(row).getByLabelText("Regras em Produção"));
    await settle(4);
    await type(within(row).getByRole("textbox", { name: "Colunas que ele nunca vê" }), "nada");
    await click(within(row).getByRole("button", { name: "Adicionar em Colunas que ele nunca vê" }));
    expect(row.textContent).toContain("Digite tabela.coluna");
    await type(within(row).getByRole("textbox", { name: "Colunas que ele nunca vê" }), "users.password_hash");
    await click(within(row).getByRole("button", { name: "Adicionar em Colunas que ele nunca vê" }));
    await type(within(row).getByLabelText("Consultas por dia"), "200");
    await click(within(row).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "databases.setAgent")?.args[3]).toEqual({
      level: "read",
      policy: {
        tables: [],
        hiddenColumns: ["public.customers.cpf", "public.users.password_hash"],
        dailyQueryCap: 200,
        timeoutSeconds: 15,
      },
    });
    expect(screen().getByText("Acesso de Ada ao banco salvo.")).toBeTruthy();
  });
});

describe("Quais bancos: one database, or every database of the server", () => {
  test("follows whether the address names a database; every database sends wholeServer and the prefix", async () => {
    const { api, state } = databaseApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Banco de dados");
    const scope = () => within(flow()).getByRole("radiogroup", { name: "Quais bancos" });
    const checked = () => within(scope()).getByRole("radio", { checked: true }).textContent;
    // No address yet: every database, with the prefix field and the role that reads them all.
    expect(checked()).toBe("Todos os bancos deste servidor");
    expect(flow().textContent).toContain("Para quem tem um banco por cliente.");
    expect(flow().textContent).toContain("grant pg_read_all_data to agentes_leitura;");
    await type(within(flow()).getByLabelText("Endereço do banco"), "postgres://reader:pw@db.acme.com:6543/app");
    expect(checked()).toBe("Só este banco");
    expect(within(flow()).queryByLabelText("Só os que começam com")).toBeNull();
    expect(flow().textContent).toContain("grant connect on database app");
    await type(within(flow()).getByLabelText("Endereço do banco"), "postgres://reader:pw@db.acme.com:6543");
    expect(checked()).toBe("Todos os bancos deste servidor");
    await type(within(flow()).getByLabelText("Só os que começam com"), "cliente_");
    await type(within(flow()).getByLabelText("Nome"), "Clientes");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "databases.connect").at(-1)?.args[1]).toMatchObject({
      url: "postgres://reader:pw@db.acme.com:6543",
      wholeServer: true,
      databasePrefix: "cliente_",
    });
    expect(screen().getByText("Clientes conectado com 3 bancos.")).toBeTruthy();
  });

  test("picking Só este banco for an address without a name sends no wholeServer", async () => {
    const { api, state } = databaseApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Banco de dados");
    await type(within(flow()).getByLabelText("Endereço do banco"), "postgres://reader:pw@db.acme.com");
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Quais bancos" })).getByRole("radio", {
        name: "Só este banco",
      }),
    );
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    const sent = state.calls.filter((c) => c.method === "databases.connect").at(-1)?.args[1] as Record<string, unknown>;
    expect(sent.wholeServer).toBeUndefined();
  });

  test("the agent's page: Todos os bancos or Só estes, rules for every database", async () => {
    const { api, state, databases } = databaseApi();
    await databases.client.connect(ORG_ID, {
      label: "Clientes",
      url: "postgres://reader:pw@db.acme.com",
      wholeServer: true,
    });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    const level = screen().getByRole("radiogroup", { name: "Nível em Clientes" });
    await click(within(level).getByRole("radio", { name: "Ler" }));
    const row = level.closest("li") as HTMLElement;
    expect(row.textContent).toContain("Todos os bancos de Clientes");
    await click(within(row).getByLabelText("Regras em Clientes"));
    await settle(4);
    expect(row.textContent).toContain("Tabelas (vistas em cliente_a)");
    expect(row.textContent).toContain("Somando todos os bancos.");
    await click(
      within(within(row).getByRole("radiogroup", { name: "Bancos" })).getByRole("radio", { name: "Só estes" }),
    );
    await type(within(row).getByRole("combobox", { name: "Só estes" }), "cliente_b");
    await click(within(row).getByRole("button", { name: "Adicionar em Só estes" }));
    expect(row.textContent).toContain("1 banco de Clientes");
    await click(within(row).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "databases.setAgent")?.args[3]).toMatchObject({
      level: "read",
      policy: { databases: ["cliente_b"] },
    });
  });

  test("the connected row: user@server, how many databases, the prefix, Atualizar lista", async () => {
    const { api, state, databases } = databaseApi();
    await databases.client.connect(ORG_ID, {
      label: "Clientes",
      url: "postgres://reader:pw@db.acme.com",
      wholeServer: true,
      databasePrefix: "cliente_",
    });
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const row = (await screen().findByText("Clientes")).closest(".connected-row") as HTMLElement;
    expect(row.textContent).toContain("reader@db.acme.com · 3 bancos · bancos que começam com cliente_");
    await click(within(row).getByRole("button", { name: "Atualizar a lista de bancos de Clientes" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "databases.serverDatabases" && c.args[2] === true)).toBe(true);
  });
});

describe("Bancos of a connected database: ask before more databases open", () => {
  async function connected(input: { wholeServer?: boolean; databasePrefix?: string }, readers: string[]) {
    const { api, state, databases } = databaseApi();
    const c = await databases.client.connect(ORG_ID, {
      label: "Clientes",
      url: "postgres://reader:pw@db.acme.com/app",
      ...input,
    });
    for (const agentId of readers)
      await databases.client.setAgent(ORG_ID, agentId, c.id, { level: "read", policy: defaultDatabasePolicy() });
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const row = (await screen().findByText("Clientes")).closest(".connected-row") as HTMLElement;
    await click(within(row).getByRole("button", { name: "Bancos de Clientes" }));
    const updates = () => state.calls.filter((c) => c.method === "databases.update");
    return { updates };
  }
  const pickAll = () =>
    click(
      within(within(flow()).getByRole("radiogroup", { name: "Quais bancos" })).getByRole("radio", {
        name: "Todos os bancos deste servidor",
      }),
    );
  const save = () => click(within(flow()).getByRole("button", { name: "Salvar" }));

  test("one database → the whole server with agents reading it asks once; Cancelar saves nothing, Continuar saves once", async () => {
    const { updates } = await connected({}, [ADA_ID, ATLAS_ID]);
    await pickAll();
    await save();
    expect(flow().textContent).toContain("Abrir o servidor inteiro?");
    expect(flow().textContent).toContain(
      "Os 2 agentes com acesso passam a ler todos os bancos deste servidor. Dá para limitar por agente em Regras.",
    );
    await click(within(flow()).getByRole("button", { name: "Cancelar" }));
    expect(updates()).toHaveLength(0);
    // Back on the choice, still Todos: saving asks again.
    await save();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]?.args[2]).toEqual({ wholeServer: true, databasePrefix: "" });
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("an archived agent's grant isn't counted", async () => {
    const ARCHIVED_ID = "00000000-0000-4000-8000-0000000000a9";
    const { updates } = await connected({}, [ADA_ID, ARCHIVED_ID]);
    await pickAll();
    await save();
    expect(flow().textContent).toContain("O agente com acesso passa a ler todos os bancos deste servidor.");
    expect(updates()).toHaveLength(0);
    cleanup();

    const only = await connected({}, [ARCHIVED_ID]);
    await pickAll();
    await save();
    await settle(4);
    expect(only.updates()).toHaveLength(1);
    expect(screen().queryByText("Abrir o servidor inteiro?")).toBeNull();
  });

  test("Desconectar counts only the agents that aren't archived", async () => {
    const ARCHIVED_ID = "00000000-0000-4000-8000-0000000000a9";
    await connected({}, [ADA_ID, ARCHIVED_ID]);
    await click(within(flow()).getByRole("button", { name: "Cancelar" }));
    const row = (await screen().findByText("Clientes")).closest(".connected-row") as HTMLElement;
    await click(within(row).getByRole("button", { name: "Desconectar Clientes" }));
    expect(flow().textContent).toContain("1 agente perde o acesso na hora.");
    cleanup();

    await connected({}, [ARCHIVED_ID]);
    await click(within(flow()).getByRole("button", { name: "Cancelar" }));
    const only = (await screen().findByText("Clientes")).closest(".connected-row") as HTMLElement;
    await click(within(only).getByRole("button", { name: "Desconectar Clientes" }));
    expect(flow().textContent).toContain("Nenhum agente usa agora.");
  });

  test("no question with no agent reading it", async () => {
    const { updates } = await connected({}, []);
    await pickAll();
    await save();
    await settle(4);
    expect(updates()).toHaveLength(1);
    expect(screen().queryByText("Abrir o servidor inteiro?")).toBeNull();
  });

  test("a longer prefix or one database asks nothing; another prefix asks with the prefix", async () => {
    const narrow = await connected({ wholeServer: true, databasePrefix: "cliente_" }, [ADA_ID]);
    await type(within(flow()).getByLabelText("Só os que começam com"), "cliente_a");
    await save();
    await settle(4);
    expect(narrow.updates()).toHaveLength(1);
    expect(narrow.updates()[0]?.args[2]).toEqual({ wholeServer: true, databasePrefix: "cliente_a" });
    cleanup();

    const one = await connected({ wholeServer: true, databasePrefix: "cliente_" }, [ADA_ID]);
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Quais bancos" })).getByRole("radio", {
        name: "Só este banco",
      }),
    );
    await save();
    await settle(4);
    expect(one.updates()[0]?.args[2]).toEqual({ wholeServer: false });
    cleanup();

    const other = await connected({ wholeServer: true, databasePrefix: "cliente_" }, [ADA_ID]);
    await type(within(flow()).getByLabelText("Só os que começam com"), "loja_");
    await save();
    expect(flow().textContent).toContain("Abrir mais bancos?");
    expect(flow().textContent).toContain("O agente com acesso passa a ler todos os bancos que começam com loja_.");
    expect(other.updates()).toHaveLength(0);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(other.updates()).toHaveLength(1);
  });
});
