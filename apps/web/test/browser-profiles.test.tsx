import { afterEach, expect, test } from "bun:test";
import type { BrowserProfile } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};

/** A self-hosted Linux computer with two profiles, one free and one Ada uses now; the profiles API in memory. */
function withProfiles(as: "owner" | "member" = "owner") {
  const state = seedState();
  if (as === "member") {
    const o = state.me?.organizations[0];
    if (o) o.role = "member";
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
  }
  state.scopes[ADA_ID] = [...(state.scopes[ADA_ID] ?? []), { connectionId: null, scope: "browser:use" }];
  const api = createFakeApi(state);
  const m = fakeMachinesOf.get(api)?.pair({ name: "Servidor", os: "linux" });
  if (!m) throw new Error("no machine");
  const now = new Date().toISOString();
  const profiles: BrowserProfile[] = [
    {
      id: "p-free",
      machineId: m.id,
      name: "Empresa A",
      createdAt: now,
      agentIds: [ATLAS_ID],
      holder: null,
      lastUsedAt: null,
    },
    {
      id: "p-busy",
      machineId: m.id,
      name: "Empresa B · WhatsApp vendas",
      createdAt: now,
      agentIds: [ADA_ID, ATLAS_ID],
      holder: { type: "agent", agentId: ADA_ID, since: now },
      lastUsedAt: now,
    },
  ];
  const calls: { method: string; args: unknown[] }[] = [];
  const log = (method: string, ...args: unknown[]) => calls.push({ method, args });
  api.browserProfiles = {
    list: async () => profiles.map((p) => ({ ...p })),
    create: async (_o, input) => {
      log("create", input);
      const p: BrowserProfile = { id: "p-new", createdAt: now, holder: null, lastUsedAt: null, ...input };
      profiles.push(p);
      return p;
    },
    update: async (_o, id, input) => {
      log("update", id, input);
      const p = profiles.find((x) => x.id === id) as BrowserProfile;
      Object.assign(p, input);
      return { ...p };
    },
    remove: async (_o, id) => {
      log("remove", id);
      profiles.splice(
        profiles.findIndex((x) => x.id === id),
        1,
      );
    },
    takeover: async (_o, id) => {
      log("takeover", id);
      const p = profiles.find((x) => x.id === id) as BrowserProfile;
      p.holder = { type: "person", userId: "u-walter", since: now };
      return { ...p };
    },
    handback: async (_o, id) => {
      log("handback", id);
      const p = profiles.find((x) => x.id === id) as BrowserProfile;
      p.holder = null;
      return { ...p };
    },
    open: async (_o, id, url) => {
      log("open", id, url);
    },
    setDefault: async (_o, agentId, profileId) => {
      log("setDefault", agentId, profileId);
      const s = fakeBrowserOf.get(api)?.settings.get(agentId);
      if (s) fakeBrowserOf.get(api)?.settings.set(agentId, { ...s, profileId });
    },
    request: async (_o, agentId) => {
      log("request", agentId);
    },
  };
  return { state, api, machine: m, calls };
}

test("Perfis do navegador: each row says Livre or who uses it, its agents and Fazer login; Assistir only while in use", async () => {
  const s = withProfiles();
  await renderApp(`/org/${ORG_ID}/settings/computers/${s.machine.id}`, { api: s.api });
  await settle(8);
  const card = screen().getByRole("heading", { name: "Perfis do navegador" }).closest(".ac-card") as HTMLElement;
  expect(card.textContent).toContain("Faça login nos sites uma vez e escolha quais agentes usam cada perfil.");
  const rows = [...card.querySelectorAll(".pf-list > .machine-page__agent-row")] as HTMLElement[];
  expect(rows.map((r) => r.querySelector(".machine-page__agent-name")?.textContent)).toEqual([
    "Empresa A",
    "Empresa B · WhatsApp vendas",
  ]);
  expect(rows[0]?.textContent).toContain("Livre");
  expect(rows[0]?.querySelector(".pf-count")?.textContent).toBe("1 agente");
  // "Em uso por Ada" with her face before her name.
  expect(rows[1]?.querySelector(".ac-who b")?.textContent).toBe("Ada");
  expect(rows[1]?.textContent).toContain("Em uso por Ada");
  expect(rows[1]?.querySelector(".pf-count")?.textContent).toBe("2 agentes");
  for (const row of rows) {
    expect(within(row).getByRole("button", { name: "Fazer login" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Assistir/ })).toBeNull();
  }
  const menuOf = async (row: HTMLElement, name: string) => {
    const trigger = within(row).getByRole("button", { name: `Mais ações de ${name}` });
    await act(async () => fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false }));
    await settle(2);
    return [...document.querySelectorAll(".ac-menu .ac-menu__item")].map((i) => i.textContent);
  };
  expect(await menuOf(rows[1] as HTMLElement, "Empresa B · WhatsApp vendas")).toEqual([
    "Assistir Ada",
    "Renomear",
    "Mudar quem pode usar",
    "Apagar perfil",
  ]);
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  await settle(2);
  expect(await menuOf(rows[0] as HTMLElement, "Empresa A")).toEqual([
    "Renomear",
    "Mudar quem pode usar",
    "Apagar perfil",
  ]);
  const remove = [...document.querySelectorAll(".ac-menu .ac-menu__item")].at(-1) as HTMLElement;
  await act(async () => fireEvent.click(remove));
  await settle(2);
  expect(screen().getByRole("dialog", { name: "Apagar o perfil Empresa A?" }).textContent).toContain(
    "1 agente perde o acesso. Não dá para desfazer.",
  );
});

test("an outdated computer says to update it instead of offering Novo perfil", async () => {
  const s = withProfiles();
  fakeMachinesOf.get(s.api)?.patch(s.machine.id, { browserProfiles: false });
  await renderApp(`/org/${ORG_ID}/settings/computers/${s.machine.id}`, { api: s.api });
  await settle(8);
  const card = screen().getByRole("heading", { name: "Perfis do navegador" }).closest(".ac-card") as HTMLElement;
  expect(card.textContent).toContain("Atualize o computador para usar perfis do navegador.");
  expect(within(card).queryByRole("button", { name: "Novo perfil" })).toBeNull();
});

test("Novo perfil: a name, who may use it and one note; Criar e fazer login creates it and takes control", async () => {
  const s = withProfiles();
  await renderApp(`/org/${ORG_ID}/settings/computers/${s.machine.id}`, { api: s.api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Novo perfil" }));
  const d = screen().getByRole("dialog", { name: "Novo perfil" });
  expect(d.querySelectorAll(".ac-setnote")).toHaveLength(1);
  expect(d.textContent).toContain(
    "Os agentes escolhidos usam as contas deste perfil como se fossem você. Depois de criar, você faz login nos sites uma vez.",
  );
  // Granted to nobody until chosen.
  for (const sw of within(d).getAllByRole("switch")) expect(sw.getAttribute("aria-checked")).toBe("false");
  await act(async () =>
    fireEvent.change(within(d).getByPlaceholderText("Empresa B · WhatsApp vendas"), { target: { value: "Empresa C" } }),
  );
  await click(within(d).getByRole("switch", { name: "Ada" }));
  await click(within(d).getByRole("button", { name: "Criar e fazer login" }));
  await settle(6);
  expect(s.calls.find((c) => c.method === "create")?.args[0]).toEqual({
    machineId: s.machine.id,
    name: "Empresa C",
    agentIds: [ADA_ID],
  });
  expect(s.calls.find((c) => c.method === "takeover")?.args).toEqual(["p-new"]);
});

test("the agent's browser: which profile Ada uses, the default tagged, and a member asks for one more", async () => {
  const s = withProfiles("member");
  const browser = fakeBrowserOf.get(s.api);
  await s.api.sandbox.setTarget(ORG_ID, ADA_ID, s.machine.id);
  browser?.settings.set(ADA_ID, {
    allowedDomains: null,
    available: true,
    reason: null,
    detail: null,
    machine: { id: s.machine.id, name: "Servidor" },
    profileId: "p-busy",
  });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: s.api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Mudar o navegador" }));
  const d = screen().getByRole("dialog", { name: "A Ada pode navegar em sites?" });
  expect(d.textContent).not.toContain("fica com o login");
  const choice = within(d).getByRole("radiogroup", { name: "Qual perfil do navegador a Ada usa?" });
  const rows = within(choice).getAllByRole("radio");
  // Hers first, then the profiles she may use (Empresa A isn't one).
  expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.firstChild?.textContent)).toEqual([
    "Perfil da Ada",
    "Empresa B · WhatsApp vendas",
  ]);
  expect(rows[0]?.textContent).toContain("Só dela, com os logins que ela fizer");
  expect(rows[1]?.querySelector(".ac-optrow__tag")?.textContent).toBe("Padrão");
  expect(d.textContent).toContain("Um admin decide quais perfis a Ada pode usar.");
  await click(within(d).getByRole("button", { name: "Pedir mais um perfil" }));
  expect(s.calls.find((c) => c.method === "request")?.args).toEqual([ADA_ID]);
  await click(rows[0] as HTMLElement);
  await click(within(d).getByRole("button", { name: "Usar" }));
  await settle(6);
  expect(s.calls.find((c) => c.method === "setDefault")?.args).toEqual([ADA_ID, null]);
});

test("a system-mode computer (the Cloud's) has no Perfis do navegador, not even the update note", async () => {
  const s = withProfiles();
  fakeMachinesOf.get(s.api)?.patch(s.machine.id, { mode: "system", browserProfiles: false });
  await renderApp(`/org/${ORG_ID}/settings/computers/${s.machine.id}`, { api: s.api });
  await settle(8);
  expect(screen().getByRole("heading", { name: "Servidor" })).toBeTruthy();
  expect(screen().queryByRole("heading", { name: "Perfis do navegador" })).toBeNull();
  expect(document.body.textContent).not.toContain("Atualize o computador para usar perfis do navegador.");
});

test.each([
  ["a system-mode computer", { mode: "system" as const }],
  // The Cloud's computer still being prepared: no hello yet, so it reads single mode, but it's managed.
  ["the Cloud's computer before its first hello", { mode: "single" as const, kind: "managed" as const }],
])("the agent's browser on %s: no profile choice and no asking for one", async (_, machine) => {
  const s = withProfiles("member");
  fakeMachinesOf.get(s.api)?.patch(s.machine.id, machine);
  // The server lists no profile of a system-mode computer.
  if (s.api.browserProfiles) s.api.browserProfiles.list = async () => [];
  await s.api.sandbox.setTarget(ORG_ID, ADA_ID, s.machine.id);
  fakeBrowserOf.get(s.api)?.settings.set(ADA_ID, {
    allowedDomains: null,
    available: true,
    reason: null,
    detail: null,
    machine: { id: s.machine.id, name: "Servidor" },
    profileId: null,
  });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: s.api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Mudar o navegador" }));
  const d = screen().getByRole("dialog", { name: "A Ada pode navegar em sites?" });
  expect(within(d).queryByRole("radiogroup", { name: "Qual perfil do navegador a Ada usa?" })).toBeNull();
  expect(within(d).queryByRole("button", { name: "Pedir mais um perfil" })).toBeNull();
  expect(d.textContent).toContain("fica com o login");
});
