import { afterEach, describe, expect, test } from "bun:test";
import type { AiAccounts, AiComputer } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
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
const base = {
  kind: "claude_code" as const,
  plan: null,
  status: "active" as const,
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usage: null,
  provider: null,
  keyHint: null,
  machineId: "machine_1",
  computer: "MacBook",
};
const WORK: AiAccounts["accounts"][number] = {
  ...base,
  id: "acct_work",
  label: "Trabalho",
  email: "walt@acme.com",
  plan: "team",
  usedBy: ["Ada"],
  usage: {
    windows: [{ kind: "five_hour", usedPercent: 84, resetsAt: "2099-01-01T15:40:00.000Z" }],
    source: "probe",
    at: new Date().toISOString(),
  },
};
const MINIMAX: AiAccounts["accounts"][number] = {
  ...base,
  id: "acct_mm",
  label: "MiniMax",
  email: null,
  usedBy: [],
  provider: "minimax",
  keyHint: "MnOp",
};

async function page(accounts: AiAccounts["accounts"], role: "owner" | "member" = "owner", computers = [MAC]) {
  const state = seedState();
  if (state.me?.organizations[0]) state.me.organizations[0].role = role;
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({ accounts, computers });
  // The old address of Contas de IA: it opens IA e uso, where the accounts are now.
  await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
  await settle(6);
  return { state, api };
}

/** The accounts' rows after the seeded computer's own sign-in, which is always the first. */
const rows = () => ([...document.querySelectorAll(".plan-row")] as HTMLElement[]).slice(1);

/** A row with what it folds in sight: near its limit it already is. */
async function opened(row: HTMLElement | undefined) {
  const head = within(row as HTMLElement).getAllByRole("button")[0] as HTMLElement;
  if (head.getAttribute("aria-expanded") !== "true") await click(head);
  return row as HTMLElement;
}

describe("IA e uso: the viewer's own accounts", () => {
  test("the old address opens IA e uso; with accounts, Conectar uma IA is in the card's head, the same picker as everywhere", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(seedState()) });
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/usage`);
    const plans = screen().getByRole("region", { name: "Contas" });
    const connect = within(plans).getByRole("button", { name: "Conectar uma IA" });
    expect(connect.closest(".ac-card__head")).not.toBeNull();
    await act(async () => fireEvent.click(connect));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    expect(within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" })).toBeTruthy();
  });

  test("a member sees their own plans with their meters, never the workspace's keys; an admin sees both", async () => {
    const member = await page([WORK, MINIMAX], "member");
    // Looking at the plans asks the computers for fresh usage.
    expect(member.state.calls.some((c) => c.method === "machines.refreshAccountUsage")).toBe(true);
    const [work, mm] = rows();
    // Closed: its name, plan and owner, and one meter for its fullest window.
    const head = work?.querySelector(".plan-row__head") as HTMLElement;
    expect(head.textContent).toContain("Trabalho\u2002Team\u2002de Walter");
    expect(head.querySelector(".ac-planmeter__line")?.textContent).toBe("5h 84%");
    expect(within(head).getAllByRole("meter")).toHaveLength(1);
    // Near its limit: what matters then on one line under them, and the row starts open.
    expect(head.querySelector(".plan-row__alert")?.textContent).toMatch(/^Quase no limite · renova /);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(work?.textContent).toContain("Claude Code · walt@acme.com");
    expect(work?.querySelector(".plan-shares__row")?.textContent).toBe("Ada · usa agora");
    // A coding plan's key, closed until asked: its last 4 and what its maker shares.
    expect(mm?.querySelector(".plan-row__head")?.getAttribute("aria-expanded")).toBe("false");
    expect(mm?.querySelector(".plan-row__body")?.textContent).toBe("");
    await opened(mm);
    expect(mm?.textContent).toContain("chave …MnOp");
    expect(mm?.textContent).toContain("MiniMax não mostra o uso por aqui.");
    expect(mm?.querySelector('[data-mark="minimax"]')).not.toBeNull();
    expect(within(mm as HTMLElement).getByRole("button", { name: "Trocar a chave" })).toBeTruthy();
    expect(screen().queryByRole("region", { name: "Chaves de provedor" })).toBeNull();
    cleanup();
    await page([WORK]);
    expect(screen().getByRole("region", { name: "Contas" })).toBeTruthy();
    expect(screen().getByRole("region", { name: "Chaves de provedor" })).toBeTruthy();
  });

  test("an OpenCode key and a Gemini Enterprise seat each show their maker's logo, never a letter", async () => {
    const zen = {
      ...MINIMAX,
      id: "acct_zen",
      kind: "opencode" as const,
      label: "OpenCode",
      provider: "zen",
      keyHint: "Q7f2",
    };
    const seat = { ...WORK, id: "acct_seat", kind: "antigravity" as const, label: "Gemini", provider: "enterprise" };
    await page([zen, seat], "owner", [{ ...MAC, brains: { ...MAC.brains, opencode: true, antigravity: true } }]);
    const [oc, gemini] = rows();
    expect(oc?.textContent).toContain("OpenCode");
    expect(oc?.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("opencode");
    expect(gemini?.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("gemini");
    expect(document.querySelectorAll(".plan-row .ac-brand__initial")).toHaveLength(0);
  });

  test("a signed-out account its computer couldn't check says so, and still signs in again", async () => {
    await page([{ ...WORK, status: "signed_out" as const, statusKnown: false }]);
    const row = await opened(rows()[0]);
    expect(row.textContent).toContain("O computador não conseguiu confirmar o login desta vez.");
    expect(row.textContent).not.toContain("Saiu da conta.");
    expect(within(row).getByRole("button", { name: "Entrar de novo" })).toBeTruthy();
  });

  test("Sign in again: the account's own email goes to Claude's sign-in unseen; another account coming back is said, with Try again only", async () => {
    const out = { ...WORK, status: "signed_out" as const };
    const free = { ...WORK, id: "acct_pessoal", label: "Pessoal", email: "walt@gmail.com", usedBy: [], usage: null };
    const { state, api } = await page([out, free]);
    fakeMachinesOf.get(api)?.endLogin("login_1", {
      state: "failed",
      signedInAs: "walt@gmail.com",
      duplicate: { label: "Pessoal", account: free },
    });
    await click(within(await opened(rows()[0])).getByRole("button", { name: "Entrar de novo" }));
    const dialog = screen().getByRole("dialog", { name: "Trabalho" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(dialog).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_work", email: "walt@acme.com" },
    ]);
    expect(shownText(dialog)).toContain(
      "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
    );
    // No agent here to think with the one that came back: nothing to use it for.
    expect(within(dialog).queryByRole("button", { name: /^Usar / })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  test("a sign-in the server refuses says why, not that the computer didn't answer; one it can't explain still does", async () => {
    const out = { ...WORK, status: "signed_out" as const };
    const { api } = await page([out]);
    api.machines.beginAccountLogin = async () => {
      throw new ApiError(409, "account.method_unsupported", "This computer can't connect Claude this way yet.");
    };
    await click(within(await opened(rows()[0])).getByRole("button", { name: "Entrar de novo" }));
    const dialog = screen().getByRole("dialog", { name: "Trabalho" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    const signIn = async () => {
      await click(within(dialog).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    };
    try {
      await signIn();
      expect(shownText(dialog)).toContain(
        "Este computador ainda não conecta o Claude desse jeito. Atualize o programa do agentes.chat nele, ou use uma chave de API.",
      );
      expect(shownText(dialog)).not.toContain("não respondeu");
      api.machines.beginAccountLogin = async () => {
        throw new ApiError(409, "account.runner_old", "The runner on MacBook is too old for accounts. Update it.");
      };
      await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
      await signIn();
      expect(shownText(dialog)).toContain("O app do computador é antigo demais para isso. Atualize e tente de novo.");
      // A code the app has no words for: the computer didn't answer.
      api.machines.beginAccountLogin = async () => {
        throw new ApiError(400, "account.invalid_kind", "Unknown account kind");
      };
      await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
      await signIn();
      expect(shownText(dialog)).toContain("O MacBook não respondeu. Tente de novo em instantes.");
    } finally {
      window.open = realOpen;
    }
  });

  test("disconnecting names the agent that thinks with it; renaming saves the new name", async () => {
    const { state } = await page([WORK, MINIMAX]);
    await click(within(await opened(rows()[0])).getByRole("button", { name: "Desconectar" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar Trabalho?" });
    expect(confirm.textContent).toContain(
      "Ada deixa de pensar com ela. O MacBook sai da conta e apaga o que guardava.",
    );
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.removeAccount")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "acct_work",
    ]);
    expect(document.body.textContent).toContain("Trabalho desconectada.");
    expect(rows()).toHaveLength(1);

    await click(within(await opened(rows()[0])).getByRole("button", { name: "Renomear" }));
    const rename = screen().getByRole("dialog", { name: "Renomear MiniMax" });
    await act(async () =>
      fireEvent.change(within(rename).getByLabelText("Nome"), { target: { value: "MiniMax do Walt" } }),
    );
    await click(within(rename).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.renameAccount")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "acct_mm",
      "MiniMax do Walt",
    ]);
  });
});

describe("IA e uso: the same account signed in again and again", () => {
  const copy = (id: string, over: Partial<AiAccounts["accounts"][number]> = {}): AiAccounts["accounts"][number] => ({
    ...base,
    kind: "codex",
    id,
    label: "ChatGPT",
    email: "walt@acme.com",
    plan: "plus",
    usedBy: [],
    ...over,
  });

  test("one row, its logins with no agent flagged, and Remover takes only those: the agents keep theirs", async () => {
    const { state } = await page([
      copy("gpt_ada", { usedBy: ["Ada"] }),
      copy("gpt_2", { status: "signed_out" }),
      copy("gpt_3"),
      copy("gpt_4", { status: "signed_out" }),
    ]);
    expect(rows()).toHaveLength(1);
    const row = await opened(rows()[0]);
    expect(row.textContent).toContain("Mais 3 logins desta conta, sem nenhum agente.");
    await click(within(row).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args.slice(1))).toEqual([
      ["machine_1", "gpt_2"],
      ["machine_1", "gpt_3"],
      ["machine_1", "gpt_4"],
    ]);
    expect(screen().getByText("3 logins sem uso removidos.")).toBeTruthy();
  });

  test("none with an agent: the signed-in one stays; a single login is never flagged", async () => {
    await page([copy("gpt_1", { status: "signed_out" }), copy("gpt_2")]);
    expect((await opened(rows()[0])).textContent).toContain("Mais 1 login desta conta, sem nenhum agente.");
    cleanup();
    await page([copy("gpt_1")]);
    const one = await opened(rows()[0]);
    expect(one.textContent).not.toContain("desta conta, sem nenhum agente");
    expect(within(one).queryByRole("button", { name: "Remover" })).toBeNull();
    expect(within(one).getByRole("button", { name: "Renomear" })).toBeTruthy();
  });
});

describe("IA e uso: a plan with a login per agent", () => {
  const usage = (percent: number, at: string) => ({
    windows: [{ kind: "five_hour" as const, usedPercent: percent, resetsAt: "2099-01-01T15:40:00.000Z" }],
    source: "probe" as const,
    at,
  });
  test("closed, one meter: the window closest to its limit; open, every window with its bar", async () => {
    const team: AiAccounts["accounts"][number] = {
      ...WORK,
      usage: {
        windows: [
          { kind: "five_hour", usedPercent: 12 },
          { kind: "seven_day", usedPercent: 40 },
          { kind: "seven_day_sonnet", usedPercent: 3 },
        ],
        source: "probe",
        at: new Date().toISOString(),
      },
    };
    await page([team]);
    const [account] = rows();
    const head = account?.querySelector(".plan-row__head") as HTMLElement;
    expect(head.querySelector(".ac-planmeter__line")?.textContent).toBe("semana 40%");
    expect(
      within(head)
        .getAllByRole("meter")
        .map((m) => m.getAttribute("aria-label")),
    ).toEqual(["Semana"]);
    // Under 80%: no line under the row, and it stays closed.
    expect(head.querySelector(".plan-row__alert")).toBeNull();
    expect(head.getAttribute("aria-expanded")).toBe("false");
    await opened(account);
    expect([...(account as HTMLElement).querySelectorAll(".ac-planmeter__window")].map((w) => w.textContent)).toEqual([
      "Semana40%",
      "5 horas12%",
      "Semana · Sonnet3%",
    ]);
    // Closing it takes what it folds out of reach.
    await click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(account?.querySelector(".plan-row__fold")?.hasAttribute("inert")).toBe(true);
  });

  /** One GLM key signed in for Ada, Theo and Lia: three logins, one account. */
  type Row = AiAccounts["accounts"][number];
  const glm = (id: string, agent: string, over: Partial<Row> = {}): Row => ({
    ...MINIMAX,
    id,
    label: "GLM Coding",
    provider: "zai",
    keyHint: "4f2a",
    usedBy: [agent],
    ...over,
  });
  const LOGINS = [
    glm("acct_ada", "Ada", { usage: usage(40, "2026-10-27T10:00:00.000Z") }),
    glm("acct_theo", "Theo", { usage: usage(62, "2026-10-27T11:00:00.000Z") }),
    glm("acct_lia", "Lia"),
  ];

  test("one row for the account: every agent on it, one meter from the newest usage", async () => {
    await page(LOGINS);
    expect(rows()).toHaveLength(1);
    const row = await opened(rows()[0]);
    expect(row.querySelector(".plan-row__head .ac-planmeter__line")?.textContent).toBe("5h 62%");
    expect(row.textContent).toContain("chave …4f2a");
    expect([...row.querySelectorAll(".plan-shares__row")].map((r) => r.textContent)).toEqual([
      "Ada · usa agora",
      "Theo · usa agora",
      "Lia · usa agora",
    ]);
    // What its owner does with it: one line of actions under everything else, starting on the words' edge.
    const acts = row.querySelector(".plan-row__body > .ai-accounts__own:last-child > .ac-acts") as HTMLElement;
    expect(
      within(acts)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Renomear", "Trocar a chave", "Desconectar"]);
  });

  test("one login signed out: whose, said under the facts", async () => {
    const [ada, theo, lia] = LOGINS as [Row, Row, Row];
    await page([ada, { ...theo, status: "signed_out" }, lia]);
    expect((await opened(rows()[0])).textContent).toContain("Theo ficou sem login.");
  });

  test("Disconnect takes every login of the account, and the dialog names every agent", async () => {
    const { state } = await page(LOGINS);
    await click(within(await opened(rows()[0])).getByRole("button", { name: "Desconectar" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar GLM Coding?" });
    expect(confirm.textContent).toContain(
      "Ada, Theo e Lia deixam de pensar com ela. O MacBook sai da conta e apaga o que guardava.",
    );
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args[2])).toEqual([
      "acct_ada",
      "acct_theo",
      "acct_lia",
    ]);
  });

  test("two accounts with the same name stay two rows: a name is anyone's to repeat", async () => {
    const other = glm("acct_bo", "Bo", { keyHint: "9z9z" });
    const { state } = await page([...LOGINS, other]);
    expect(rows()).toHaveLength(2);
    const second = await opened(rows()[1]);
    expect(second.textContent).toContain("chave …9z9z");
    expect(second.querySelector(".plan-shares__row")?.textContent).toBe("Bo · usa agora");
    await click(within(second).getByRole("button", { name: "Desconectar" }));
    await click(within(screen().getByRole("dialog")).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args[2])).toEqual(["acct_bo"]);
  });

  test("Replace the key: the new key goes to every login of the account, sealed to each", async () => {
    const { state, api } = await page(LOGINS);
    const machines = fakeMachinesOf.get(api);
    for (const [n, l] of LOGINS.entries()) machines?.endLogin(`login_${n + 1}`, { state: "done", account: l });
    await click(within(await opened(rows()[0])).getByRole("button", { name: "Trocar a chave" }));
    const dialog = screen().getByRole("dialog", { name: "GLM Coding" });
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Chave do GLM Coding"), {
        target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
      }),
    );
    await click(within(dialog).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(12);
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_ada", provider: "zai" },
      { accountId: "acct_theo", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
    ]);
    expect(new Set(machines?.logins().map((l) => JSON.stringify(l.box))).size).toBe(3);
    // Each took it: the dialog closes.
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("Replace the key, one login failing: Try again sends the key only to that login", async () => {
    const { state, api } = await page(LOGINS);
    const machines = fakeMachinesOf.get(api);
    const [ada, theo, lia] = LOGINS as [Row, Row, Row];
    machines?.endLogin("login_1", { state: "done", account: ada });
    machines?.endLogin("login_2", { state: "done", account: theo });
    machines?.endLogin("login_3", { state: "failed" });
    machines?.endLogin("login_4", { state: "done", account: lia });
    await click(within(await opened(rows()[0])).getByRole("button", { name: "Trocar a chave" }));
    const dialog = screen().getByRole("dialog", { name: "GLM Coding" });
    const send = async () => {
      await act(async () =>
        fireEvent.change(within(dialog).getByLabelText("Chave do GLM Coding"), {
          target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
        }),
      );
      await click(within(dialog).getByRole("button", { name: "Enviar ao MacBook" }));
      await settle(12);
    };
    await send();
    await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
    await send();
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_ada", provider: "zai" },
      { accountId: "acct_theo", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
    ]);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("an account for all of Walter's agents there: Use for Atlas too gives it, no sign-in; Disconnect says to revoke the token on Claude", async () => {
    const state = seedState();
    for (const a of state.agents) a.ownerUserId = "u-walter";
    state.aiStatus = { any: false, agents: [{ agentId: ATLAS_ID, state: "no_ai", reason: "no_key" }] };
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    machines?.pair({
      id: "machine_1",
      name: "MacBook",
      mode: "system",
      agents: state.agents.slice(0, 2).map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
    });
    const all = {
      ...base,
      id: "acct_all",
      label: "Claude",
      email: null,
      usedBy: ["Ada"],
      usedByIds: [ADA_ID],
      shared: true,
    };
    machines?.setAiAccounts({ accounts: [all], computers: [MAC] });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(6);
    const row = await opened(rows()[0]);
    expect(row.querySelector(".plan-shares__row")?.textContent).toBe("Ada · usa agora");
    await click(within(row).getByRole("button", { name: "Usar também para o Atlas" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ATLAS_ID, { brain: "claude_code", account: "acct_all" }],
    ]);
    expect(state.calls.some((c) => c.method === "machines.beginAccountLogin")).toBe(false);
    await click(within(row).getByRole("button", { name: "Desconectar" }));
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain("Para encerrar também no Claude, revogue nas configurações do Claude.");
  });
});
