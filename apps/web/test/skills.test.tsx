import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { join } from "node:path";
import { activityText, toolActivity } from "@agenteschat/client/lib/activity";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { setNavigateAway } from "@/lib/navigate";
import { declarations, topLevel } from "./built-css";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { proceed, startAs } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const pickTab = async (tab: HTMLElement) => {
  tab.focus();
  await key(tab, "Enter");
  await act(async () => fireEvent.mouseDown(tab));
};
const settings = async (state = seedState(), api = createFakeApi(state)) => {
  await renderApp(`/org/${ORG_ID}/settings/skills`, { api });
  await settle(8);
  return { state, api, section: () => screen().getByRole("region", { name: "Skills" }) };
};
/** The seeded library (3 skills) and `count` more: "Extra 1", "Extra 2"… */
const withExtras = async (count: number) => {
  const state = seedState();
  const api = createFakeApi(state);
  await api.skills.list(ORG_ID);
  for (let i = 1; i <= count; i++) {
    await api.skills.create(ORG_ID, { name: `Extra ${i}`, description: "x", body: "# x" });
  }
  return { state, api };
};

describe("Configurações → Skills", () => {
  test("the library: name, description, source, version and how many agents use it", async () => {
    const { section } = await settings();
    // The card's head is its title and Install: what a skill is lives in Settings' own line above it.
    expect(section().querySelector("#sec-skills")?.closest(".ac-card__head")?.textContent).toBe("SkillsInstalar skill");
    const rows = within(section()).getAllByRole("button", { name: /Revisão de PR|Relatório semanal|Atendimento/ });
    expect(rows.map((r) => r.textContent)).toEqual(["Revisão de PR", "Relatório semanal", "Atendimento"]);
    const review = rows[0]?.closest(".skill-row") as HTMLElement;
    expect(review.textContent).toContain("Use quando pedirem para revisar um pull request.");
    expect(review.textContent).toContain("GitHub");
    expect(review.textContent).toContain("v3");
    expect(review.textContent).toContain("1 agente usa");
    expect((rows[1]?.closest(".skill-row") as HTMLElement | null)?.textContent).toContain("Criada aqui");
    expect((rows[1]?.closest(".skill-row") as HTMLElement | null)?.textContent).toContain("Em agentes novos");
    expect((rows[2]?.closest(".skill-row") as HTMLElement | null)?.textContent).toContain("Enviada");
    // GitHub is named by its own mark, the connector catalog's; the other sources keep their icons.
    const chip = (name: string) =>
      [...section().querySelectorAll(".skill-row .ac-chip")].find((c) => c.textContent === name) as HTMLElement;
    const github = chip("GitHub").querySelector<HTMLElement>(".connector-icon__mark");
    expect(github?.style.getPropertyValue("--connector-icon")).toBe('url("/connectors/github.svg")');
    expect(chip("GitHub").querySelector("svg.ac-icon")).toBeNull();
    for (const name of ["Criada aqui", "Enviada"]) {
      expect(chip(name).querySelector(".connector-icon")).toBeNull();
      expect(chip(name).querySelector("svg.ac-icon")).not.toBeNull();
    }
  });

  test("a row stacks the name, its source line and what it is for, so the description runs the row's width", async () => {
    const { section } = await settings();
    const row = within(section()).getByRole("button", { name: "Relatório semanal" }).closest(".skill-row");
    expect([...(row?.children ?? [])].map((c) => [c.className, c.textContent])).toEqual([
      ["skill-row__name", "Relatório semanal"],
      ["skill-row__meta", "Criada aquiEm agentes novosv1 · nenhum agente usa"],
      ["small muted", "Monta o resumo da semana."],
    ]);
    // A column whose lines take its whole width (the name keeps its own); the source line's marks share one centre
    // line and wrap on a phone.
    const css = topLevel(await Bun.file(join(import.meta.dir, "../src/layout.css")).text());
    expect(declarations(css, ".skill-row")).toEqual([
      ["flex-direction", "column"],
      ["align-items", "stretch"],
      ["gap", "var(--space-1)"],
    ]);
    expect(declarations(css, ".skill-row__name")).toContainEqual(["align-self", "flex-start"]);
    expect(declarations(css, ".skill-row__meta")).toEqual([
      ["display", "flex"],
      ["flex-wrap", "wrap"],
      ["align-items", "center"],
      ["gap", "var(--space-1) var(--space-2)"],
    ]);
  });

  test("detail: rendered body, files (scripts run on the PC, files not kept say why), remove names the agents", async () => {
    const { state, section } = await settings();
    await click(within(section()).getByRole("button", { name: "Revisão de PR" }));
    await settle(4);
    const sheet = screen().getByRole("dialog", { name: "Revisão de PR" });
    // The sheet title and the body's own heading.
    expect(within(sheet).getAllByRole("heading", { name: "Revisão de PR" }).length).toBeGreaterThanOrEqual(2);
    expect(sheet.querySelector("pre.code-card__code code")?.textContent).toBe("bun test");
    const files = within(sheet).getByRole("navigation", { name: "Arquivos" });
    // Scripts run on the agent's PC; a file an older import only listed says how to get it.
    const script = within(files).getByText("scripts/lint.sh").closest(".skill-file") as HTMLElement;
    expect(script.textContent).toContain("roda no PC do agente");
    const old = within(files).getByText("scripts/old.py").closest(".skill-file") as HTMLElement;
    expect(old.textContent).toContain("não guardado");
    expect(old.textContent).toContain("Reinstale a skill");
    const text = within(files).getByText("checklist.md").closest(".skill-file") as HTMLElement;
    expect(text.textContent).toContain("text/markdown");
    expect(text.textContent).not.toContain("não guardado");
    await click(within(sheet).getByRole("button", { name: "Remover" }));
    const confirm = screen().getByRole("dialog", { name: "Remover Revisão de PR?" });
    expect(confirm.textContent).toContain("Ada usa esta skill e deixa de ter acesso a ela.");
    await click(within(confirm).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "skills.remove")).toBe(true);
    expect(screen().getByText("Revisão de PR removida.")).toBeTruthy();
  });

  test("Agentes melhoram as skills sozinhos: the workspace's switch, a skill's own, and Desfazer for an agent's change", async () => {
    const { state, section } = await settings();
    const all = within(section()).getByRole("switch", { name: "Agentes melhoram as skills sozinhos" });
    expect(all.getAttribute("aria-checked")).toBe("true");
    await click(all);
    await settle(4);
    expect(state.calls.find((c) => c.method === "skills.saveSettings")?.args).toEqual([
      ORG_ID,
      { agentsImprove: false },
    ]);

    await click(within(section()).getByRole("button", { name: "Atendimento" }));
    await settle(4);
    const sheet = screen().getByRole("dialog", { name: "Atendimento" });
    expect(sheet.textContent).toContain("Ada mudou");
    await click(within(sheet).getByRole("button", { name: "Desfazer mudança" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "skills.undoUpdate")).toBe(true);
    const own = within(sheet).getByRole("switch", { name: "Agentes melhoram esta skill sozinhos" });
    expect(own.getAttribute("aria-checked")).toBe("false");
    await click(own);
    await settle(4);
    expect(state.calls.find((c) => c.method === "skills.update")?.args.at(-1)).toEqual({ agentsImprove: true });
  });

  test("a waiting update: what each side changed, who and when, the choice and its Desfazer either way", async () => {
    const { state, section } = await settings();
    await click(within(section()).getByRole("button", { name: "Revisão de PR" }));
    await settle(4);
    const sheet = () => screen().getByRole("dialog", { name: "Revisão de PR" });
    await click(within(sheet()).getByRole("button", { name: "Atualizar do link" }));
    await settle(6);
    const card = () => within(sheet()).getByRole("region", { name: "Atualização esperando" });
    expect(card().textContent).toContain("O link tem uma versão nova, e os agentes também mudaram esta skill");
    expect(card().textContent).toContain("Versão nova no link");
    expect(card().textContent).toContain("Ada mudou esta skill, a última vez");
    expect(card().textContent).toContain("Escolha qual versão fica. Dá para desfazer depois.");
    // Three ways to read it: what the agents changed, what the link changed, the skill now against the link.
    const tabs = within(card())
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
    expect(tabs).toEqual(["O que os agentes mudaram", "O que mudou no link", "Atual × link"]);
    const added = () => [...card().querySelectorAll(".ac-diff__line--add")].map((l) => l.textContent);
    expect(added()).toContain("+Adicionado: 2. Rode os testes.");
    await pickTab(within(card()).getByRole("tab", { name: "O que mudou no link" }));
    expect(added()).toContain("+Adicionado: 2. Rode o lint.");
    // The file that runs, changed, with its own diff.
    expect(card().querySelector(".skill-diff__file")?.textContent).toContain("scripts/lint.sh");
    expect(card().querySelector(".skill-diff__file")?.textContent).toContain("mudou");
    expect(added()).toContain("+Adicionado: biome check .");

    // Manter a dos agentes: said with Desfazer, and the sheet keeps a line with its own.
    await click(within(card()).getByRole("button", { name: "Manter a dos agentes" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "skills.dismissUpdate")).toBe(true);
    expect(screen().getByText("Revisão de PR continua com a versão dos agentes.")).toBeTruthy();
    expect(within(sheet()).queryByRole("region", { name: "Atualização esperando" })).toBeNull();
    expect(sheet().textContent).toContain("Ficou a versão dos agentes");
    await click(within(sheet()).getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "skills.reopenUpdate")).toBe(true);
    expect(screen().getByText("A atualização de Revisão de PR voltou a esperar.")).toBeTruthy();

    // Usar a versão do link: the link's text, a line with Desfazer that makes it wait again.
    await click(within(card()).getByRole("button", { name: "Usar a versão do link" }));
    await settle(4);
    expect(screen().getByText("Revisão de PR agora usa a versão do link.")).toBeTruthy();
    expect(sheet().textContent).toContain("Ficou a versão do link");
    expect(sheet().textContent).toContain("Rode o lint.");
    await click(within(sheet()).getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "skills.undoUpdate")).toHaveLength(1);
    expect(card().textContent).toContain("O link tem uma versão nova");

    // The library says it waits on both sides.
    await click(within(sheet()).getByRole("button", { name: "Fechar" }));
    await settle(4);
    const row = within(section()).getByRole("button", { name: "Revisão de PR" }).closest(".skill-row");
    expect(row?.textContent).toContain("Link e agentes mudaram");
  });

  test("the agents' changes: each with its diff opened in place, Desfazer on the newest; none, or the page failing", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const { section } = await settings(state, api);
    await click(within(section()).getByRole("button", { name: "Atendimento" }));
    await settle(4);
    const sheet = () => screen().getByRole("dialog", { name: "Atendimento" });
    const history = () => within(sheet()).getByRole("region", { name: "Mudanças dos agentes" });
    expect(history().textContent).toContain("Ada mudou");
    const show = within(history()).getByRole("button", { name: "Ver mudança" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    await click(show);
    expect(within(history()).getByRole("button", { name: "Esconder mudança" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect([...history().querySelectorAll(".ac-diff__line--add")].map((l) => l.textContent)).toEqual([
      "+Adicionado: Seja breve e cordial.",
    ]);
    await click(within(history()).getByRole("button", { name: "Desfazer mudança" }));
    await settle(4);
    expect(history().textContent).toContain("desfeita");
    expect(within(history()).queryByRole("button", { name: "Desfazer mudança" })).toBeNull();
    await click(within(sheet()).getByRole("button", { name: "Fechar" }));
    await settle(4);

    await click(within(section()).getByRole("button", { name: "Relatório semanal" }));
    await settle(4);
    const empty = screen().getByRole("dialog", { name: "Relatório semanal" });
    expect(within(empty).getByRole("region", { name: "Mudanças dos agentes" }).textContent).toContain(
      "Nenhum agente mudou esta skill ainda.",
    );
    await click(within(empty).getByRole("button", { name: "Fechar" }));
    await settle(4);

    api.skills.get = async () => {
      throw new Error("offline");
    };
    // One not opened before: nothing to show but why, and a way to try again.
    await click(within(section()).getByRole("button", { name: "Revisão de PR" }));
    await settle(6);
    const failed = screen().getByRole("dialog", { name: "Skills" });
    expect(failed.textContent).toContain("Não foi possível carregar");
    expect(within(failed).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  test("Instalar skill: GitHub link, .zip and Escrever", async () => {
    const { state, section } = await settings();
    await click(within(section()).getByRole("button", { name: "Instalar skill" }));
    let dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    await type(within(dialog).getByRole("textbox", { name: "Link do GitHub" }), "nao-e-link");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    expect(dialog.textContent).toContain("Use um link do GitHub");
    await type(
      within(dialog).getByRole("textbox", { name: "Link do GitHub" }),
      "https://github.com/acme/skills/tree/main/deploy",
    );
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "skills.import")?.args[1]).toEqual({
      url: "https://github.com/acme/skills/tree/main/deploy",
    });
    // The new skill opens.
    expect(screen().getByRole("dialog", { name: "deploy" })).toBeTruthy();
    await click(within(screen().getByRole("dialog", { name: "deploy" })).getByRole("button", { name: "Fechar" }));
    await settle(2);

    await click(within(section()).getByRole("button", { name: "Instalar skill" }));
    dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    await pickTab(within(dialog).getByRole("tab", { name: "Enviar .zip" }));
    // What the .zip holds, nothing about its scripts: they can run on the agent's computer, as its sheet says.
    expect(within(dialog).getByText(/^Um \.zip/).textContent).toBe("Um .zip com o SKILL.md na raiz.");
    expect(dialog.querySelector('input[type="file"]')?.className).toContain("ac-visually-hidden");
    const file = new File([new Uint8Array([80, 75, 3, 4])], "suporte.zip", { type: "application/zip" });
    await act(async () => {
      fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    });
    expect(dialog.textContent).toContain("suporte.zip");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    const zip = state.calls.filter((c) => c.method === "skills.import").at(-1)?.args[1] as { zipBase64: string };
    expect(zip.zipBase64).toBe(btoa(String.fromCharCode(80, 75, 3, 4)));
    await click(
      within(screen().getByRole("dialog", { name: "Skill enviada" })).getByRole("button", { name: "Fechar" }),
    );
    await settle(2);

    await click(within(section()).getByRole("button", { name: "Instalar skill" }));
    dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    await pickTab(within(dialog).getByRole("tab", { name: "Escrever" }));
    await type(within(dialog).getByLabelText("Nome"), "Deploy seguro");
    await type(within(dialog).getByLabelText("Quando usar"), "Antes de qualquer deploy.");
    await type(within(dialog).getByLabelText("Instruções (Markdown)"), "# Deploy\n\n1. Confira o CI.");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "skills.create")?.args[1]).toMatchObject({ name: "Deploy seguro" });
  });

  test("Instalar skill: a repository holding several skills lists them to pick; GitHub's refusals in words", async () => {
    const { state, section } = await settings();
    await click(within(section()).getByRole("button", { name: "Instalar skill" }));
    const dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    const link = within(dialog).getByRole("textbox", { name: "Link do GitHub" });
    await type(link, "https://github.com/acme/secret");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(dialog.textContent).toContain("acme/secret parece privado ou não existe.");

    await type(link, "https://github.com/acme/skills");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    // Nothing installed yet: each skill by name and what it is for, and the one that can't be installed with why.
    expect(dialog.textContent).toContain("Este link tem 4 skills. Escolha quais instalar.");
    expect(dialog.textContent).toContain("Revisa um pull request.");
    const skipped = within(dialog).getByRole("checkbox", { name: /claude-api/ });
    expect(skipped.hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).toContain("Não dá para instalar. A descrição precisa ter de 1 a 1024 caracteres.");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    expect(dialog.textContent).toContain("Escolha pelo menos uma skill.");
    await click(within(dialog).getByRole("checkbox", { name: /deploy/ }));
    await click(within(dialog).getByRole("checkbox", { name: /triage/ }));
    expect(within(dialog).getByRole("checkbox", { name: "Todas" }).getAttribute("aria-checked")).toBe("mixed");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "skills.importPicked")?.args.slice(1)).toEqual([
      "https://github.com/acme/skills",
      ["skills/deploy", "skills/triage"],
    ]);
    expect(screen().getByText("2 skills instaladas.")).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Instalar skill" })).toBeNull();
  });

  test("long libraries: 'Ver todas' opens a search dialog", async () => {
    const { state, api } = await withExtras(5);
    const { section } = await settings(state, api);
    await click(within(section()).getByRole("button", { name: "Ver todas as 8 skills" }));
    const dialog = screen().getByRole("dialog", { name: "Skills" });
    await type(within(dialog).getByRole("searchbox", { name: "Buscar skill" }), "extra 3");
    expect(
      within(dialog)
        .getAllByRole("button", { name: /Extra/ })
        .map((b) => b.textContent),
    ).toEqual(["Extra 3"]);
  });

  test("members don't see the library", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const { api } = await settings(state);
    expect(screen().queryByRole("region", { name: "Skills" })).toBeNull();
    expect(api).toBeTruthy();
  });
});

describe("Instalar skill: private repositories", () => {
  const CONTOSO = "https://github.com/contoso/skills";
  const repos = {
    connected: true,
    accounts: [
      {
        login: "contoso",
        type: "Organization",
        repositories: [
          { fullName: "contoso/skills", owner: "contoso", name: "skills", private: true, updatedAt: null },
          { fullName: "contoso/site", owner: "contoso", name: "site", private: false, updatedAt: null },
        ],
      },
    ],
    truncated: false,
  };
  const openInstall = async (state = seedState()) => {
    const { section } = await settings(state);
    await click(within(section()).getByRole("button", { name: "Instalar skill" }));
    await settle(4);
    return { state, dialog: () => screen().getByRole("dialog", { name: "Instalar skill" }) };
  };
  const install = async (dialog: HTMLElement, url: string) => {
    await type(within(dialog).getByRole("textbox", { name: "Link do GitHub" }), url);
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
  };

  /** After connecting GitHub, as from Conectores: its confirmation, then under Ajustar what it does and who uses it. */
  const finishConnecting = async () => {
    await click(
      within(screen().getByRole("dialog", { name: "GitHub conectado" })).getByRole("button", { name: "Ajustar" }),
    );
    await settle(4);
    await click(
      within(screen().getByRole("dialog", { name: "O que GitHub faz" })).getByRole("button", { name: "Continuar" }),
    );
    await settle(6);
    await click(
      within(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).getByRole("button", { name: "Liberar" }),
    );
    await settle(6);
    expect(screen().queryByRole("dialog", { name: "Quem pode usar GitHub" })).toBeNull();
  };

  test("none of the workspace's GitHub reads it: Conectar o GitHub, the link read again once connected, then what GitHub does and who uses it", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const state = seedState();
    state.connections = [];
    const { dialog } = await openInstall(state);
    await install(dialog(), CONTOSO);
    expect(dialog().textContent).toContain(
      "contoso/skills parece privado ou não existe. Conecte o GitHub para ler repositórios privados.",
    );
    // Said once, in the dialog: no toast repeating it in other words.
    expect(document.body.textContent).not.toContain("é privado ou não existe no GitHub");
    await click(within(dialog()).getByRole("button", { name: "Conectar o GitHub" }));
    await settle(2);
    const flow = () => screen().getByRole("dialog", { name: "Conectar GitHub" });
    // Signing in on GitHub comes back to Skills with the link, not to Conectores.
    await click(within(flow()).getByRole("button", { name: "Continuar no GitHub" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")?.args[2]).toEqual({
      returnTo: `/org/${ORG_ID}/settings/skills?install=${encodeURIComponent(CONTOSO)}`,
      serverUrl: undefined,
    });
    expect(left[0]).toStartWith("https://github.com/login/oauth/authorize");

    // A token instead: connected in place and the link read again to pick, while the flow goes on to its tools and
    // who uses them, as from Conectores.
    state.githubRepos = repos;
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_fake_token_for_tests");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(8);
    expect(state.calls.filter((c) => c.method === "skills.import").at(-1)?.args[1]).toEqual({
      url: CONTOSO,
      list: true,
    });
    await finishConnecting();
    expect(dialog().textContent).toContain("Lido pela conexão do GitHub do workspace.");
    expect(dialog().textContent).toContain("Este link tem 4 skills. Escolha quais instalar.");
    // GitHub's own mark leads the line.
    expect(dialog().querySelector(".skill-via .connector-icon__mark")).not.toBeNull();
    // What the new connection reaches shows at once: another link offers to pick from it.
    await type(within(dialog()).getByRole("textbox", { name: "Link do GitHub" }), "https://github.com/acme/skills");
    await settle(4);
    expect(within(dialog()).getByRole("button", { name: "Escolher do GitHub conectado" })).toBeTruthy();
  });

  test("someone who may install skills but not manage connectors is told whom to ask, GitHub connected or not", async () => {
    const asMember = () => {
      const state = seedState();
      const me = state.me?.organizations[0];
      if (me) Object.assign(me, { role: "member", permissions: ["read", "manage_agents"] });
      return state;
    };
    const none = asMember();
    none.connections = [];
    const { dialog } = await openInstall(none);
    await install(dialog(), CONTOSO);
    expect(dialog().textContent).toContain(
      "contoso/skills parece privado ou não existe. Peça a quem administra os conectores para conectar o GitHub.",
    );
    expect(within(dialog()).queryByRole("button", { name: "Conectar o GitHub" })).toBeNull();
    cleanup();

    // GitHub connected, and it can't see the repository: access is given on GitHub, by whoever runs the connectors.
    const { dialog: again } = await openInstall(asMember());
    await install(again(), "https://github.com/acme/secret");
    expect(again().textContent).toContain(
      "acme/secret parece privado ou não existe. O GitHub conectado também não chega a ele. Peça a quem administra os conectores para liberar o acesso.",
    );
    expect(within(again()).queryByRole("button", { name: "Conectar o GitHub" })).toBeNull();
  });

  test("a connection GitHub refuses offers to connect it again; one that works and can't see the repository, to give it access", async () => {
    const state = seedState();
    state.refusedGithub = "conn-gh";
    const { dialog } = await openInstall(state);
    await install(dialog(), CONTOSO);
    expect(dialog().textContent).toContain(
      "contoso/skills parece privado ou não existe. O GitHub recusou a conexão do workspace. Conecte o GitHub de novo.",
    );
    await click(within(dialog()).getByRole("button", { name: "Conectar o GitHub" }));
    await settle(2);
    // Connecting again keeps what the agents have.
    expect(screen().getByRole("dialog", { name: "Conectar GitHub" }).textContent).toContain(
      "Substitui o login atual. Quem usa continua igual.",
    );
    cleanup();

    const { dialog: again } = await openInstall();
    await install(again(), "https://github.com/acme/secret");
    expect(again().textContent).toContain(
      "acme/secret parece privado ou não existe. O GitHub conectado também não chega a ele. Libere o acesso no GitHub para a conta conectada.",
    );
    expect(within(again()).queryByRole("button", { name: "Conectar o GitHub" })).toBeNull();
  });

  test("Escolher do GitHub conectado: a search over its repositories, the skills of the one picked, then Install", async () => {
    const state = seedState();
    state.githubRepos = repos;
    const { dialog } = await openInstall(state);
    await click(within(dialog()).getByRole("button", { name: "Escolher do GitHub conectado" }));
    await settle(4);
    await type(within(dialog()).getByRole("searchbox", { name: "Buscar repositório" }), "sk");
    const rows = within(dialog())
      .getAllByRole("button")
      .filter((b) => b.classList.contains("ac-row"));
    expect(rows.map((r) => r.textContent)).toEqual(["contoso/skillsPrivado"]);
    await click(rows[0] as HTMLElement);
    await settle(6);
    expect(state.calls.find((c) => c.method === "skills.import")?.args[1]).toEqual({ url: CONTOSO, list: true });
    expect((within(dialog()).getByRole("textbox", { name: "Link do GitHub" }) as HTMLInputElement).value).toBe(CONTOSO);
    expect(dialog().textContent).toContain("Lido pela conexão do GitHub do workspace.");
    await click(within(dialog()).getByRole("checkbox", { name: /deploy/ }));
    await click(within(dialog()).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "skills.importPicked")?.args.slice(1)).toEqual([
      CONTOSO,
      ["skills/deploy"],
    ]);
    // The skill's sheet says where it came from and how.
    const sheet = screen().getByRole("dialog", { name: "deploy" });
    expect(sheet.textContent).toContain("Do repositório privado, pela conexão do GitHub do workspace.");

    // A token GitHub no longer takes: updating says it as Instalar skill does, once.
    state.refusedGithub = "conn-gh";
    await click(within(sheet).getByRole("button", { name: "Atualizar do link" }));
    await settle(6);
    expect(document.body.textContent).toContain(
      "contoso/skills parece privado ou não existe. O GitHub recusou a conexão do workspace. Conecte o GitHub de novo.",
    );
    expect(document.body.textContent).not.toContain("é privado ou não existe no GitHub");

    // Disconnected: updating says the connection that read it is gone.
    state.connections = [];
    await click(within(sheet).getByRole("button", { name: "Atualizar do link" }));
    await settle(6);
    expect(document.body.textContent).toContain(
      "A conexão do GitHub que lia contoso/skills não existe mais. Conecte o GitHub de novo para atualizar esta skill.",
    );
  });

  test("back from signing in on GitHub (`?install=`): the dialog opens on the link, reads it to pick, and the flow goes on", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const folder = `${CONTOSO}/tree/main/skills/deploy`;
    // As development runs it, every effect twice: the link is read once and stays in its field.
    await renderApp(`/org/${ORG_ID}/settings/skills?install=${encodeURIComponent(folder)}&connected=github`, {
      api,
      strict: true,
    });
    await settle(8);
    expect(state.calls.filter((c) => c.method === "skills.import").map((c) => c.args[1])).toEqual([
      { url: folder, list: true },
    ]);
    // Signing in ends where connecting with a key does: GitHub's confirmation.
    await finishConnecting();
    const dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    expect((within(dialog).getByRole("textbox", { name: "Link do GitHub" }) as HTMLInputElement).value).toBe(folder);
    // A folder's one skill, to check before it installs.
    expect(dialog.textContent).toContain("Lido pela conexão do GitHub do workspace.");
    expect(dialog.textContent).toContain("Este link tem 1 skill. Marque para instalar.");
    expect(state.calls.some((c) => c.method === "skills.importPicked")).toBe(false);
  });

  test("back with the agent whose card opened it: its box again, only when this tab opened that card", async () => {
    const folder = `${CONTOSO}/tree/main/skills/deploy`;
    const back = `/org/${ORG_ID}/settings/skills?install=${encodeURIComponent(folder)}&agent=${ADA_ID}`;
    const box = () =>
      within(screen().getByRole("dialog", { name: "Instalar skill" })).queryByRole("checkbox", {
        name: "Fica ligada para Ada",
      });
    sessionStorage.removeItem("agentes.skills.installFor");
    await renderApp(back, { api: createFakeApi(seedState()) });
    await settle(8);
    // A link to Skills that only names an agent turns nothing on for it.
    expect(box()).toBeNull();
    cleanup();
    sessionStorage.setItem("agentes.skills.installFor", JSON.stringify({ url: folder, agentId: ADA_ID }));
    await renderApp(back, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(box()?.getAttribute("aria-checked")).toBe("true");
    expect(sessionStorage.getItem("agentes.skills.installFor")).toBeNull();
  });
});

describe("agent skills", () => {
  test("Ferramentas e acesso: the library as checkboxes; a change waits for Salvar and sends every skill", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
    await settle(8);
    const section = screen().getByRole("region", { name: "Skills" });
    expect(
      within(section)
        .getByRole("checkbox", { name: /Revisão de PR/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(section)
        .getByRole("checkbox", { name: /Atendimento/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await click(within(section).getByRole("checkbox", { name: /Atendimento/ }));
    expect(state.calls.find((c) => c.method === "skills.setForAgent")).toBeUndefined();
    expect(section.textContent).toContain("Antes: 1 ligada");
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(6);
    const set = state.calls.find((c) => c.method === "skills.setForAgent")?.args;
    expect(set?.[1]).toBe(ADA_ID);
    const sent = set?.[2] as { skillId: string; enabled: boolean }[];
    expect(sent).toHaveLength(3);
    expect(sent.filter((x) => x.enabled)).toHaveLength(2);
    expect(
      within(screen().getByRole("region", { name: "Skills" }))
        .getByRole("checkbox", { name: /Atendimento/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("Ferramentas e acesso: past 6 skills a search that only hides pills; a skill switched on stays on", async () => {
    const { state, api } = await withExtras(3);
    const { services } = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(8);
    const section = () => screen().getByRole("region", { name: "Skills" });
    const pills = () => [...section().querySelectorAll(".ac-pill")].map((p) => p.textContent);
    const checked = (name: RegExp) => within(section()).getByRole("checkbox", { name }).getAttribute("aria-checked");
    const saveBar = () => screen().queryByRole("region", { name: "Alterações não salvas" });
    // Six skills: the pills alone, as before.
    expect(pills()).toHaveLength(6);
    expect(within(section()).queryByRole("searchbox")).toBeNull();

    const seventh = await api.skills.create(ORG_ID, { name: "Extra 4", description: "x", body: "# x" });
    await act(() => services.queryClient.invalidateQueries());
    await settle(4);
    const search = within(section()).getByRole("searchbox", { name: "Buscar skill" }) as HTMLInputElement;
    await type(search, "extra 4");
    expect(pills()).toEqual(["Extra 4"]);
    // Typing switches nothing on.
    expect(checked(/Extra 4/)).toBe("false");
    expect(saveBar()).toBeNull();

    await click(within(section()).getByRole("checkbox", { name: /Extra 4/ }));
    // Accents don't matter. Extra 4 is hidden now, and still on.
    await type(search, "relatorio");
    expect(pills()).toEqual(["Relatório semanal"]);
    // Names only: Atendimento's description ("respostas") doesn't bring its pill back.
    await type(search, "re");
    expect(pills()).toEqual(["Revisão de PR", "Relatório semanal"]);
    await type(search, "nada assim");
    expect(pills()).toEqual([]);
    expect(section().textContent).toContain("Nenhuma skill com “nada assim”.");
    await click(within(section()).getByRole("button", { name: "Limpar busca" }));
    expect(search.value).toBe("");
    expect(pills()).toHaveLength(7);
    expect(checked(/Extra 4/)).toBe("true");
    expect(checked(/Revisão de PR/)).toBe("true");
    expect(section().textContent).toContain("Antes: 1 ligada");

    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    const sent = state.calls.find((c) => c.method === "skills.setForAgent")?.args[2] as {
      skillId: string;
      enabled: boolean;
    }[];
    expect(sent).toHaveLength(7);
    const on = sent.filter((x) => x.enabled).map((x) => x.skillId);
    expect(on).toHaveLength(2);
    expect(on).toContain(seventh.id);
  });

  test("Criar agente: optional Skills under the tools, the ones on for new agents already checked", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/new`, { api: createFakeApi(state) });
    await settle(8);
    await startAs("QA");
    await proceed(2);
    const step = screen().getByRole("region", { name: /^Skills/ });
    // Three skills: no search.
    expect(within(step).queryByRole("searchbox")).toBeNull();
    // "Ligar em agentes novos" skills start checked.
    expect(
      within(step)
        .getByRole("checkbox", { name: /Relatório semanal/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(step).getByRole("checkbox", { name: /Atendimento/ }));
    expect(screen().getByRole("complementary", { name: "Prévia do agente" }).textContent).toContain("Atendimento");
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const sent = state.calls.find((c) => c.method === "skills.setForAgent")?.args[2] as {
      skillId: string;
      enabled: boolean;
    }[];
    expect(sent.filter((x) => x.enabled)).toHaveLength(2);
  });
});

describe("activity bar: load_skill", () => {
  test("names the skill when it can; otherwise 'consultando uma skill'", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    expect(toolActivity("load_skill", null, "Revisão de PR")).toEqual({ kind: "openingSkill", app: "Revisão de PR" });
    expect(toolActivity("load_skill")).toEqual({ kind: "consultingSkill" });
    expect(
      activityText(t, [
        { id: "a", type: "agent", name: "Theo", activity: toolActivity("load_skill", null, "Revisão de PR") },
      ]),
    ).toBe("Theo está abrindo a skill Revisão de PR…");
    expect(activityText(t, [{ id: "a", type: "agent", name: "Theo", activity: toolActivity("load_skill") }])).toBe(
      "Theo está consultando uma skill…",
    );
  });
});
