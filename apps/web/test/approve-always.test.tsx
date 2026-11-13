import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Approval, ApprovalRule } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const EXECUTOR = "COMPOSIO_MULTI_EXECUTE_TOOL";
const TITLE = "Composio: GITHUB_CREATE_AN_ISSUE_COMMENT";
const HINT =
  "Cobre Comentar numa issue (GitHub), de agora em diante, com qualquer valor. Para desfazer: Ferramentas e acesso, na página da Ada.";

/** The seed's first request (Ada's card in #eng) as one through Composio's executor, which offers "Aprovar sempre". */
function withComposio(state = seedState()) {
  const first = state.approvals[0];
  if (!first) throw new Error("no approval");
  Object.assign(first, {
    tool: `composio_${EXECUTOR}`,
    scope: "custom:conn-composio:write",
    title: TITLE,
    detail: `${EXECUTOR} · tools=[{"tool_slug":"GITHUB_CREATE_AN_ISSUE_COMMENT"}]`,
    connector: "custom:conn-composio",
    approveAlways: { tool: EXECUTOR, actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"] },
  });
  return state;
}

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const seeDetails = (card: HTMLElement) => click(within(card).getByRole("button", { name: "Ver detalhes" }));
const approveCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "approvals.approve").map((c) => c.args);

describe("Aprovar sempre on a request", () => {
  test("in the conversation, on the card's face: the button, and what it covers and where to undo it in its tip", async () => {
    const state = withComposio();
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    // Beside Aprovar and Agora não, without opening Ver detalhes.
    expect(card.querySelector(".rq__details")).toBeNull();
    // One row of buttons under the text, in this order, and no line of words among them.
    const foot = card.querySelector(".rq__foot") as HTMLElement;
    expect([...foot.querySelectorAll(":scope > button")].map((b) => b.textContent).slice(1)).toEqual([
      "Aprovar sempre",
      "Agora não",
    ]);
    expect(foot.querySelector(":scope > p")).toBeNull();
    expect(card.textContent).not.toContain(HINT);
    // What it covers: the button's description, and its tip on a resting pointer.
    const always = within(card).getByRole("button", { name: "Aprovar sempre" });
    expect(always.getAttribute("aria-description")).toBe(HINT);
    await act(async () => {
      fireEvent.pointerEnter(always, { pointerType: "mouse" });
      await Bun.sleep(300);
    });
    expect(document.querySelector(".ac-tip")?.textContent).toBe(HINT);
    await click(within(card).getByRole("button", { name: "Aprovar sempre" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined, true]]);
    expect(screen().getByRole("group", { name: "Aprovação concluída" })).toBeTruthy();
    const toast = screen().getByRole("status");
    expect(toast.textContent).toContain("Aprovado. Ada não pede mais para isso.");
    expect(toast.textContent).toContain("Para desfazer, vá em Ferramentas e acesso, na página da Ada.");
    await click(within(toast).getByRole("button", { name: "Abrir" }));
    // Ada's page in the panel beside the conversation, at Ferramentas e acesso: the person stays in the channel.
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    const panel = screen().getByRole("complementary", { name: "Perfil da Ada" });
    expect(
      within(panel)
        .getByRole("tab", { name: /^Ferramentas e acesso/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("a routine's card: Sempre nesta rotina, what it covers, where it's undone, and the toast opens the routine", async () => {
    const state = withComposio();
    const [first] = state.approvals;
    if (!first) throw new Error("no approval");
    const routineId = "rt-1";
    Object.assign(first, {
      scope: "gmail:send",
      origin: { kind: "routine", routineId, routineName: "Resumo da semana" },
      approveAlways: { tool: `composio_${EXECUTOR}`, actions: ["GMAIL_SEND_EMAIL"], routineId },
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(within(card).queryByRole("button", { name: "Aprovar sempre" })).toBeNull();
    expect(card.textContent).not.toContain("Fora desta rotina");
    expect(
      within(card).getByRole("button", { name: "Sempre nesta rotina" }).getAttribute("aria-description"),
    ).toContain("Fora desta rotina continua pedindo. Para desfazer: configurações da rotina.");
    await click(within(card).getByRole("button", { name: "Sempre nesta rotina" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, first.id, undefined, true]]);
    const toast = screen().getByRole("status");
    expect(toast.textContent).toContain("Aprovado. Resumo da semana não pede mais para isso.");
    expect(toast.textContent).toContain("Para desfazer, vá nas configurações da rotina.");
  });

  test("a SQL read: Aprovar sempre leituras on the face, for that project's reads only", async () => {
    const state = seedState();
    const first = state.approvals[0];
    if (!first) throw new Error("no approval");
    Object.assign(first, {
      tool: "supabase_execute_sql",
      scope: "custom:conn-db:approval",
      title: "Supabase: Execute sql",
      detail: "execute_sql · project_id=proj-a · query=select count(*) from orders",
      connector: "custom:conn-db",
      params: { project_id: "proj-a", query: "select count(*) from orders" },
      approveAlways: { tool: "execute_sql", actions: ["sql-read:project_id=proj-a"] },
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(within(card).getByRole("button", { name: "Aprovar sempre leituras" }).getAttribute("aria-description")).toBe(
      "Cobre só leituras de Rodar SQL, neste projeto (project_id=proj-a), de agora em diante. O que muda dados continua pedindo. Para desfazer: Ferramentas e acesso, na página da Ada.",
    );
    expect(within(card).queryByRole("button", { name: "Aprovar sempre" })).toBeNull();
    await click(within(card).getByRole("button", { name: "Aprovar sempre leituras" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined, true]]);
  });

  test("a request that doesn't offer it shows no button, and approving it once stays as it was", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    await seeDetails(card);
    expect(within(card).queryByRole("button", { name: "Aprovar sempre" })).toBeNull();
    expect(card.querySelector("[aria-description]")).toBeNull();
    await click(within(card).getByRole("button", { name: "Aprovar merge" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined]]);
  });

  test("on Aprovações: in the open request's decision bar, never on a high-risk one", async () => {
    const state = withComposio();
    const deploy = state.approvals[1];
    if (deploy) deploy.approveAlways = { tool: "run_workflow", actions: [] };
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(state) });
    await settle(4);
    // The deploy, closest to expiring, opens first: high risk, so no "Always approve".
    const risky = screen().getByRole("region", { name: "Fazer um deploy" });
    expect(within(risky).queryByRole("button", { name: "Aprovar sempre" })).toBeNull();
    await click(document.querySelector('.ap-li[data-id="ap-merge"]') as HTMLElement);
    const pane = screen().getByRole("region", { name: /\(GitHub\)$/ });
    // Beside Refuse and Approve, first in a bar of buttons alone: what each allows is in its tip.
    const bar = pane.querySelector(".ap-bar") as HTMLElement;
    expect(bar.querySelector("p")).toBeNull();
    const buttons = [...(bar.querySelector(".ap-bar__acts")?.querySelectorAll(".ac-locked > button") ?? [])];
    expect(buttons.map((b) => b.textContent?.replace(/R$/, ""))).toEqual(["Aprovar sempre", "Recusar", "Aprovar"]);
    expect(buttons[0]?.getAttribute("aria-description")).toBe(HINT);
    expect(buttons.at(-1)?.getAttribute("data-approve")).toBe("ap-merge");
    expect(buttons.at(-1)?.getAttribute("aria-description")).toMatch(
      /^Ada vai .+, só desta vez e com estes valores\.$/,
    );
    await click(within(pane).getByRole("button", { name: "Aprovar sempre" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined, true]]);
  });

  test("on a run: approves the like ones waiting beside it, never the same tool on another connection", async () => {
    const state = withComposio();
    const [first] = state.approvals;
    if (!first) throw new Error("no approval");
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    state.approvals.splice(
      0,
      1,
      { ...first, id: "ap-c1", createdAt: at(4) },
      { ...first, id: "ap-c2", createdAt: at(3) },
      { ...first, id: "ap-c3", tool: `composio2_${EXECUTOR}`, createdAt: at(2) },
    );
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(state) });
    await settle(4);
    const run = document.querySelector(".ap-run") as HTMLElement;
    await click(within(run).getByRole("button", { name: "Aprovar sempre" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-c1", undefined, true]]);
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([ORG_ID, ["ap-c2"], "approve"]);
  });
});

describe("Ferramentas e acesso: Aprovado sempre", () => {
  const rules = (): ApprovalRule[] => [
    {
      id: "rule-1",
      connectionId: "conn-composio",
      server: "Composio",
      tool: EXECUTOR,
      toolLabel: "Executar ferramentas",
      action: "GITHUB_CREATE_AN_ISSUE_COMMENT",
      createdByUserId: "u-joao",
      createdAt: new Date().toISOString(),
    },
    {
      id: "rule-2",
      connectionId: "conn-composio",
      server: "Composio",
      tool: "close_ticket",
      toolLabel: "Fechar chamado",
      action: "",
      createdByUserId: null,
      createdAt: new Date().toISOString(),
    },
  ];
  const page = async (state = seedState()) => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
    await settle(8);
    return state;
  };
  const card = () => screen().queryByRole("region", { name: "Aprovado sempre" });

  test("lists what Ada runs without asking, by whom and when; × makes her ask again, at once", async () => {
    const state = seedState();
    state.approvalRules = { [ADA_ID]: rules() };
    await page(state);
    const list = card();
    if (!list) throw new Error("no card");
    expect(list.textContent).toContain("Roda sem pedir, com qualquer valor.");
    // The server on the row's line, what it allows and who allowed it under it.
    const rows = [...list.querySelectorAll("li")].map(
      (li) =>
        `${li.querySelector(".level-row__name")?.textContent}${li.querySelector(".level-row__text")?.textContent}`,
    );
    expect(rows).toEqual([
      "ComposioComentar numa issue (GitHub)Aprovado por João · agora",
      "ComposioFechar chamadoAprovado · agora",
    ]);
    expect(within(list).getByText("Comentar numa issue (GitHub)").getAttribute("title")).toBe(
      "GITHUB_CREATE_AN_ISSUE_COMMENT",
    );
    await click(within(list).getByRole("button", { name: "Voltar a pedir: Fechar chamado" }));
    expect(state.calls.find((c) => c.method === "approvals.removeRule")?.args).toEqual([ORG_ID, ADA_ID, "rule-2"]);
    expect(document.body.textContent).toContain("Ada volta a pedir para isso.");
    expect([...(card()?.querySelectorAll("li") ?? [])]).toHaveLength(1);
    // Nothing waits in the save bar: it saved on its own.
    expect(screen().queryByRole("region", { name: "Alterações não salvas" })).toBeNull();
  });

  test("a member reads it without ×; the agent's owner may remove; nothing approved for good, no card", async () => {
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    member.approvalRules = { [ADA_ID]: rules() };
    await page(member);
    expect(card()).toBeTruthy();
    expect(within(card() as HTMLElement).queryAllByRole("button")).toEqual([]);
    cleanup();

    const owner = seedState();
    if (owner.me?.organizations[0]) owner.me.organizations[0].role = "member";
    const ada = owner.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    owner.approvalRules = { [ADA_ID]: rules() };
    await page(owner);
    expect(
      within(card() as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Voltar a pedir: Comentar numa issue (GitHub)", "Voltar a pedir: Fechar chamado"]);
    cleanup();

    await page();
    expect(document.body.textContent).toContain("Merge, deploy e rollback sempre pedem aprovação no chat.");
    expect(card()).toBeNull();
  });
});

describe("a custom server's own tool, as Higgsfield's", () => {
  /** The seed's first request as one of a server connected by address, a tool that asks only because of its level. */
  const withImage = (state = seedState()) => {
    const first = state.approvals[0];
    if (!first) throw new Error("no approval");
    Object.assign(first, {
      tool: "higgsfield_generate_image",
      scope: "custom:conn-higgsfield:approval",
      title: "Higgsfield: Generate image",
      detail: "generate_image · prompt=Capa do episódio 12 · model=nano_banana_2",
      params: { prompt: "Capa do episódio 12", model: "nano_banana_2", resolution: "2k" },
      connector: "custom:conn-higgsfield",
      approveAlways: { tool: "generate_image", actions: [] },
    });
    return state;
  };

  test("the card says what it does in words, never the tool's code name, and offers Aprovar sempre", async () => {
    const state = withImage();
    const api = createFakeApi(state);
    // The server it goes through, by its own name on the card.
    const connected = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://mcp.higgsfield.example/mcp",
      label: "Higgsfield",
      apiKey: "fake-key-for-tests",
      returnTo: "/",
    });
    if (connected.status !== "connected") throw new Error("not connected");
    const [first] = state.approvals;
    if (first) first.connector = `custom:${connected.server.id}`;
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.querySelector(".rq__wt b")?.textContent).toBe("Gerar imagem");
    expect(card.textContent).not.toContain("generate_image");
    const always = within(card).getByRole("button", { name: "Aprovar sempre" });
    expect(always.getAttribute("aria-description")).toBe(
      "Cobre Gerar imagem, de agora em diante, com qualquer valor. Para desfazer: Ferramentas e acesso, na página da Ada.",
    );
    await click(always);
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined, true]]);
  });

  test("on Ada's page its rule reads in words, and × makes her ask again", async () => {
    const state = seedState();
    state.approvalRules = {
      [ADA_ID]: [
        {
          id: "rule-img",
          connectionId: "conn-higgsfield",
          server: "Higgsfield",
          tool: "generate_image",
          toolLabel: "Generate image",
          action: "",
          createdByUserId: "u-joao",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
    await settle(8);
    const list = screen().getByRole("region", { name: "Aprovado sempre" });
    // The server on the row's line, what it allows and who allowed it under it.
    expect(list.querySelector("li .level-row__name")?.textContent).toBe("Higgsfield");
    expect(list.querySelector("li .level-row__text")?.textContent).toBe("Gerar imagemAprovado por João · agora");
    await click(within(list).getByRole("button", { name: "Voltar a pedir: Gerar imagem" }));
    expect(state.calls.find((c) => c.method === "approvals.removeRule")?.args).toEqual([ORG_ID, ADA_ID, "rule-img"]);
  });
});

describe("git requests", () => {
  const branches = ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6", "old-7"];
  /** The seed's first request (Ada's card in #eng) as one of the git tools. */
  const withGit = (over: Partial<Approval>, state = seedState()) => {
    const first = state.approvals[0];
    if (!first) throw new Error("no approval");
    Object.assign(first, { scope: "github:git.write", connector: "github", detail: "", ...over });
    return state;
  };
  const push = {
    tool: "request_branch_push",
    title: "Enviar para ana/fix em acme/app (24 h, sem force push)",
    params: { repo: "acme/app", branch: "ana/fix" },
    approveAlways: { tool: "request_branch_push", actions: ["acme/app:ana/fix"] },
  };
  const remove = {
    tool: "delete_branches",
    title: "Apagar 7 branches em acme/app",
    detail: branches.join("\n"),
    params: { repo: "acme/app", branches },
    approveAlways: null,
  };

  test("a push to someone's branch: one tap, and Aprovar sempre for that branch alone", async () => {
    const state = withGit(push);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.textContent).toContain("Enviar para ana/fix em acme/app (24 h, sem force push)");
    const always = within(card).getByRole("button", { name: "Aprovar sempre" });
    expect(always.getAttribute("aria-description")).toBe(
      "Cobre enviar para ana/fix em acme/app, de agora em diante. Para desfazer: Ferramentas e acesso, na página da Ada.",
    );
    await click(always);
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined, true]]);
  });

  test("deleting branches: the batch in the open request, held to approve, never Always approve", async () => {
    await renderApp(`/org/${ORG_ID}/approvals?open=ap-merge`, { api: createFakeApi(withGit(remove)) });
    await settle(4);
    const card = screen().getByRole("region", { name: "Apagar 7 branches em acme/app" });
    expect(card.textContent).toContain("old-1, old-2, old-3");
    expect(within(card).queryByRole("button", { name: "Aprovar sempre" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Aprovar exclusão: segure para confirmar" })).toBeTruthy();
  });

  test("Ferramentas e acesso: a remembered push reads as its branch, and × takes it back", async () => {
    const state = seedState();
    state.approvalRules = {
      [ADA_ID]: [
        {
          id: "rule-git",
          connectionId: "conn-gh",
          server: "GitHub",
          tool: "request_branch_push",
          toolLabel: "request_branch_push",
          action: "acme/app:ana/fix",
          createdByUserId: "u-joao",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
    await settle(8);
    const list = screen().getByRole("region", { name: "Aprovado sempre" });
    expect(list.querySelector(".level-row__name")?.textContent).toBe("GitHub");
    expect(list.querySelector(".level-row__text")?.textContent).toBe(
      "enviar para ana/fix em acme/appAprovado por João · agora",
    );
    expect(within(list).getByText("enviar para ana/fix em acme/app").getAttribute("title")).toBe("acme/app:ana/fix");
    await click(within(list).getByRole("button", { name: "Voltar a pedir: enviar para ana/fix em acme/app" }));
    expect(state.calls.find((c) => c.method === "approvals.removeRule")?.args).toEqual([ORG_ID, ADA_ID, "rule-git"]);
    expect(screen().queryByRole("region", { name: "Aprovado sempre" })).toBeNull();
  });
});
