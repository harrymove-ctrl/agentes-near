import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { LearnedSkill, PlanUsage, Run } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  agentSearch,
  changedKeys,
  channelsAfter,
  isRoutineRun,
  lineChanges,
  revertKey,
  runMatches,
  type Saved,
} from "@/lib/agent-edit";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const DESIGN_ID = "00000000-0000-4000-8000-0000000000c9";

const go = async (query = "", state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}${query}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** Radix tabs activate on mouse down; the tabs not in the bar are in its "More" menu (opened on pointer down). */
const openTab = async (name: RegExp) => {
  const tabs = screen().getByRole("tablist", { name: "Seções da Ada" });
  const tab = within(tabs).queryByRole("tab", { name });
  if (tab) {
    await act(async () => fireEvent.mouseDown(tab, { button: 0 }));
    await settle(4);
    return;
  }
  await act(async () =>
    fireEvent.pointerDown(within(tabs).getByRole("button", { name: /^Mais/ }), { button: 0, ctrlKey: false }),
  );
  await settle(2);
  // Named by its button: "Mais", or "Mais 2" while those tabs hold unsaved changes.
  await click(within(screen().getByRole("menu", { name: /^Mais/ })).getByRole("menuitem", { name }));
  await settle(2);
};
const saveBar = () => screen().queryByRole("region", { name: "Alterações não salvas" });
/** The hidden text of the ⓘ named `About <label>`. */
const hintText = (inside: HTMLElement, label: string) => {
  const about = within(inside).getByRole("button", { name: `Sobre ${label}` });
  return document.getElementById(about.getAttribute("aria-describedby") ?? "")?.textContent;
};
const CONTEXT_RULE =
  "O contexto da Acme (o que a empresa faz, regras da casa) entra antes destas instruções em toda conversa: escreva aqui só o que é da Ada.";
const asMember = (state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
/** I (Walter) am a member and Ada's owner. */
const asOwner = () => {
  const state = asMember();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.ownerUserId = "u-walter";
  return state;
};
const updates = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2]);

describe("agent page: tabs and the URL", () => {
  test("four tabs and More; the chosen one goes to ?tab=; a link opens a tab; the memory tab counts the proposal", async () => {
    const { router } = await go();
    const tabs = screen().getByRole("tablist", { name: "Seções da Ada" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Visão geral", "Instruções", "Memória1", "Atividade"]);
    // The rest are in More; the one opened from there shows in the bar, and More keeps the others.
    await openTab(/^Uso/);
    expect(router.state.location.search).toMatchObject({ tab: "usage" });
    expect(
      within(screen().getByRole("tablist", { name: "Seções da Ada" }))
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Visão geral", "Instruções", "Memória1", "Atividade", "Uso"]);
    await act(async () =>
      fireEvent.pointerDown(
        within(screen().getByRole("tablist", { name: "Seções da Ada" })).getByRole("button", { name: /^Mais/ }),
        { button: 0, ctrlKey: false },
      ),
    );
    await settle(2);
    expect(
      within(screen().getByRole("menu", { name: "Mais" }))
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["Ferramentas e acesso", "Arquivos", "Configurações"]);
    await act(async () => fireEvent.keyDown(screen().getByRole("menu", { name: "Mais" }), { key: "Escape" }));
    await settle(2);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    await openTab(/^Atividade/);
    expect(router.state.location.search).toMatchObject({ tab: "activity" });
    expect(screen().getByRole("searchbox", { name: "Buscar execuções" })).toBeTruthy();
    // The month on top: runs per day in pixels, the numbers as its legend (from the server's counts).
    const month = screen().getByRole("region", { name: /^O mês de / });
    expect(within(month).getByRole("img", { name: /^142 execuções em / })).toBeTruthy();
    expect(month.querySelector("canvas.ac-month-runs")).toBeTruthy();
    expect(month.querySelector(".agp-month__legend")?.textContent).toContain("142");
    cleanup();
    await go("?tab=memory");
    expect(
      within(screen().getByRole("tablist", { name: "Seções da Ada" }))
        .getByRole("tab", { name: /^Memória/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen().getByRole("article", { name: "Atualizar as instruções da Ada" })).toBeTruthy();
  });

  test("the cover with its actions; the face on its edge with the name and @ beside it; Como trabalha in the overview", async () => {
    await go();
    const hero = document.querySelector(".agp-hero") as HTMLElement;
    const cover = hero.querySelector(".agp-cover") as HTMLElement;
    // No status pill.
    expect(hero.textContent).not.toContain("Esperando aprovação");
    expect(hero.querySelector(".agp-face")).toBeTruthy();
    // How it works is the overview's Ficha, never under the name; its usage row says the money.
    const work = screen().getByRole("region", { name: "Como trabalha" });
    expect(hero.contains(work)).toBe(false);
    expect(work.closest(".agp-overview")).toBeTruthy();
    expect(hero.querySelector(".agp-idrow .agp-face + .agp-ident")).toBeTruthy();
    expect(work.textContent).toContain("US$\u00a012,30");
    expect(work.textContent).toContain("de US$\u00a040");
    expect(within(cover).getByRole("link", { name: "Conversar" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dm/agent/${ADA_ID}`,
    );
    expect(within(cover).getByRole("button", { name: "Mais ações" })).toBeTruthy();
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Ada");
    expect(hero.querySelector(".agp-handle")?.textContent).toContain("@ada");
    expect(work.textContent).toContain("Pela API");
  });
});

describe("agent page: what it does", () => {
  test("what it does and how it works: the workspace context rule is the title's ⓘ, not a line or a note", async () => {
    await go();
    const does = screen().getByRole("region", { name: "O que a Ada faz" });
    expect(hintText(does, "O que a Ada faz")).toBe(CONTEXT_RULE);
    expect(does.querySelector(".ac-card__foot")).toBeNull();
    cleanup();
    await go("?tab=instructions");
    const how = screen().getByRole("region", { name: "Como a Ada trabalha" });
    expect(hintText(how, "Como a Ada trabalha")).toBe(CONTEXT_RULE);
    // Under the field, only the character count; beside it, no note.
    expect(how.querySelector(".newag__ta-meta")?.children).toHaveLength(1);
    expect(document.querySelector(".newag__note")).toBeNull();
  });

  test("someone who can't edit reads the instructions drawn as Markdown, never its marks", async () => {
    const state = asMember();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada)
      ada.instructions = [
        "## Papel",
        "Revisa PRs, **sempre** com teste.",
        "Responde em português.",
        "",
        "- Investiga primeiro",
        "- Abre PRs pequenos",
        "",
        // The worst case a pasted file brings: an unbroken address, another script, an emoji.
        `Docs: https://example.com/${"a".repeat(240)} · 日本語のメモ 🙂`,
      ].join("\n");
    await go("?tab=instructions", state);
    const how = screen().getByRole("region", { name: "Como a Ada trabalha" });
    expect(within(how).queryByRole("textbox")).toBeNull();
    expect(how.textContent).not.toMatch(/##|\*\*|- Investiga/);
    expect([...how.querySelectorAll("strong")].map((b) => b.textContent)).toContain("sempre");
    expect([...how.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Investiga primeiro",
      "Abre PRs pequenos",
    ]);
    // Its own lines stay lines, as written.
    expect(how.querySelector(".md p:not(.md__h)")?.textContent).toBe(
      "Revisa PRs, sempre com teste.\nResponde em português.",
    );
    expect(how.textContent).toContain("日本語のメモ 🙂");
  });

  test("the start of its instructions in whole sentences, never a full stop before the ellipsis", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada)
      ada.instructions =
        "Investiga primeiro: lê o código e as tarefas e erros relacionados antes de responder, e volta com o que achou e uma proposta concreta de PR com teste.\nTrabalha em branches e abre PRs pequenos; para mudanças grandes, abre o PR como rascunho e explica o plano ali.\nNunca faz merge sozinho: pede revisão a uma pessoa.";
    await go("", state);
    const does = screen().getByRole("region", { name: "O que a Ada faz" });
    const text = does.querySelector(".agp-prose")?.textContent ?? "";
    expect(text).toEndWith("explica o plano ali.");
    expect(text).not.toContain("…");
    expect(text).not.toContain("Nunca faz merge");
  });

  test("instructions in Markdown (an imported agent's) read as plain words, in three lines at most", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada)
      ada.instructions = [
        "# SOUL.md - Quem você é",
        "",
        "_Você não é um chatbot. Você está se tornando alguém._",
        "",
        "## Verdades",
        "",
        "- **Ajude de verdade.** Pule o “Ótima pergunta!” e ajude.",
        "- Tenha opiniões.",
        "- Seja cuidadosa com o que é dos outros.",
        "- Lembre do que importa.",
      ].join("\n");
    await go("", state);
    const does = screen().getByRole("region", { name: "O que a Ada faz" });
    expect(does.querySelector(".agp-prose")?.textContent).toBe(
      "Você não é um chatbot. Você está se tornando alguém.\nAjude de verdade. Pule o “Ótima pergunta!” e ajude.\nTenha opiniões.",
    );
  });
});

describe("agent page: its files", () => {
  test("Arquivos lists the Drive files it made or changed, filters by kind, and opens one", async () => {
    await go("?tab=files");
    const card = screen().getByRole("region", { name: "Arquivos da Ada" });
    expect(card.textContent).toContain("Corrige o checkout com carrinho vazio");
    // Another agent's file isn't here.
    expect(card.textContent).not.toContain("Organograma do time");
    expect(card.textContent).toContain("Só aparecem arquivos de conversas que você vê.");
    expect(within(card).getByRole("radiogroup", { name: "Tipo" })).toBeTruthy();
  });
});

describe("agent page: its usage (ADR 0063)", () => {
  test("Uso: the month by account, the account it thinks with now with its part, and by account", async () => {
    await go("?tab=usage");
    const month = screen().getByRole("region", { name: "Uso da Ada" });
    // The MacBook's own sign-in, the viewer's: the account their agents share, as the Connect cards name it.
    expect(month.textContent).toContain("97% na conta que os seus agentes dividem e 2,6% pela API.");
    expect(month.textContent).toContain("Pelo preço da API, seria ≈ US$\u00a077,00.");
    expect(within(month).getByRole("img", { name: /^Tokens por dia em / })).toBeTruthy();
    const now = screen().getByRole("region", { name: "Agora" });
    expect(now.textContent).toContain("A conta que os seus agentes dividem");
    expect(now.textContent).toContain("divide com Atlas");
    // Its part of each window in full ink, and in words; the estimate says so.
    const week = within(now).getByRole("meter", { name: "Semana" });
    expect(week.getAttribute("aria-valuenow")).toBe("41");
    expect(week.querySelector(".ac-meter__part")?.getAttribute("style")).toContain("width: 30%");
    expect(now.textContent).toContain("Parte da Ada: ≈ 30%");
    expect(now.textContent).toContain("é uma estimativa");
    // It informs: changing the account is "Quem pensa"'s.
    expect(within(now).queryByRole("button")).toBeNull();
    const sources = screen().getByRole("region", { name: "Por conta, este mês" });
    expect(sources.textContent).toContain("≈ US$\u00a076,00 pelo preço da API");
    expect(sources.textContent).toContain("US$\u00a00,80 pagos");
  });

  test("a member sees the tokens and the percentages, never money", async () => {
    await go("?tab=usage", asMember());
    const month = screen().getByRole("region", { name: "Uso da Ada" });
    expect(month.textContent).toContain("97% na conta que os seus agentes dividem");
    expect(screen().getByRole("region", { name: "Por conta, este mês" }).textContent).toContain("2% do orçamento");
    const shown = ["Uso da Ada", "Agora", "Por conta, este mês"].map(
      (name) => screen().getByRole("region", { name }).textContent,
    );
    expect(shown.join(" ")).not.toContain("US$");
  });
});

describe("agent page: the budget on the overview", () => {
  test("the Ficha's budget row opens Orçamento in a dialog: Save saves it, Cancel puts it back", async () => {
    const { state } = await go("?tab=overview");
    const work = screen().getByRole("region", { name: "Como trabalha" });
    await click(within(work).getByRole("button", { name: "Orçamento" }));
    const dialog = screen().getByRole("dialog", { name: "Orçamento" });
    await type(within(dialog).getByRole("textbox", { name: /^Orçamento mensal/ }), "55,5");
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen().queryByRole("dialog", { name: "Orçamento" })).toBeNull();
    expect(saveBar()).toBeNull();
    await click(within(work).getByRole("button", { name: "Orçamento" }));
    const again = screen().getByRole("dialog", { name: "Orçamento" });
    await type(within(again).getByRole("textbox", { name: /^Orçamento mensal/ }), "55,5");
    await click(within(again).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(updates(state)).toEqual([{ monthlyBudgetUsd: 55.5 }]);
    expect(screen().queryByRole("dialog", { name: "Orçamento" })).toBeNull();
  });

  test("the Ficha's rows open their dialogs: who answers, who may talk, channels, what it may use", async () => {
    const { router } = await go("?tab=overview");
    const work = screen().getByRole("region", { name: "Como trabalha" });
    const team = screen().getByRole("region", { name: "Com quem" });
    // Its channels are names as written: no capital on the letter after the # (a sentence's value gets one).
    const channels = within(team).getByRole("button", { name: "Canais" }).querySelector(".agp-cell__value");
    expect(channels?.textContent).toMatch(/^#/);
    expect(channels?.hasAttribute("data-name")).toBe(true);
    expect(within(team).getByRole("button", { name: "Responsável" }).querySelector("[data-name]")).toBeNull();
    for (const [row, title] of [
      ["Responsável", "Responsável"],
      ["Quem pode falar", "Quem pode falar com a Ada"],
      ["Canais", "Canais"],
    ] as const) {
      const button = within(team).getByRole("button", { name: row });
      await click(button);
      expect(button.getAttribute("data-open")).toBe("true");
      const dialog = screen().getByRole("dialog", { name: title });
      await click(within(dialog).getByRole("button", { name: "Cancelar" }));
      expect(screen().queryByRole("dialog", { name: title })).toBeNull();
    }
    await click(within(work).getByRole("button", { name: "Pode usar" }));
    const uses = screen().getByRole("dialog", { name: "Pode usar" });
    await click(within(uses).getByRole("button", { name: "Mudar acessos" }));
    expect(router.state.location.search).toMatchObject({ tab: "access" });
  });

  test("a member reads who thinks from the agent (no computer)", async () => {
    const state = asMember();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "claude_code", model: "Sonnet" };
    await go("", state);
    const work = screen().getByRole("region", { name: "Como trabalha" });
    // The plan that pays for it in the label, the model under it.
    expect(work.textContent).toContain("Pensa com ClaudeSonnet");
    // A member doesn't see where it works or its browser.
    expect(work.textContent).not.toContain("Trabalha");
  });
});

describe("agent page: a plan's limits where the budget was (ADR 0063 §5)", () => {
  const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const LIMITS: PlanUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 12, resetsAt: hours(2) },
      { kind: "seven_day", usedPercent: 40, resetsAt: hours(72) },
    ],
    source: "probe",
    at: new Date().toISOString(),
  };
  /** Ada thinks with Claude Team; `spent`: what she spent through the API this month. */
  const onPlan = (spent: number, usage: PlanUsage | null = LIMITS) => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.brain = {
        kind: "claude_code",
        model: "Sonnet",
        account: "Claude Team",
        ...(usage ? { usage } : {}),
      };
    }
    state.spentUsd = { [ADA_ID]: spent };
    return state;
  };
  const line = (el: Element) => el.querySelector(".ac-planmeter__line")?.textContent;

  test("on a plan: its account's tightest windows and one bar, and no budget while it spent nothing through the API", async () => {
    const { router } = await go("", onPlan(0));
    const work = screen().getByRole("region", { name: "Como trabalha" });
    expect(line(work)).toBe("Claude Team · semana 40% · 5h 12%");
    expect(within(work).getByRole("meter", { name: "Semana" }).getAttribute("aria-valuenow")).toBe("40");
    expect(work.textContent).not.toMatch(/orçamento|US\$/);
    // Its row's dialog: the same line, nothing called a budget, and the rest in Uso.
    expect(within(work).queryByRole("button", { name: "Orçamento" })).toBeNull();
    await click(within(work).getByRole("button", { name: "Uso" }));
    const card = screen().getByRole("dialog", { name: "Uso" });
    expect(line(card)).toBe("Claude Team · semana 40% · 5h 12%");
    expect(card.textContent).not.toMatch(/orçamento|US\$/);
    await click(within(card).getByRole("button", { name: "Ver tudo" }));
    expect(router.state.location.search).toMatchObject({ tab: "usage" });
  });

  test("on a plan that also spent through the API: the plan's limits first, the budget after them", async () => {
    await go("", onPlan(12.3));
    const work = screen().getByRole("region", { name: "Como trabalha" }).textContent ?? "";
    expect(work.indexOf("Claude Team · semana 40%")).toBeGreaterThanOrEqual(0);
    expect(work.indexOf("Claude Team · semana 40%")).toBeLessThan(work.indexOf("US$\u00a012,30 de US$\u00a040"));
    await click(screen().getByRole("button", { name: "Uso" }));
    const card = screen().getByRole("dialog", { name: "Uso" });
    expect(card.textContent).toMatch(/Claude Team · semana 40% · 5h 12%.*US\$\u00a012,30 de US\$\u00a040 em /);
  });

  test("on the API: the budget as before, and no plan line", async () => {
    await go();
    const work = screen().getByRole("region", { name: "Como trabalha" });
    expect(work.querySelector(".ac-planmeter")).toBeNull();
    expect(work.textContent).toContain("US$\u00a012,30");
    expect(within(work).getByRole("button", { name: "Orçamento" })).toBeTruthy();
    expect(within(work).queryByRole("button", { name: "Uso" })).toBeNull();
  });

  test("a plan whose windows aren't known yet shows nothing rather than 0%", async () => {
    await go("", onPlan(0, null));
    const work = screen().getByRole("region", { name: "Como trabalha" });
    expect(work.querySelector(".ac-planmeter")).toBeNull();
    expect(work.textContent).not.toMatch(/orçamento|US\$/);
    expect(within(work).queryByRole("button", { name: "Uso" })).toBeNull();
    expect(within(work).queryByRole("button", { name: "Orçamento" })).toBeNull();
  });

  test("near the limit it says when the window renews", async () => {
    const almost: PlanUsage = {
      ...LIMITS,
      windows: [{ kind: "five_hour", usedPercent: 92, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString() }],
    };
    await go("", onPlan(0, almost));
    await click(screen().getByRole("button", { name: "Uso" }));
    const card = screen().getByRole("dialog", { name: "Uso" });
    expect(line(card)).toBe("Claude Team · 5h 92%");
    expect(card.querySelector(".ac-planmeter__state")?.textContent).toMatch(
      /^Quase no limite · renova (\S+ )?às \d\d:\d\d$/,
    );
  });

  test("Atividade: the month's numbers leave the money out until it spends through the API", async () => {
    const legend = () =>
      screen()
        .getByRole("region", { name: /^O mês de / })
        .querySelector(".agp-month__legend")?.textContent ?? "";
    await go("?tab=activity", onPlan(0));
    expect(legend()).toContain("142");
    expect(legend()).not.toMatch(/Gasto|Orçamento|US\$/);
    cleanup();
    await go("?tab=activity", onPlan(12.3));
    expect(legend()).toContain("Gasto");
    expect(legend()).toContain("US$\u00a012,30");
  });
});

describe("agent page: who edits what", () => {
  test("members read: values, not inputs; never money; no runs", async () => {
    await go("?tab=settings", asMember());
    expect(document.body.textContent).toContain("Você vê como a Ada trabalha.");
    expect(screen().queryByLabelText("Nome")).toBeNull();
    expect(screen().queryByRole("group", { name: "Cor" })).toBeNull();
    expect(screen().queryByRole("combobox", { name: "Responsável" })).toBeNull();
    expect(document.body.textContent).toContain("Só admins mudam");
    expect(document.body.textContent).toContain("Só admins veem o gasto dos agentes e mudam o limite.");
    // The model says its cost as a tier, never in dollars.
    expect(document.body.textContent).not.toContain("US$");
    await openTab(/^Visão geral/);
    expect(document.body.textContent).not.toContain("US$");
    await openTab(/^Ferramentas/);
    expect(screen().queryByRole("radiogroup", { name: "Nível em GitHub" })).toBeNull();
    await openTab(/^Atividade/);
    expect(document.body.textContent).toContain("Só admins e João veem as execuções.");
    expect(saveBar()).toBeNull();
  });

  test("the owner changes the look, audience and computer, not access; the save sends only what they may", async () => {
    const { state } = await go("?tab=settings", asOwner());
    expect(screen().queryByLabelText("Nome")).toBeNull();
    expect(document.body.textContent).toContain("Você é responsável da Ada");
    // The look is right on the page: colors, then the eyes and what it wears as sliding rows.
    await click(within(screen().getByRole("group", { name: "Cor" })).getByRole("button", { name: "Rosa" }));
    expect(saveBar()?.textContent).toContain("1 alteração");
    await openTab(/^Instruções/);
    expect(screen().queryByRole("textbox", { name: "Instruções" })).toBeNull();
    expect(document.body.textContent).toContain("Só admins editam as instruções.");
    // Access is an admin's call, like the agent's scopes: the owner reads it.
    await openTab(/^Ferramentas/);
    expect(screen().queryByRole("radiogroup", { name: "Nível em GitHub" })).toBeNull();
    expect(document.body.textContent).toContain("Só admins dão ou tiram acessos e repositórios.");
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(updates(state)).toEqual([{ appearance: { color: "rose", eyes: "round", accessory: "none" } }]);
  });

  test("the owner puts it in and takes it out of the channels they're in; the others show as they are", async () => {
    const state = asOwner();
    // An admin put Ada in #design, which I'm not in.
    state.channels.push({
      id: DESIGN_ID,
      name: "design",
      topic: "",
      visibility: "public",
      isMember: false,
      createdAt: NOW.toISOString(),
    });
    state.channelMembers[DESIGN_ID] = [{ type: "agent", id: ADA_ID }];
    await go("?tab=settings&sec=channels", state);
    const card = document.getElementById("agp-sec-channels") as HTMLElement;
    expect(within(card).queryByRole("checkbox", { name: "#design" })).toBeNull();
    expect(card.querySelector(".agp-chips")?.textContent).toBe("design");
    expect(hintText(card, "Canais")).toBe("Você muda só os canais em que está. Para mexer em outro, entre nele antes.");
    await click(within(card).getByRole("checkbox", { name: "#general" }));
    await click(within(card).getByRole("checkbox", { name: "#eng" }));
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "agents.setChannels")?.args[2]).toEqual([
      { channelId: DESIGN_ID, autoReply: true },
      { channelId: GENERAL_ID },
    ]);
  });
});

describe("agent page: inline editing and the save bar", () => {
  test("changes add up in one bar: count, names, Ver (old → new, Desfazer), Alterado on the card, Descartar", async () => {
    await go("?tab=instructions");
    const box = screen().getByRole("textbox", { name: "Instruções" });
    // The server's cap: typing stops there, never a refusal after saving.
    expect(box.getAttribute("maxlength")).toBe("50000");
    await type(box, "Instruções de Ada.\nAbre PRs pequenos.");
    const card = box.closest("section") as HTMLElement;
    expect(card.getAttribute("data-changed")).toBe("true");
    expect(card.textContent).toContain("Alterado");
    await click(within(card).getByRole("button", { name: "Ver o que mudou" }));
    expect(within(card).getByRole("group", { name: "O que mudou nas instruções" }).textContent).toContain(
      "Abre PRs pequenos.",
    );
    expect(
      within(screen().getByRole("tablist", { name: "Seções da Ada" })).getByRole("tab", { name: /^Instruções/ })
        .textContent,
    ).toBe("Instruções1");
    await openTab(/^Configurações/);
    // The name edits in place: its button opens the field, Enter keeps what was typed.
    await click(screen().getByRole("button", { name: /^Editar nome/ }));
    await type(screen().getByLabelText("Nome"), "Ada Lovelace");
    await act(async () => fireEvent.keyDown(screen().getByLabelText("Nome"), { key: "Enter" }));
    const bar = saveBar() as HTMLElement;
    // A new name moves the @ too.
    expect(bar.textContent).toContain("3 alterações");
    expect(bar.textContent).toContain("Nome, Menções e Instruções");
    await click(within(bar).getByRole("button", { name: "Ver" }));
    const list = screen().getByRole("dialog", { name: "O que mudou" });
    expect(list.textContent).toContain("1 linha nova");
    expect(list.textContent).toContain("Ada → Ada Lovelace");
    expect(list.textContent).toContain("@ada → @adalovelace");
    await click(within(list).getByRole("button", { name: "Desfazer: Nome" }));
    expect(document.getElementById("agp-name")?.textContent).toBe("Ada");
    expect(saveBar()?.textContent).toContain("1 alteração");
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: "Descartar" }));
    expect(saveBar()).toBeNull();
  });

  test("Salvar: one PATCH, one access write for every level, the channels kept, then a toast", async () => {
    const { state } = await go("?tab=access");
    const github = screen().getByRole("radiogroup", { name: "Nível em GitHub" });
    await click(within(github).getByRole("radio", { name: "Ler e escrever" }));
    const row = github.closest("li") as HTMLElement;
    expect(row.textContent).toContain("Alterado");
    expect(row.textContent).toContain("Antes: Sem acesso");
    const skills = screen().getByRole("radiogroup", { name: "Nível em Skills" });
    const other = within(skills)
      .getAllByRole("radio")
      .find((r) => r.getAttribute("aria-checked") !== "true") as HTMLElement;
    await click(other);
    await openTab(/^Configurações/);
    await type(screen().getByRole("textbox", { name: /^Orçamento mensal/ }), "55,5");
    await click(screen().getByRole("checkbox", { name: "#general" }));
    expect(saveBar()?.textContent).toContain("4 alterações");
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(8);
    expect(updates(state)).toEqual([{ monthlyBudgetUsd: 55.5 }]);
    const writes = state.calls.filter((c) => c.method === "access.set");
    expect(writes).toHaveLength(1);
    expect((writes[0]?.args[2] as { connectors: Record<string, boolean> } | undefined)?.connectors).toEqual({
      "conn-gh": true,
    });
    expect(state.calls.find((c) => c.method === "agents.setChannels")?.args[2]).toEqual([
      { channelId: ENG_ID, autoReply: true },
      { channelId: GENERAL_ID },
    ]);
    expect(document.body.textContent).toContain("Alterações da Ada salvas.");
    expect(saveBar()).toBeNull();
  });

  test("Conectores: 'Ler e escrever' gives every connector full access in one click, saved in one write", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // A server Ada only reads, beside GitHub, which she doesn't use.
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    const server = res.server.id;
    await api.customConnectors.saveTools(ORG_ID, server, {
      label: "Suporte",
      tools: res.server.tools.map((x) => ({ name: x.name, access: x.sensitive ? "approval" : "read", label: x.name })),
    });
    await api.access.set(ORG_ID, ADA_ID, {
      all: false,
      connectors: {},
      scopes: [
        { connectionId: null, scope: "memory:write" },
        { connectionId: server, scope: `custom:${server}:read` },
      ],
      tools: { allow: [], deny: [] },
    });
    state.calls.length = 0;
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(8);
    const level = (name: string) =>
      within(screen().getByRole("radiogroup", { name: `Nível em ${name}` }))
        .getAllByRole("radio")
        .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;
    expect([level("GitHub"), level("Suporte")]).toEqual(["Sem acesso", "Ler"]);
    // One control over the list, from its own edge: no level chosen while the rows differ.
    const all = screen().getByRole("radiogroup", { name: "Conectores" });
    expect(all.closest(".newag__quick")).toBeTruthy();
    expect(
      within(all)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Sem acesso", "Só ler", "Ler e escrever"]);
    expect(within(all).queryByRole("radio", { checked: true })).toBeNull();
    await click(within(all).getByRole("radio", { name: "Ler e escrever" }));
    expect(within(all).getByRole("radio", { checked: true }).textContent).toBe("Ler e escrever");
    expect([level("GitHub"), level("Suporte")]).toEqual(["Ler e escrever", "Ler e escrever"]);
    expect(saveBar()?.textContent).toContain("2 alterações");
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(8);
    const writes = state.calls.filter((c) => c.method === "access.set");
    expect(writes).toHaveLength(1);
    const input = writes[0]?.args[2] as { connectors: Record<string, boolean>; scopes: { scope: string }[] };
    expect(input.connectors).toEqual({ "conn-gh": true, [server]: true });
    expect(input.scopes.map((g) => g.scope)).toEqual(["memory:write"]);
  });

  test("Conectores: two accounts of one service are two rows, each by its name and with its own level", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const connect = async () => {
      const res = await api.customConnectors.connect(ORG_ID, {
        serverUrl: "https://oauth.zapier.example/mcp",
        label: "Zapier",
        returnTo: "/",
      });
      if (res.status !== "connected") throw new Error("expected connected");
      await api.customConnectors.saveTools(ORG_ID, res.server.id, {
        label: res.server.label,
        tools: res.server.tools.map((x) => ({
          name: x.name,
          access: x.sensitive ? "approval" : "read",
          label: x.name,
        })),
      });
      return res.server.id;
    };
    const first = await connect();
    const second = await connect();
    await api.access.set(ORG_ID, ADA_ID, {
      all: false,
      connectors: { [first]: true },
      scopes: [{ connectionId: second, scope: `custom:${second}:read` }],
      tools: { allow: [], deny: [] },
    });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(8);
    const level = (name: string) =>
      within(screen().getByRole("radiogroup", { name: `Nível em ${name}` }))
        .getAllByRole("radio")
        .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;
    expect([level("Zapier"), level("Zapier 2")]).toEqual(["Ler e escrever", "Ler"]);
  });

  test("⌘S saves; an invalid budget blocks it and says why", async () => {
    const { state } = await go("?tab=settings&sec=budget");
    const budget = screen().getByRole("textbox", { name: /^Orçamento mensal/ });
    await type(budget, "0");
    expect(saveBar()?.textContent).toContain("Use um valor maior que zero.");
    await act(async () => fireEvent.keyDown(document, { key: "s", metaKey: true }));
    await settle(4);
    expect(updates(state)).toEqual([]);
    await type(budget, "");
    await act(async () => fireEvent.keyDown(document, { key: "s", ctrlKey: true }));
    await settle(6);
    expect(updates(state)).toEqual([{ monthlyBudgetUsd: null }]);
  });

  test("leaving with unsaved changes asks first", async () => {
    const { router } = await go("?tab=instructions");
    await type(screen().getByRole("textbox", { name: "Instruções" }), "Outra coisa.");
    await act(async () => {
      router.history.push(`/org/${ORG_ID}/approvals`);
    });
    await settle(4);
    const ask = screen().getByRole("dialog", { name: "Sair sem salvar?" });
    expect(ask.textContent).toContain("Há 1 alteração não salva da Ada.");
    await click(within(ask).getByRole("button", { name: "Continuar editando" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
    expect(screen().getByRole("textbox", { name: "Instruções" })).toBeTruthy();
    await act(async () => {
      router.history.push(`/org/${ORG_ID}/approvals`);
    });
    await settle(4);
    await click(
      within(screen().getByRole("dialog", { name: "Sair sem salvar?" })).getByRole("button", {
        name: "Descartar e sair",
      }),
    );
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/approvals`);
  });
});

describe("agent page: memory and proposals", () => {
  test("Aceitar mudança uses the proposals API", async () => {
    const { state } = await go("?tab=memory");
    const card = screen().getByRole("article", { name: "Atualizar as instruções da Ada" });
    expect(card.textContent).toContain("Aguardando você");
    await click(within(card).getByRole("button", { name: "Aceitar mudança" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "proposals.accept")?.args).toEqual([ORG_ID, "prop-1", undefined]);
    expect(document.body.textContent).toContain("Mudança aceita. As instruções foram atualizadas.");
  });

  test("a skill it asked to change counts on its page, and is decided there as proposed", async () => {
    const state = seedState();
    const prop = state.proposals.find((p) => p.id === "prop-1");
    if (!prop) throw new Error("no proposal");
    prop.target = { type: "skill", agentId: prop.agentId, skillId: "sk-1", name: "relatorios" };
    await go("?tab=memory", state);
    const card = screen().getByRole("article", { name: "Corrigir a skill relatorios" });
    expect(within(card).queryByRole("button", { name: "Editar antes" })).toBeNull();
    await click(within(card).getByRole("button", { name: "Aceitar mudança" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "proposals.accept")?.args).toEqual([ORG_ID, "prop-1", undefined]);
  });

  test("a reason the server wrote reads in the person's language on the agent's page too", async () => {
    const state = seedState();
    const prop = state.proposals.find((p) => p.id === "prop-1");
    if (prop) Object.assign(prop, { why: "", whyCode: "seen" });
    await go("?tab=memory", state);
    const card = screen().getByRole("article", { name: "Atualizar as instruções da Ada" });
    expect(card.textContent).toContain("O agente notou isso mais de uma vez.");
  });

  test("Editar antes de aceitar sends the final text; Recusar refuses", async () => {
    const { state } = await go("?tab=memory");
    const card = screen().getByRole("article", { name: "Atualizar as instruções da Ada" });
    await click(within(card).getByRole("button", { name: "Editar antes de aceitar" }));
    await type(within(card).getByLabelText("Texto final das instruções"), "Só PRs pequenos.");
    await click(within(card).getByRole("button", { name: "Aceitar com ajustes" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "proposals.accept")?.args).toEqual([
      ORG_ID,
      "prop-1",
      "Só PRs pequenos.",
    ]);
    cleanup();
    const second = await go("?tab=memory");
    await click(
      within(screen().getByRole("article", { name: "Atualizar as instruções da Ada" })).getByRole("button", {
        name: "Recusar",
      }),
    );
    await settle(4);
    expect(second.state.calls.find((c) => c.method === "proposals.refuse")?.args).toEqual([ORG_ID, "prop-1"]);
  });

  test("a proposal someone else decides names who: the person, or an admin", async () => {
    const state = seedState();
    const prop = state.proposals.find((p) => p.id === "prop-1");
    if (!prop) throw new Error("no prop-1");
    prop.canDecide = false;
    await go("?tab=memory", state);
    const card = () => screen().getByRole("article", { name: "Atualizar as instruções da Ada" });
    expect(within(card()).queryByRole("button", { name: "Aceitar mudança" })).toBeNull();
    expect(within(card()).getByText("João decide.")).toBeTruthy();
    cleanup();
    prop.decider = { type: "admins" };
    await go("?tab=memory", state);
    expect(within(card()).getByText("Um admin decide.")).toBeTruthy();
  });

  test("the side column is one link to how memory works", async () => {
    await go("?tab=memory");
    const link = screen().getByRole("link", { name: "Como a memória funciona" });
    expect(link.getAttribute("href")).toBe("https://agentes.chat/pt/docs/memory");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.closest(".agp-col")?.textContent).toBe("Como a memória funciona");
    const card = screen().getByRole("article", { name: "Atualizar as instruções da Ada" });
    expect(card.textContent).toContain("Recusar ensina a Ada a não propor isso de novo.");
  });

  test("what it knows: kinds and search", async () => {
    await go("?tab=memory");
    const kinds = screen().getByRole("radiogroup", { name: "Tipo" });
    expect(
      within(kinds)
        .getAllByRole("radio")
        // The count is a separate chip (CountChip): no text space between label and number.
        .map((r) => r.textContent?.replace(/(\D)(\d+)$/, "$1 $2")),
    ).toEqual(["Fatos e decisões 4", "Lições 2", "Aprendizados", "Arquivados 1"]);
    await type(screen().getByRole("searchbox", { name: "Buscar" }), "zzz-nada");
    expect(document.body.textContent).toContain("Nada encontrado com “zzz-nada”.");
  });

  test("what it learned: its own saves with where and how sure, and Esquecer archives one", async () => {
    const state = seedState();
    const mine = state.memories.find((m) => m.agentId === ADA_ID && !m.archived);
    if (!mine) throw new Error("no memory");
    Object.assign(mine, {
      learned: true,
      howTo: true,
      lowTrust: false,
      verified: false,
      text: "GET the models with the key.",
    });
    await go("?tab=memory", state);
    await click(
      within(screen().getByRole("radiogroup", { name: "Tipo" })).getByRole("radio", { name: /Aprendizados/ }),
    );
    const row = screen().getByText("GET the models with the key.").closest("li") as HTMLElement;
    expect(row.textContent).toContain("Como fazer");
    expect(row.textContent).toContain("Não verificado");
    await click(within(row).getByRole("button", { name: "Esquecer" }));
    expect(state.memories.find((m) => m.id === mine.id)?.archived).toBe(true);
  });

  test("Dar a outros agentes opens that skill in Skills, only for who may open Skills", async () => {
    const made: LearnedSkill = {
      id: "sk-made",
      name: "relatorio-semanal",
      description: "Monta o relatório da semana",
      version: 1,
      source: "manual",
      sourceUrl: null,
      defaultForNewAgents: false,
      metadata: {},
      origin: "agent",
      ownerAgentId: ADA_ID,
      locked: false,
      useCount: 2,
      lastUsedAt: null,
      body: "# Relatório",
      archived: false,
      canChange: true,
      canRevert: false,
      createdAt: "2026-11-01T12:00:00.000Z",
      updatedAt: "2026-11-01T12:00:00.000Z",
    };
    const open = async (state: ReturnType<typeof seedState>) => {
      const api = createFakeApi(state);
      api.skills.learned = async () => [made];
      await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=memory`, { api });
      await settle(8);
      await click(
        within(screen().getByRole("radiogroup", { name: "Tipo" })).getByRole("radio", { name: /Aprendizados/ }),
      );
    };
    await open(seedState());
    expect(screen().getByRole("link", { name: "Dar a outros agentes" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/skills?skill=sk-made`,
    );
    cleanup();
    // Ada's owner, a member: Travar is theirs, but Skills is for who manages agents.
    await open(asOwner());
    expect(screen().getByRole("button", { name: "Travar" })).toBeTruthy();
    expect(screen().queryByRole("link", { name: "Dar a outros agentes" })).toBeNull();
  });

  test("its own how-tos sit under how it works: the plain summary first, the technical text folded", async () => {
    const state = seedState();
    const mine = state.memories.find((m) => m.agentId === ADA_ID && !m.archived);
    if (!mine) throw new Error("no memory");
    Object.assign(mine, {
      learned: true,
      howTo: true,
      playbook: true,
      summary: "Como gravar senhas no Supabase sem expô-las",
      text: "supabase secrets set KEY=… then read Deno.env.get in supabase/functions/_shared/env.ts",
    });
    await go("?tab=memory", state);
    await click(
      within(screen().getByRole("radiogroup", { name: "Tipo" })).getByRole("radio", { name: /Aprendizados/ }),
    );
    const list = screen().getByRole("list", { name: "Como a Ada trabalha" });
    // Its heading is the kit's list heading, the note behind the ⓘ beside it, not a sentence under it.
    const group = list.parentElement as HTMLElement;
    expect(group.querySelector(":scope > .ac-grouphead > h3 > .ac-hintline > :first-child")?.textContent).toBe(
      "Como a Ada trabalha",
    );
    expect(hintText(group, "Como a Ada trabalha")).toStartWith("Jeitos de trabalhar que guardou para si.");
    expect(group.querySelector(":scope > p")).toBeNull();
    const row = within(list).getByText("Como gravar senhas no Supabase sem expô-las").closest("li") as HTMLElement;
    const details = row.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Detalhes técnicos");
    expect(details.textContent).toContain("supabase/functions/_shared/env.ts");
  });
});

describe("agent page: activity", () => {
  const extra = (over: Partial<Run>): Run => ({
    id: "run-x",
    agentId: ADA_ID,
    channelId: ENG_ID,
    threadId: "m-1",
    trigger: "mention",
    status: "done",
    error: null,
    what: "",
    turns: 1,
    inputTokens: 100,
    outputTokens: 10,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...over,
  });

  test("what started a run reads as words: no list or bold marks", async () => {
    const state = seedState();
    state.runs.push(extra({ id: "run-md", what: "- **Verificado:** o login\n- **Mudou:** nada" }));
    await go("?tab=activity", state);
    const runs = screen().getByRole("region", { name: "Execuções" });
    expect(runs.textContent).toContain("Verificado: o login");
    expect(runs.textContent).not.toContain("**");
    expect(runs.textContent).not.toContain("- Verificado");
  });

  test("by day, with tokens; filters for failures and waiting; search", async () => {
    const state = seedState();
    state.runs.push(
      extra({ id: "run-f", what: "roda a suíte de checkout", status: "failed", errorCode: "run.budget_exceeded" }),
      extra({
        id: "run-k",
        what: "resume o canal",
        status: "failed",
        errorCode: "run.missing_credential",
        errorParams: { provider: "Claude" },
      }),
      extra({ id: "run-w", what: "faz o merge do PR #42", status: "waiting_approval" }),
    );
    await go("?tab=activity", state);
    const runs = screen().getByRole("region", { name: "Execuções" });
    expect(runs.textContent).toContain("@ada o login está devolvendo 401");
    // New input, cached and output tokens per run (the 1.240 of the run, split).
    expect(runs.textContent).toContain("1.140 entrada · 0 cache · 100 saída");
    expect(within(runs).getByRole("region", { name: "Hoje" })).toBeTruthy();
    // Each day under the kit's list heading, the days 24 apart, as Auditoria's.
    expect(runs.querySelector(".ac-groups > section > .ac-grouphead")?.textContent).toBe("Hoje");
    const filters = within(runs).getByRole("radiogroup", { name: "Filtrar execuções" });
    await click(within(filters).getByRole("radio", { name: /^Falhas/ }));
    expect(runs.textContent).toContain("roda a suíte de checkout");
    expect(runs.textContent).toContain("O orçamento do mês acabou.");
    expect(runs.textContent).toContain("Falta uma chave Claude no workspace.");
    expect(runs.textContent).not.toContain("faz o merge");
    await click(within(filters).getByRole("radio", { name: /^Esperando/ }));
    expect(runs.textContent).toContain("faz o merge do PR #42");
    expect(runs.textContent).not.toContain("roda a suíte");
    await click(within(filters).getByRole("radio", { name: "Todas" }));
    await type(within(runs).getByRole("searchbox", { name: "Buscar execuções" }), "PR #39");
    expect(runs.textContent).toContain("Mostrando 1 de 1.");
    // Admins see what the month cost.
    expect(document.body.textContent).toContain("US$\u00a012,30");
  });
});

describe("agent page rules", () => {
  const saved: Saved = {
    name: "Ada",
    handle: "ada",
    role: "Dev",
    look: { color: "sky", eyes: "round", accessory: "none" },
    instructions: "a\nb",
    model: "m",
    owner: "u1",
    audience: { mode: "everyone", userIds: [] },
    levels: { "connector:gh": "none", "area:skills": "read" },
    budget: null,
    channels: ["c1"],
  };

  test("only real differences count; undo removes one", () => {
    expect(changedKeys(saved, { name: "Ada", budget: "" })).toEqual([]);
    const edits = { name: "Ada L", levels: { "connector:gh": "write" as const, "area:skills": "read" as const } };
    // A new name moves the @ too (`handleAfterRename`).
    expect(changedKeys(saved, edits).map((c) => c.key)).toEqual(["name", "handle", "levels:connector:gh"]);
    expect(changedKeys(saved, revertKey(edits, "levels:connector:gh")).map((c) => c.key)).toEqual(["name", "handle"]);
    expect(changedKeys(saved, { budget: "40" }).map((c) => c.key)).toEqual(["budget"]);
    expect(changedKeys(saved, { audience: { mode: "people", userIds: [] } }).map((c) => c.key)).toEqual(["audience"]);
  });

  test("channels: the PUT keeps DMs, private channels and auto-reply", () => {
    const current = [
      { id: "c1", autoReply: false },
      { id: "dm", autoReply: true },
    ];
    expect(channelsAfter(current, ["c1"], ["c2"])).toEqual([{ channelId: "dm", autoReply: true }, { channelId: "c2" }]);
    expect(channelsAfter(current, ["c1"], ["c1", "c2"])).toEqual([
      { channelId: "c1", autoReply: false },
      { channelId: "dm", autoReply: true },
      { channelId: "c2" },
    ]);
  });

  test("routine runs, filters, line counts and the URL", () => {
    const r = { what: "@ada Resuma a semana do #eng" };
    expect(isRoutineRun(r, ["Resuma a semana do #eng"], "ada")).toBe(true);
    expect(isRoutineRun(r, [""], "ada")).toBe(false);
    // A run in a conversation the viewer isn't in has no text; the server's flag still marks it.
    expect(isRoutineRun({ what: "", routine: true }, [], "ada")).toBe(true);
    const run = { status: "failed", what: "x" } as Run;
    expect(runMatches(run, "failed", "", { where: "#eng", routine: false })).toBe(true);
    expect(runMatches(run, "routines", "", { where: "#eng", routine: false })).toBe(false);
    expect(runMatches(run, "all", "eng", { where: "#eng", routine: false })).toBe(true);
    expect(lineChanges("a\nb", "a\nc\nb")).toEqual({ added: 1, removed: 0 });
    expect(agentSearch({ tab: "memory", sec: "nope" })).toEqual({ tab: "memory", sec: undefined });
    // The old "Modelo e chave" anchor lands on "Quem pensa".
    expect(agentSearch({ tab: "settings", sec: "model" })).toEqual({ tab: "settings", sec: "brain" });
  });
});
