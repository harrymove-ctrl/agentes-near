import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, OrgSummary } from "@agenteschat/client";
import {
  audienceNotice,
  audienceSummary,
  canEditAudience,
  canTalk,
  listsAgent,
} from "@agenteschat/client/lib/audience";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { ADA_ID, ADMIN_ROLE_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedRoles, seedState } from "./fake-api";
import { proceed, startAs } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const typeIn = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  });
const go = async (path: string, state = seedState()) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
/** Ada answers only her owner (João); I am Walter. */
const onlyOwner = () => {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.audience = { mode: "owner", userIds: [] };
  return state;
};

describe("Quem pode falar com a Ada", () => {
  test("Configurações: everyone by default; Só algumas pessoas → pick → Salvar sends the audience", async () => {
    const state = await go(`agents/${ADA_ID}?tab=settings&sec=audience`);
    const section = screen().getByRole("region", { name: "Quem pode falar com a Ada" });
    const group = within(section).getByRole("radiogroup", { name: "Quem pode falar com a Ada" });
    expect(
      within(group)
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(group).getByRole("radio", { name: /^Só algumas pessoas ou papéis/ }));
    // Nobody picked yet: only the owner (João), who isn't in the list and always can.
    expect(section.textContent).toContain("Só João, por enquanto");
    await click(within(section).getAllByLabelText(/Walter/)[0] as HTMLElement);
    expect(section.textContent).toContain("João sempre pode, como responsável.");
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      audience: { mode: "people", userIds: ["u-walter"], roleIds: [], consultable: true },
    });
  });

  test("Só algumas pessoas ou papéis: roles first with their icon and people, one search for both, sent as roleIds", async () => {
    const state = seedState();
    state.roles = seedRoles().map((r) => (r.kind === "custom" ? { ...r, name: "Suporte" } : r));
    await go(`agents/${ADA_ID}?tab=settings&sec=audience`, state);
    const section = screen().getByRole("region", { name: "Quem pode falar com a Ada" });
    await click(within(section).getByRole("radio", { name: /^Só algumas pessoas ou papéis/ }));
    const results = within(section).getByRole("region", { name: "Buscar papéis e pessoas" });
    // "Todos" is the first choice, never a role to pick.
    expect(results.textContent).not.toContain("everyone");
    const text = results.textContent ?? "";
    expect(text.indexOf("Papéis")).toBeLessThan(text.indexOf("Pessoas"));
    // Each section's heading is the kit's picker heading: the roles' description under its label, apart.
    expect([...results.querySelectorAll(".ac-picker-head")].map((h) => h.textContent)).toEqual([
      "PapéisQuem tem o papel pode falar, inclusive quem entrar nele depois.",
      "Pessoas",
    ]);
    expect(
      within(results)
        .getByLabelText(/Suporte/)
        .closest("label")?.textContent,
    ).toMatch(/^Suporte\d+ pessoas?$/);
    expect(results.querySelector(".ac-rolemark")).toBeTruthy();
    const search = within(section).getByRole("searchbox", { name: "Buscar papéis e pessoas" });
    await act(async () => fireEvent.change(search, { target: { value: "sup" } }));
    expect(results.textContent).toContain("Suporte");
    expect(results.textContent).not.toContain("Walter");
    await act(async () => fireEvent.change(search, { target: { value: "walt" } }));
    expect(results.textContent).not.toContain("Suporte");
    expect(results.textContent).toContain("Walter");
    await act(async () => fireEvent.change(search, { target: { value: "" } }));
    await click(within(results).getByLabelText(/Suporte/));
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      audience: { mode: "people", userIds: [], roleIds: [ADMIN_ROLE_ID], consultable: true },
    });
  });

  test("Outros agentes podem consultar: on by default when it leaves someone out, turned off and sent with the audience", async () => {
    const state = await go(`agents/${ADA_ID}?tab=settings&sec=audience`);
    const section = screen().getByRole("region", { name: "Quem pode falar com a Ada" });
    expect(within(section).queryByRole("switch", { name: "Outros agentes podem consultar a Ada" })).toBeNull();
    await click(within(section).getByRole("radio", { name: /^Só o responsável/ }));
    const toggle = within(section).getByRole("switch", { name: "Outros agentes podem consultar a Ada" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(section.textContent).toContain("ela responde só ao agente que perguntou, nunca direto à pessoa");
    // Whether it holds for agents too, said plainly under the choice.
    expect(section.textContent).toContain(
      "Vale só para pessoas. Outros agentes ainda podem consultar a Ada por quem não está na lista.",
    );
    await click(toggle);
    expect(section.textContent).toContain(
      "Vale para agentes também. Nenhum outro agente consegue falar com a Ada por quem não está na lista.",
    );
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      audience: { mode: "owner", userIds: [], roleIds: [], consultable: false },
    });
  });

  test("on a plan answering only its owner the switch isn't offered: nobody else is answered, consulted or not", async () => {
    const state = onlyOwner();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "claude_code", model: "Sonnet" };
    await go(`agents/${ADA_ID}?tab=settings&sec=audience`, state);
    const section = screen().getByRole("region", { name: "Quem pode falar com a Ada" });
    expect(within(section).queryByRole("switch", { name: "Outros agentes podem consultar a Ada" })).toBeNull();
    expect(section.textContent).toContain("Vale para agentes também. A Ada usa o plano de IA do responsável");
  });

  test("an agent that doesn't answer me: chip, no @ suggestion, DM composer off with the notice", async () => {
    const withDm = onlyOwner();
    seedDm(withDm, { type: "agent", id: ADA_ID });
    // An owner lists the agents that don't talk to them only when they ask to (Agentes' ⋯).
    withDm.sidebarView = { agentSort: "workspace", showAllAgents: true, pins: null };
    await go(`c/${ENG_ID}`, withDm);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    const sidebarAda = within(nav).getByRole("link", { name: /^Ada/ });
    // In the sidebar: who she talks to in place of her role, and a lock that says it whole. The chip is in the DM's
    // header.
    expect(sidebarAda.textContent).toContain("só fala com João");
    expect(within(sidebarAda).getByRole("img", { name: "Pessoal" }).getAttribute("title")).toBe(
      "A Ada só responde a João.",
    );
    const box = screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
    await typeIn(box, "oi @a");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    const names = within(list)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(names.some((n) => n.includes("Ada"))).toBe(false);
    expect(names.some((n) => n.includes("Atlas"))).toBe(true);
    cleanup();
    await go(`dm/agent/${ADA_ID}`, onlyOwner());
    expect(screen().getByRole("heading", { level: 1, name: /^Ada/ }).textContent).toContain("Pessoal");
    const dm = screen().getByRole("combobox", { name: /Mensagem para Ada/ }) as HTMLTextAreaElement;
    expect(dm.disabled).toBe(true);
    expect(screen().getByText("A Ada só responde a João.")).toBeTruthy();
  });

  test("Criar agente: everyone by default, sent with the new agent", async () => {
    const state = await go("agents/new");
    await startAs("PM");
    await proceed(3);
    const group = screen().getByRole("radiogroup", { name: "Quem pode falar com o Theo" });
    expect(
      within(group)
        .getByRole("radio", { name: /Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(group).getByRole("radio", { name: /Só o responsável/ }));
    expect(document.body.textContent).toContain("Só Walter fala com o Theo.");
    await proceed(2);
    await click(screen().getByRole("button", { name: "Criar Theo" }));
    await settle(6);
    expect(
      (state.calls.find((c) => c.method === "agents.create")?.args[1] as { audience?: unknown } | undefined)?.audience,
    ).toEqual({ mode: "owner", userIds: [], roleIds: [], consultable: true });
  });

  test("Criar agente: Só algumas pessoas with nobody picked says only me for now and is sent restricted", async () => {
    const state = await go("agents/new");
    await startAs("PM");
    await proceed(3);
    const group = screen().getByRole("radiogroup", { name: "Quem pode falar com o Theo" });
    await click(within(group).getByRole("radio", { name: /Só algumas pessoas/ }));
    expect(document.body.textContent).toContain("Só você, por enquanto");
    expect(document.body.textContent).not.toContain("sempre pode, como responsável");
    await proceed(2);
    await click(screen().getByRole("button", { name: "Criar Theo" }));
    await settle(6);
    expect(
      (state.calls.find((c) => c.method === "agents.create")?.args[1] as { audience?: unknown } | undefined)?.audience,
    ).toEqual({ mode: "people", userIds: [], roleIds: [], consultable: true });
  });
});

describe("audience rules", () => {
  const i18n = createI18n("pt-BR");
  const t = i18n.t.bind(i18n);
  const theo = (over: Partial<Agent>): Agent => ({
    id: "a",
    name: "Theo",
    handle: "theo",
    role: "",
    instructions: "",
    model: "m",
    ownerUserId: "u1",
    hasCredential: false,
    monthlyBudgetUsd: null,
    createdAt: "",
    ...over,
  });
  const names: Record<string, string> = { u1: "Walter", u2: "Ana", u3: "Bia", u4: "Caio" };
  const nameOf = (id: string) => names[id];

  test("notice and summary", () => {
    expect(audienceNotice(t, theo({}), nameOf)).toBe("");
    expect(audienceNotice(t, theo({ audience: { mode: "owner", userIds: [] } }), nameOf)).toBe(
      "O Theo só responde a Walter.",
    );
    expect(audienceNotice(t, theo({ audience: { mode: "people", userIds: ["u2"] } }), nameOf)).toBe(
      "O Theo só responde a Walter e Ana.",
    );
    // From the directory list (no user ids): "algumas pessoas".
    expect(audienceNotice(t, theo({ audienceMode: "people", canTalk: false }), nameOf)).toBe(
      "O Theo só responde a algumas pessoas.",
    );
    expect(audienceSummary(t, theo({ audience: { mode: "owner", userIds: [] } }), nameOf)).toBe("Só Walter");
    expect(audienceSummary(t, theo({ audience: { mode: "people", userIds: ["u2", "u3", "u4"] } }), nameOf)).toBe(
      "Walter, Ana e mais 2 pessoas",
    );
    // Roles first, the people after them counted.
    const roleName = (id: string) => ({ r1: "Suporte", r2: "Tecnologia" })[id];
    const both = theo({ audience: { mode: "people", userIds: ["u2", "u3"], roleIds: ["r1", "r2"] } });
    expect(audienceSummary(t, both, nameOf, roleName)).toBe("Suporte, Tecnologia e mais 3 pessoas");
    expect(audienceNotice(t, both, nameOf, roleName)).toBe(
      "O Theo só responde a Suporte, Tecnologia, Walter, Ana e Bia.",
    );
    expect(
      audienceSummary(t, theo({ audience: { mode: "people", userIds: [], roleIds: ["r1"] } }), nameOf, roleName),
    ).toBe("Suporte e Walter");
  });

  test("who can talk and who can edit", () => {
    expect(canTalk(theo({}))).toBe(true);
    expect(canTalk(theo({ canTalk: false }))).toBe(false);
    const member: OrgSummary = { id: ORG_ID, name: "Acme", role: "member", permissions: ["read", "post"] };
    const admin: OrgSummary = { ...member, permissions: ["read", "post", "manage_agents"] };
    expect(canEditAudience(member, theo({}), "u1")).toBe(true);
    expect(canEditAudience(member, theo({}), "u2")).toBe(false);
    expect(canEditAudience(admin, theo({}), "u2")).toBe(true);
  });

  test("whose lists show it: anyone's while it answers them, always who manages agents'", () => {
    const member: OrgSummary = { id: ORG_ID, name: "Acme", role: "member", permissions: ["read", "talk_to_agents"] };
    const manager: OrgSummary = { ...member, permissions: ["read", "talk_to_agents", "manage_agents"] };
    const locked = theo({ canTalk: false });
    expect(listsAgent(member, theo({}))).toBe(true);
    expect(listsAgent(member, locked)).toBe(false);
    expect(listsAgent(manager, locked)).toBe(true);
    // An older server says nothing: it answers everyone.
    expect(listsAgent(member, theo({ canTalk: undefined }))).toBe(true);
  });

  test("agent.unavailable: the notice shows for me and the 'pensando…' goes away", async () => {
    const { createStreamsStore } = await import("@/realtime/context");
    const store = createStreamsStore();
    store.expect("c1", "m1", ["a"]);
    expect(Object.keys(store.get().streams.runs)).toHaveLength(1);
    store.unavailable({
      type: "agent.unavailable",
      agentId: "a",
      channelId: "c1",
      threadId: null,
      messageId: "m1",
      text: "Theo only replies to Ana.",
      code: "audience.only",
      params: { agentName: "Theo", names: ["Ana"] },
    });
    expect(Object.keys(store.get().streams.runs)).toHaveLength(0);
    // What words it, never the server's English.
    expect(store.get().notices.c1?.map((n) => [n.code, n.params?.names])).toEqual([["audience.only", ["Ana"]]]);
  });
});
