import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AccessInput } from "@agenteschat/client";
import {
  asksAt,
  inputWithLevels,
  levelIn,
  levelOf,
  levelsOf,
  nextLevel,
  resourcesOf,
  toolsAt,
} from "@agenteschat/client/lib/access-levels";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { fakeAccessTree } from "./fakes/access";
import { proceed, startAs } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const conns = [
  {
    id: "conn-gh",
    connector: "github",
    label: "GitHub",
    accountLabel: "acme",
    authType: "oauth",
    serverUrl: null,
    createdAt: "",
    revokedAt: null,
  },
] as never;
const input = (over: Partial<AccessInput> = {}): AccessInput => ({
  all: false,
  connectors: {},
  scopes: [],
  tools: { allow: [], deny: [] },
  ...over,
});
const gh = (name: string) => ({ connectionId: "conn-gh", name });
const builtin = (scope: string) => ({ connectionId: null, scope });

describe("one level per connector and built-in area", () => {
  test("resources come from the tree: connectors first, then the built-in areas with the levels they offer", () => {
    const access = fakeAccessTree(input({ scopes: [builtin("context:read"), builtin("memory:write")] }), conns);
    const resources = resourcesOf(access);
    expect(resources.map((r) => [r.id, r.levels.join("/")])).toEqual([
      ["connector:conn-gh", "none/read/write"],
      ["area:context", "none/read/write"],
      ["area:drive", "none/write"],
      ["area:issues", "none/write"],
      ["area:calendar", "none/write"],
      ["area:skills", "none/read"],
    ]);
    const github = resources[0];
    if (!github) throw new Error("github");
    expect(github.readScopes).toEqual(["github:repo.read"]);
    // "Ler" gives the read tools; "Ler e escrever" everything, and merge still asks.
    expect(toolsAt(github, "read").map((t) => t.name)).toEqual(["github_list_pull_requests"]);
    expect(asksAt(github, "read")).toEqual([]);
    expect(asksAt(github, "write").map((t) => t.name)).toEqual(["github_merge_pull_request"]);
    expect(levelsOf(access)).toMatchObject({
      "connector:conn-gh": "none",
      "area:context": "write",
      "area:drive": "none",
    });
  });

  test("the level from the grants: read scopes = Ler, the connection = Ler e escrever, anything else = custom", () => {
    expect(
      levelIn(
        fakeAccessTree(input({ scopes: [{ connectionId: "conn-gh", scope: "github:repo.read" }] }), conns),
        "connector:conn-gh",
      ),
    ).toBe("read");
    expect(levelIn(fakeAccessTree(input({ connectors: { "conn-gh": true } }), conns), "connector:conn-gh")).toBe(
      "write",
    );
    // One tool on its own (older editors), or a denial: custom until someone picks a level.
    const one = fakeAccessTree(input({ tools: { allow: [gh("github_create_pull_request")], deny: [] } }), conns);
    expect(levelIn(one, "connector:conn-gh")).toBe("custom");
    const denied = fakeAccessTree(
      input({ connectors: { "conn-gh": true }, tools: { allow: [], deny: [gh("github_merge_pull_request")] } }),
      conns,
    );
    expect(levelIn(denied, "connector:conn-gh")).toBe("custom");
    // "All tools": every connector and area is Ler e escrever (or its top level).
    const all = fakeAccessTree(input({ all: true }), conns);
    expect(levelsOf(all)).toMatchObject({ "connector:conn-gh": "write", "area:drive": "write", "area:skills": "read" });
    expect(levelIn(undefined, "connector:conn-gh")).toBe("none");
  });

  test("a matrix click cycles through the levels a resource has", () => {
    const resources = resourcesOf(fakeAccessTree(input(), conns));
    const by = (id: string) => resources.find((r) => r.id === id) ?? { levels: [] };
    expect(nextLevel(by("connector:conn-gh"), "none")).toBe("read");
    expect(nextLevel(by("connector:conn-gh"), "read")).toBe("write");
    expect(nextLevel(by("connector:conn-gh"), "write")).toBe("none");
    expect(nextLevel(by("connector:conn-gh"), "custom")).toBe("read");
    expect(nextLevel(by("area:drive"), "none")).toBe("write");
    expect(nextLevel(by("area:skills"), "read")).toBe("none");
  });

  test("setting a level replaces that resource's grants and keeps the rest", () => {
    const access = fakeAccessTree(
      input({
        scopes: [builtin("memory:write")],
        tools: { allow: [gh("github_create_pull_request")], deny: [gh("github_merge_pull_request")] },
      }),
      conns,
    );
    const raw = [{ connectionId: "gone", scope: "github:repo.read" }];
    const read = inputWithLevels(access, raw, { "connector:conn-gh": "read" });
    expect(read).toEqual({
      all: false,
      connectors: {},
      scopes: [builtin("memory:write"), { connectionId: "conn-gh", scope: "github:repo.read" }],
      tools: { allow: [], deny: [] },
    });
    const write = inputWithLevels(access, raw, { "connector:conn-gh": "write" });
    expect(write.connectors).toEqual({ "conn-gh": true });
    expect(write.scopes.filter((s) => s.connectionId === "conn-gh")).toEqual([]);
    const none = inputWithLevels(access, raw, { "connector:conn-gh": "none" });
    expect(none.tools).toEqual({ allow: [], deny: [] });
    // Built-in areas: their scopes.
    expect(inputWithLevels(access, [], { "area:drive": "write" }).scopes).toContainEqual(builtin("drive:write"));
    expect(inputWithLevels(access, [], {})).toEqual(inputWithLevels(access, [], { "area:unknown": "write" }));
  });

  test("lowering one resource under 'all tools' spells the others out, so nothing else changes", () => {
    const access = fakeAccessTree(
      input({ all: true, tools: { allow: [], deny: [gh("github_merge_pull_request")] } }),
      conns,
    );
    const put = inputWithLevels(access, [], { "area:drive": "none" });
    expect(put.all).toBe(false);
    expect(put.scopes.map((s) => s.scope).sort()).toEqual([
      "calendar:write",
      "context:read",
      "issues:write",
      "memory:write",
      "skills:read",
    ]);
    // GitHub had a denial (custom): kept tool by tool.
    expect(put.connectors).toEqual({});
    expect(put.tools.allow).toEqual([gh("github_list_pull_requests"), gh("github_create_pull_request")]);
    expect(put.tools.deny).toEqual([gh("github_merge_pull_request")]);
    const after = fakeAccessTree(put, conns);
    expect(levelsOf(after)).toMatchObject({
      "connector:conn-gh": "custom",
      "area:context": "write",
      "area:drive": "none",
      "area:skills": "read",
    });
    expect(levelOf(resourcesOf(after)[0] as never)).toBe("custom");
  });
});

describe("Configurações → Agentes e acesso: the matrix", () => {
  const goAccess = async (state = seedState()) => {
    await renderApp(`/org/${ORG_ID}/settings/access`, { api: createFakeApi(state) });
    await settle(8);
    return within(screen().getByRole("region", { name: "Acesso dos agentes" }));
  };

  test("agents × connectors; a click cycles Sem acesso → Ler → Ler e escrever and saves right away", async () => {
    const state = seedState();
    const section = await goAccess(state);
    expect(section.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Agente", "GitHub"]);
    const rows = section.getAllByRole("rowheader").map((h) => h.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Ada · Dev");
    expect(rows[1]).toContain("Atlas · Ops");
    await click(section.getByRole("button", { name: "Ada em GitHub: Sem acesso" }));
    await settle(6);
    const puts = () => state.calls.filter((c) => c.method === "access.set");
    expect(puts().map((c) => c.args[1])).toEqual([ADA_ID]);
    const read = puts().at(-1)?.args[2] as AccessInput;
    expect(read.scopes).toContainEqual({ connectionId: "conn-gh", scope: "github:repo.read" });
    expect(read.connectors["conn-gh"]).toBeUndefined();
    // Ler e escrever: the whole connection; the lock says merge still asks.
    await click(section.getByRole("button", { name: "Ada em GitHub: Ler" }));
    await settle(6);
    const whole = puts().at(-1)?.args[2] as AccessInput;
    expect(whole.connectors["conn-gh"]).toBe(true);
    const write = section.getByRole("button", {
      name: "Ada em GitHub: Ler e escrever, ações sensíveis pedem aprovação",
    });
    expect(write.getAttribute("data-level")).toBe("write");
    await click(write);
    await settle(6);
    const none = puts().at(-1)?.args[2] as AccessInput;
    expect(none.connectors).toEqual({});
    expect(none.scopes.some((s) => s.connectionId === "conn-gh")).toBe(false);
    // Atlas was never touched.
    expect(section.getByRole("button", { name: "Atlas em GitHub: Sem acesso" })).toBeTruthy();
  });

  test("an agent's long name and role wrap beside its face, so its levels stay in the table", async () => {
    const state = seedState();
    const atlas = state.agents.find((a) => a.name === "Atlas");
    if (atlas) {
      atlas.name = "Atlas Monteiro de Albuquerque Figueiredo";
      atlas.role = "Operações de infraestrutura, implantações e plantão de fim de semana";
    }
    const section = await goAccess(state);
    const head = section.getAllByRole("rowheader")[1]?.querySelector(".level-matrix__agent") as HTMLElement;
    expect(head.classList.contains("ac-iconline")).toBe(true);
    expect(head.textContent).toContain("Atlas Monteiro de Albuquerque Figueiredo · Operações de infraestrutura");
    expect(section.getByRole("button", { name: /^Atlas Monteiro de Albuquerque Figueiredo em GitHub/ })).toBeTruthy();
  });

  test("built-in areas in the same matrix: their own levels", async () => {
    const state = seedState();
    const section = await goAccess(state);
    await click(section.getByRole("radio", { name: "Nativos" }));
    expect(section.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Agente",
      "Contexto e memória",
      "Drive",
      "Tarefas",
      "Agenda",
      "Skills",
    ]);
    expect(section.getByRole("button", { name: "Atlas em Skills: Ler" })).toBeTruthy();
    await click(section.getByRole("button", { name: "Atlas em Drive: Sem acesso" }));
    await settle(6);
    const put = state.calls.filter((c) => c.method === "access.set").at(-1);
    expect(put?.args[1]).toBe(ATLAS_ID);
    const drive = put?.args[2] as AccessInput;
    expect(drive.scopes).toContainEqual(builtin("drive:write"));
    expect(section.getByRole("button", { name: "Atlas em Drive: Ler e escrever" })).toBeTruthy();
  });

  test("how to use it opens the legend; the approval rule is the title's ⓘ", async () => {
    const section = await goAccess();
    const legend = document.querySelector(".level-legend") as HTMLElement;
    expect(legend.firstElementChild?.textContent).toBe("Clique numa célula para trocar:");
    expect(legend.textContent).toBe("Clique numa célula para trocar:Sem acessoLerLer e escreverpede aprovação");
    const about = section.getByRole("button", { name: "Sobre Acesso dos agentes" });
    expect(document.getElementById(about.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Ações sensíveis (merge, deploy, compartilhar, pagar) sempre pedem aprovação, em qualquer nível. Para ajustar ferramenta por ferramenta, abra Ferramentas no conector.",
    );
    // The heading keeps its own name; nothing else is said above the table.
    expect(section.getByRole("heading", { level: 2 }).textContent).toBe("Acesso dos agentes");
    expect(document.querySelector("#sec-access")?.closest(".ac-card")?.querySelector("p.small")).toBeNull();
  });

  test("with no cells to click, no legend: only the line that says why", async () => {
    const state = seedState();
    state.connections = [];
    const section = await goAccess(state);
    expect(section.getByText("Escolha o que cada agente pode usar")).toBeTruthy();
    expect(document.querySelector(".level-legend")).toBeNull();
    // The built-in areas are always there: their table brings the legend back.
    await click(section.getByRole("radio", { name: "Nativos" }));
    expect(section.getAllByRole("columnheader").length).toBeGreaterThan(1);
    expect(document.querySelector(".level-legend")?.firstElementChild?.textContent).toBe(
      "Clique numa célula para trocar:",
    );
  });

  test("members don't see it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await renderApp(`/org/${ORG_ID}/settings/access`, { api: createFakeApi(state) });
    await settle(6);
    expect(screen().queryByRole("region", { name: "Acesso dos agentes" })).toBeNull();
  });
});

describe("Criar agente → connector levels", () => {
  /** Opens "Criar agente" as QA (reads GitHub) and goes to "Ferramentas e acesso". */
  const toTools = async (state = seedState()) => {
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/agents/new`, { api });
    await settle(8);
    await startAs("QA");
    await proceed(2);
    return api;
  };
  const githubLevels = () =>
    within(screen().getByRole("list", { name: "Conectores e níveis" })).getByRole("radiogroup", {
      name: "Nível em GitHub",
    });

  test("the levels chosen for the connectors survive creation (nothing written afterwards replaces them)", async () => {
    const state = seedState();
    const api = await toTools(state);
    const github = githubLevels();
    // QA starts reading GitHub.
    expect(within(github).getByRole("radio", { name: "Ler" }).getAttribute("aria-checked")).toBe("true");
    await click(within(github).getByRole("radio", { name: "Ler e escrever" }));
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const created = state.calls.find((c) => c.method === "agents.create");
    expect(created).toBeTruthy();
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts).toHaveLength(1);
    const agentId = puts[0]?.args[1] as string;
    const put = puts[0]?.args[2] as AccessInput;
    expect(put.connectors).toEqual({ "conn-gh": true });
    // The built-in defaults of a new agent stay.
    expect(put.scopes).toContainEqual(builtin("memory:write"));
    // No other write to the grants after it.
    expect(state.calls.some((c) => c.method === "scopes.set")).toBe(false);
    const saved = await api.access.get(ORG_ID, agentId);
    expect(levelIn(saved, "connector:conn-gh")).toBe("write");
  });

  test("a connector left at Sem acesso isn't granted", async () => {
    const state = seedState();
    await toTools(state);
    await click(within(githubLevels()).getByRole("radio", { name: "Sem acesso" }));
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(state.calls.some((c) => c.method === "agents.create")).toBe(true);
    expect(state.calls.some((c) => c.method === "access.set")).toBe(false);
  });
});
