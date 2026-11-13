import { describe, expect, test } from "bun:test";
import type { AgentAccess, AgentForYouItem, AgentStatusLine, Memory, OrgSummary, PlanUsage } from "@agenteschat/client";
import { listsAgent, mailLossText, widenQuestion } from "@agenteschat/client/lib/audience";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { planLine } from "@agenteschat/ui/plan-state";
import {
  byPlaybook,
  canEditMemories,
  dayWord,
  didLines,
  freeSections,
  knownAboutMe,
  memoryOrigin,
  modelRow,
  plainRole,
  statusCardShown,
  teamLines,
  usesOf,
  type WorkItem,
} from "../../src/features/agents/logic";
import { agent, translator } from "./fixtures";

const NOW = new Date(2026, 9, 17, 15, 0);
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const work = (agentId: string, since: string): WorkItem => ({
  key: `r:${agentId}`,
  agentId,
  kind: "run",
  what: "pesquisando os preços",
  channelId: "c1",
  threadId: null,
  where: { kind: "channel", name: "produto" },
  missionId: null,
  plan: null,
  since,
  waiting: false,
});

describe("Agentes: esperando você, trabalhando, livres", () => {
  const agents = [
    agent({ id: "theo", name: "Theo" }),
    agent({ id: "nina", name: "Nina" }),
    agent({ id: "iris", name: "Iris" }),
  ];

  test("an agent waiting on you goes first with the exact request, once, and leaves the other sections", () => {
    const { waiting, working, free } = teamLines(
      agents,
      [work("theo", ago(0.5)), work("nina", ago(0.4))],
      [],
      [
        { id: "a1", agentId: "theo", title: "Merge PR #128", createdAt: ago(0.1) },
        { id: "a2", agentId: "theo", title: "Deploy", createdAt: ago(0.2) },
        { id: "a3", agentId: "ghost", title: "x", createdAt: ago(0.2) },
      ],
    );
    expect(waiting.map((l) => [l.agent.id, l.approval?.title, l.waitingCount, l.at])).toEqual([
      ["theo", "Merge PR #128", 2, ago(0.1)],
    ]);
    expect(working.map((l) => l.agent.id)).toEqual(["nina"]);
    expect(free.map((l) => l.agent.id)).toEqual(["iris"]);
  });

  test("without requests it is the old split (nothing waiting)", () => {
    const { waiting, working, free } = teamLines(agents, [work("nina", ago(1))], []);
    expect(waiting).toEqual([]);
    expect(working.map((l) => l.agent.id)).toEqual(["nina"]);
    expect(free.map((l) => l.agent.id).sort()).toEqual(["iris", "theo"]);
  });

  test("Livres by the workspace's groups: the ones in none first, then each group in its order; empty ones left out", () => {
    const team = [...agents, agent({ id: "zoe", name: "Zoe" }), agent({ id: "ana", name: "Ana" })];
    const { working, free } = teamLines(team, [work("nina", ago(1))], []);
    const groups = [
      { id: "g1", name: "Integrations", agentIds: ["zoe", "nina", "theo"] },
      { id: "g2", name: "Produto", agentIds: ["nina"] },
      { id: "g3", name: "Lumen | Gestão e Financeiro", agentIds: ["ana"] },
    ];
    const sections = freeSections(free, groups);
    expect(sections.map((s) => [s.group?.name ?? null, s.lines.map((l) => l.agent.id)])).toEqual([
      [null, ["iris"]],
      ["Integrations", ["zoe", "theo"]],
      ["Lumen | Gestão e Financeiro", ["ana"]],
    ]);
    // A working agent stays under "Trabalhando agora", out of its group's section.
    expect(working.map((l) => l.agent.id)).toEqual(["nina"]);
    // No groups: Livres alone, as before.
    expect(freeSections(free, []).map((s) => [s.group, s.lines.length])).toEqual([[null, free.length]]);
    // Pinned ("Fixar no topo", the web's pins): first in their own section, so a setor keeps every agent in it.
    const pinned = freeSections(free, groups, ["theo", "nina", "ana"]);
    expect(pinned.map((s) => [s.group?.name ?? null, s.lines.map((l) => l.agent.id), s.pinnedCount])).toEqual([
      [null, ["iris"], 0],
      ["Integrations", ["theo", "zoe"], 1],
      ["Lumen | Gestão e Financeiro", ["ana"], 1],
    ]);
  });
});

describe("Perfil: o papel numa frase", () => {
  test("skips the prompt's self-introduction and keeps what follows the comma", () => {
    expect(plainRole("Você é o Theo, desenvolvedor do Time Lumen. Cuida do repositório.")).toBe(
      "Desenvolvedor do Time Lumen",
    );
    expect(plainRole("Você é a Nina.\nPesquisa mercado e concorrentes. Responda em português.")).toBe(
      "Pesquisa mercado e concorrentes",
    );
    expect(plainRole("You are Iris")).toBeNull();
  });

  test("what someone typed when creating it, plain, upper case first, short", () => {
    expect(plainRole("responder clientes no **e-mail** e me avisar quando algo for urgente")).toBe(
      "Responder clientes no e-mail e me avisar quando algo for urgente",
    );
    const long = plainRole(`cuida ${"de muitas coisas diferentes ".repeat(10)}`) ?? "";
    expect(long.length).toBeLessThanOrEqual(91);
    expect(long.endsWith("…")).toBe(true);
    expect(plainRole("")).toBeNull();
    expect(plainRole(undefined)).toBeNull();
  });
});

describe("Perfil: memórias", () => {
  const mem = (over: Partial<Memory> & { id: string }): Memory => ({
    agentId: "theo",
    kind: "preference",
    text: "Prefere publicar correções depois das 18h",
    source: "",
    uses: 0,
    lastUsedAt: null,
    pinned: false,
    archived: false,
    lowTrust: false,
    verified: true,
    supersedes: null,
    editedByUserId: null,
    updatedAt: ago(1),
    ...over,
  });

  test("only the agent's owner or who reviews memory may change them", () => {
    const theo = { ownerUserId: "u1" };
    const member = { permissions: ["read", "post"] };
    const reviewer = { permissions: ["read", "review_memory"] };
    expect(canEditMemories(theo, { id: "u1", org: member })).toBe(true);
    expect(canEditMemories(theo, { id: "u2", org: reviewer })).toBe(true);
    expect(canEditMemories(theo, { id: "u2", org: member })).toBe(false);
    expect(canEditMemories(theo, { id: "u2", org: undefined })).toBe(false);
    expect(canEditMemories({ ownerUserId: null }, { id: "u2", org: member })).toBe(false);
    expect(canEditMemories(theo, { id: null, org: reviewer })).toBe(false);
  });

  test("where it came from: said in your DM, in a channel, written by you, or learned", () => {
    const at = ago(2);
    expect(
      memoryOrigin(mem({ id: "1", from: { messageId: "m", channelId: "d", threadId: null, dm: true, at } }), "u1"),
    ).toEqual({ kind: "saidDm", at });
    expect(
      memoryOrigin(
        mem({
          id: "2",
          origin: { by: "agent", name: null, channel: "produto", at: ago(30) },
          from: { messageId: "m", channelId: "c", threadId: null, dm: false, at },
        }),
        "u1",
      ),
    ).toEqual({ kind: "saidChannel", channel: "produto", at });
    expect(
      memoryOrigin(
        mem({ id: "3", editedByUserId: "u1", origin: { by: "person", name: "W", channel: null, at } }),
        "u1",
      ),
    ).toEqual({ kind: "wrote", at });
    expect(memoryOrigin(mem({ id: "4", origin: { by: "agent", name: null, channel: null, at } }), "u1")).toEqual({
      kind: "learned",
      at,
    });
  });

  test("active ones, pinned first, then the newest", () => {
    const list = knownAboutMe([
      mem({ id: "old", updatedAt: ago(30) }),
      mem({ id: "gone", archived: true }),
      mem({ id: "new", updatedAt: ago(1) }),
      mem({ id: "pin", pinned: true, updatedAt: ago(90) }),
    ]);
    expect(list.map((m) => m.id)).toEqual(["pin", "new", "old"]);
    expect(knownAboutMe(undefined)).toEqual([]);
  });

  test("its playbook apart from what matters to people, in the same order", () => {
    const { people, playbook } = byPlaybook([
      mem({ id: "pref" }),
      mem({ id: "howto", playbook: true }),
      mem({ id: "fact", playbook: false }),
      mem({ id: "lesson", playbook: true }),
    ]);
    expect(people.map((m) => m.id)).toEqual(["pref", "fact"]);
    expect(playbook.map((m) => m.id)).toEqual(["howto", "lesson"]);
  });

  test("today, yesterday or the date", () => {
    expect(dayWord(ago(1), NOW)).toEqual({ kind: "today" });
    expect(dayWord(ago(24), NOW)).toEqual({ kind: "yesterday" });
    expect(dayWord(ago(24 * 5), NOW)).toEqual({ kind: "date", iso: ago(24 * 5) });
  });
});

describe("Perfil: o que fez por você", () => {
  const action = (kind: string, target: Record<string, unknown>, params: Record<string, unknown> = {}) =>
    ({
      type: "action",
      at: ago(1),
      channelId: "c1",
      action: {
        id: `x-${kind}`,
        kind,
        agentId: "theo",
        messageId: "m1",
        requestedByUserId: "u1",
        target,
        params,
        createdAt: ago(1),
        undoableUntil: ago(0.9),
        undoneAt: null,
        undoneByUserId: null,
        redoneAt: null,
      },
    }) as AgentForYouItem;

  test("receipts in the third person, files and approvals, each opening its place", () => {
    const lines = didLines([
      action("issue.created", { type: "issue", id: "i1", number: 131, title: "Login no Safari 15" }),
      action("memory.saved", { type: "memory", id: "k1" }, { text: "x" }),
      action("thread.closed", { type: "thread", id: "t1", title: "Erro" }),
      {
        type: "file",
        at: ago(2),
        file: { id: "f1", kind: "document", title: "Erros da semana", channelId: "c1", threadId: null },
      },
      {
        type: "approval",
        at: ago(0.1),
        approval: {
          id: "a1",
          title: "Merge PR #128",
          status: "pending",
          channelId: "c1",
          threadId: "t1",
          waitingOnYou: true,
        },
      },
      {
        type: "approval",
        at: ago(3),
        approval: {
          id: "a2",
          title: "Deploy",
          status: "refused",
          channelId: "c1",
          threadId: "t1",
          waitingOnYou: false,
        },
      },
    ]);
    expect(lines.map((l) => [l.title.key, l.title.values, l.sub, l.href, l.waiting])).toEqual([
      ["action.issueCreated", { number: "131" }, { text: "Login no Safari 15" }, { kind: "issue", number: 131 }, false],
      ["action.threadClosed", { title: "Erro" }, null, { kind: "chat", channelId: "c1", threadId: "t1" }, false],
      ["file", { title: "Erros da semana" }, { key: "fileKind.document" }, { kind: "file", id: "f1" }, false],
      ["approval", { title: "Merge PR #128" }, { key: "waitingOnYou" }, { kind: "approval", id: "a1" }, true],
      ["approval", { title: "Deploy" }, { key: "youRefused" }, { kind: "approval", id: "a2" }, false],
    ]);
    expect(didLines(undefined)).toEqual([]);
  });
});

describe("Perfil: o que pode usar", () => {
  const tool = (scope: string, state: string, sensitive = false) => ({
    name: scope,
    label: scope,
    description: "",
    readOnly: scope.endsWith("read"),
    connectionId: "c1",
    scope,
    sensitive,
    state,
  });

  test("apps and areas with their level in plain words; whether an action still asks", () => {
    const access = {
      all: false,
      builtins: [
        { scope: "drive:read", label: "Ler o Drive", state: "granted", tools: [tool("drive:read", "granted")] },
        { scope: "drive:write", label: "Escrever", state: "granted", tools: [tool("drive:write", "granted")] },
        { scope: "issues:read", label: "Ler issues", state: "off", tools: [tool("issues:read", "off")] },
      ],
      connectors: [
        {
          connectionId: "c1",
          connector: "github",
          label: "GitHub",
          custom: false,
          state: "granted",
          scopes: [
            { scope: "github:repo.read", label: "Ler", state: "granted", tools: [tool("github:repo.read", "granted")] },
            {
              scope: "github:pr.merge",
              label: "Merge",
              state: "granted",
              tools: [tool("github:pr.merge", "granted", true)],
            },
          ],
        },
        {
          connectionId: "c2",
          connector: "sentry",
          label: "Sentry",
          custom: false,
          state: "off",
          scopes: [
            {
              scope: "sentry:issues.read",
              label: "Ler",
              state: "granted",
              tools: [tool("sentry:issues.read", "granted")],
            },
            { scope: "sentry:issues.write", label: "Mudar", state: "off", tools: [tool("sentry:issues.write", "off")] },
          ],
        },
      ],
    } as unknown as AgentAccess;
    const { lines, asks } = usesOf(access);
    expect(lines.map((l) => [l.label, l.level])).toEqual([
      [{ text: "GitHub" }, "write"],
      [{ text: "Sentry" }, "read"],
      [{ area: "drive" }, "write"],
    ]);
    expect(asks).toBe(true);
    expect(usesOf(null)).toEqual({ lines: [], asks: false });
  });
});

describe("Perfil: o mês, com os limites do plano (ADR 0063 §5)", () => {
  const usage = (windows: PlanUsage["windows"]): PlanUsage => ({ windows, source: "probe", at: NOW.toISOString() });

  test("the compact line in the plan's words, tightest first; near the limit, when it renews; nothing unknown", async () => {
    const pt = planMeterText(await translator("pt-BR"), "pt-BR", NOW);
    const en = planMeterText(await translator("en"), "en", NOW);
    const both = usage([
      { kind: "five_hour", usedPercent: 12 },
      { kind: "seven_day", usedPercent: 40 },
    ]);
    expect(planLine(both, pt, NOW.getTime())?.line).toBe("semana 40% · 5h 12%");
    expect(planLine(both, en, NOW.getTime())?.line).toBe("week 40% · 5h 12%");
    expect(planLine(both, pt, NOW.getTime())?.alert).toBeNull();
    // The profile's month row keeps the tightest window alone as its value.
    const top = planLine(both, pt, NOW.getTime())?.top;
    expect(top ? `${pt.short(top)} ${top.used}%` : null).toBe("semana 40%");
    const soon = new Date(NOW.getTime() + 90 * 60_000).toISOString();
    expect(planLine(usage([{ kind: "five_hour", usedPercent: 92, resetsAt: soon }]), pt, NOW.getTime())?.alert).toBe(
      "Quase no limite · renova às 16:30",
    );
    expect(planLine(usage([]), pt, NOW.getTime())).toBeNull();
    // Refused before any window was known: no bar, only that it is at the limit.
    expect(planLine({ ...usage([]), limited: true }, pt, NOW.getTime())).toMatchObject({
      line: "",
      alert: "No limite",
    });
  });

  test("the screen: one row for the month, the plan's account named first, the budget only once it spent through the API", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const read = (file: string) => Bun.file(new URL(`../../src/features/${file}`, import.meta.url).pathname).text();
    const [screen, parts] = await Promise.all([read("agents/AgentProfileScreen.tsx"), read("usage/parts.tsx")]);
    expect(screen).toContain("const shown = usageShown(agent?.brain, detail.data?.budgetUsedPercent ?? 0);");
    // Its name: the plan's account, else the plan, else its model; its value: the plan's tightest window.
    expect(screen).toContain("shown.plan?.account ?? thinksPlan ?? thinks?.text ?? apiModel");
    expect(screen).toContain("const planNow = shown.plan ? planLine(shown.plan.usage, meter, now) : null;");
    expect(screen).toContain("meter.short(planNow.top)");
    // The budget only where it shows, its share as the web says it ("<1%" for a little spent).
    expect(screen).toContain("if (!spend || !shown.budget) return null;");
    expect(screen.match(/formatPercent\(i18n\.language, spend\.percent\)/g)).toHaveLength(1);
    // No meter card and no separate usage card: the row itself opens the usage page.
    expect(screen).not.toContain("<PlanMeter");
    expect(screen).toContain("onPress={() => openAgentUsage(id)}");
    // The phone's meter draws the same line as the web's (`planLine`).
    expect(parts).toContain("const shown = planLine(usage, text, now);");
    // The budget is never called a limit next to a plan's limits.
    const t = await translator("pt-BR");
    expect(t("mobile.agent.ofMonthBudget")).toBe("do orçamento do mês");
    expect(t("mobile.agent.exhaustedF", { name: "Ada" })).toBe("A Ada usou todo o orçamento do mês.");
    expect(t("settings.usageAgentLine", { spent: "US$ 3,20", budget: "US$ 50,00" })).toBe("US$ 3,20 de US$ 50,00");
  });

  test("Pensa com: the plan as the row's name, the model and a fixed model's effort under it, on two lines", async () => {
    const screen = await Bun.file(
      new URL("../../src/features/agents/AgentProfileScreen.tsx", import.meta.url).pathname,
    ).text();
    expect(screen).toContain("label={thinksPlan ?? thinks.text}");
    expect(screen).toContain("{...(thinksUnder ? { sub: thinksUnder, subLines: 2 } : {})}");
    expect(screen).toContain("!isAuto(effortView.effectiveModel)");
    const t = await translator("pt-BR");
    expect(t("agentPage.work.cell.effort", { level: "médio" })).toBe("esforço médio");
  });

  test("the bars as the web colors them: each window by its own level, the words and the compact bar by the plan's", async () => {
    const parts = await Bun.file(new URL("../../src/features/usage/parts.tsx", import.meta.url).pathname).text();
    expect(parts).toContain('const tone = c[PLAN_TONE[planLevel(shown.top?.used ?? 0, shown.state === "limited")]];');
    expect(parts).toContain('{ color: c[PLAN_TONE[planLevel(used, state === "limited")]] }');
    expect(parts).toContain("const level = planLevel(w.used);");
    expect(parts.match(/color=\{tone\}/g)).toHaveLength(2);
  });

  test("an account's name wraps beside its plan's tag, and whose it is too, as on the web: never an ellipsis", async () => {
    const parts = await Bun.file(new URL("../../src/features/usage/parts.tsx", import.meta.url).pathname).text();
    const head = parts.slice(parts.indexOf("export function AccountHead("), parts.indexOf("function Tag("));
    expect(head).toContain("{accountName(t, account)}");
    expect(head).not.toContain("numberOfLines");
    expect(parts).toMatch(/acctName: \{ flexDirection: "row", flexWrap: "wrap",/);
  });

  test("an agent's usage by account: the figures under the account, as on the web's phone width, never a narrow column", async () => {
    const screen = await Bun.file(
      new URL("../../src/features/usage/AgentUsageScreen.tsx", import.meta.url).pathname,
    ).text();
    expect(screen).toContain("source: { gap: 6, paddingVertical: 12 },");
    expect(screen).toContain('n: { alignItems: "flex-start" },');
    expect(screen).not.toContain("maxWidth: 110");
  });
});

describe("Perfil: agora, cada coisa uma vez", () => {
  const line = (by: AgentStatusLine["by"], kind: AgentStatusLine["kind"] = null) => ({ by, kind });
  const idle = { working: false, asking: false };

  test("its own words and out of office always; the server's work line only with no job row; a wait unless it is the request shown", () => {
    expect(statusCardShown(null, idle)).toBe(false);
    expect(statusCardShown(line("self"), { working: true, asking: true })).toBe(true);
    expect(statusCardShown(line("auto", "out_of_plan"), { working: true, asking: false })).toBe(true);
    expect(statusCardShown(line("auto", "coding"), { working: true, asking: false })).toBe(false);
    expect(statusCardShown(line("auto", "coding"), idle)).toBe(true);
    expect(statusCardShown(line("wait", "waiting_approval"), { working: false, asking: true })).toBe(false);
    expect(statusCardShown(line("wait", "waiting_approval"), idle)).toBe(true);
    expect(statusCardShown(line("wait", "waiting_plan"), { working: false, asking: true })).toBe(true);
  });

  test("the screen: three views, the request as the shared card and out of the list, the jobs as rows, no pills", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const read = (file: string) => Bun.file(new URL(`../../src/features/${file}`, import.meta.url).pathname).text();
    const [screen, mail, computer] = await Promise.all([
      read("agents/AgentProfileScreen.tsx"),
      read("agents/AgentMailSection.tsx"),
      read("computer/AgentComputerRow.tsx"),
    ]);
    expect(screen).toContain('{ key: "today", label: t("common.today") }');
    expect(screen).toContain('{ key: "access", label: t("agentPage.fields.levels") }');
    expect(screen).toContain('{ key: "memory", label: t("agentPage.tabs.memory") }');
    expect(screen).toContain('kind={{ icon: "shield", label: t("mobile.intentAgents.asksApproval") }}');
    expect(screen).toContain('!(waitingNow && l.href?.kind === "approval" && l.href.id === waitingNow.id)');
    expect(screen).toContain("statusCardShown(statusLine, { working: busy, asking: asking.length > 0 })");
    expect(screen).toContain("<PixelOrbit color={look.color} size={14} />");
    // One surface level: grouped lists on the gray, no pills, sections or cards of its own.
    expect(screen).not.toContain("NowPill");
    expect(screen).not.toMatch(/<(Section|Card|Row)\b/);
    // Mailboxes are rows of "Can use"; the computer is a named button beside Chat, as wide as it.
    expect(mail).toContain("export function useAgentMailboxes(agentId: string, enabled = true): MailboxLine[]");
    expect(screen).toContain(
      "{details && !rightHand ? (\n              <View style={styles.grow}>\n                <AgentComputerButton agentId={id} />",
    );
    expect(computer).toContain('wide\n      label={helps ? t("agentComputer.help") : t("agentComputer.button")}');
    // The screen's recent picture on Today; the rules people gave on Memory, under what it learned; where it merges on
    // Access; the right hand's own AI above how it works: each in the grouped lists, none a section of its own.
    expect(screen).toContain("      {nowBlock}\n      <AgentComputerPicture agentId={id} />");
    expect(computer).toContain("asksPicture(focused, view.desktopQ.data ?? null)");
    expect(screen).toContain(
      "      {knows.data ? memoryKnows : null}\n      {/* What people told it to always do, under what it learned, as the web's Memória. */}\n      <GivenRules agentId={id} name={name} />",
    );
    expect(screen).toContain(
      '<MergeReposSection agentId={id} name={name} mayEdit={mine || can(org, "manage_agents")} />',
    );
    expect(screen).toContain(
      '<GroupedHeader>{t("rightHand.settings.mine")}</GroupedHeader>\n            <RightHandMine',
    );
    const t = await translator("pt-BR");
    const tabs = [t("common.today"), t("agentPage.fields.levels"), t("agentPage.tabs.memory")];
    expect(tabs).toEqual(["Hoje", "Acesso", "Memória"]);
    expect(t("ask.kind.approval")).toBe("Pede sua aprovação");
    expect(t("mobile.intentAgents.asksApproval")).toBe("Pede sua aprovação");
    expect(t("mobile.agent.canUse")).toBe("Pode usar");
  });
});

describe("an agent that doesn't answer me", () => {
  const kept = agent({ id: "ada", name: "Ada", canTalk: false });
  const admin = { permissions: ["manage_agents", "talk_to_agents"] } as unknown as OrgSummary;
  const member = { permissions: ["talk_to_agents"] } as unknown as OrgSummary;

  test("Conversar on its page opens the locked conversation for who manages agents, not for a member outside", () => {
    expect(listsAgent(admin, kept)).toBe(true);
    expect(listsAgent(member, kept)).toBe(false);
    expect(listsAgent(member, { ...kept, canTalk: true })).toBe(true);
  });

  test("letting more people in asks first, naming whose mailboxes it would lose, each person once", async () => {
    const t = await translator("pt-BR");
    const box = (accountId: string, ownerName: string | null, address = `${accountId}@acme.com`) => ({
      accountId,
      address,
      ownerUserId: ownerName ? `u-${ownerName}` : null,
      ownerName,
    });
    expect(t("reach.mailLossTitle")).toBe("Tirar o acesso à caixa de email?");
    expect(mailLossText(t, kept, [box("joao", "João"), box("vendas", "João"), box("bia", "Bia")])).toStartWith(
      "Ada tem acesso à caixa de email de João e Bia. Com mais pessoas falando com ela,",
    );
    // Its connector left the workspace: the address names it.
    expect(mailLossText(t, { name: "Theo" }, [box("x", null, "suporte@acme.com")])).toStartWith(
      "Theo tem acesso à caixa de email de suporte@acme.com. Com mais pessoas falando com ele,",
    );
  });

  test("on someone else's plan the one question names whose plan it uses and that they get an email, the mailboxes after", async () => {
    const t = await translator("pt-BR");
    const onPlan = { name: "Ada", brain: { kind: "codex" } as NonNullable<typeof kept.brain> };
    const box = { accountId: "joao", address: "joao@acme.com", ownerUserId: "u-joao", ownerName: "João" };
    expect(widenQuestion(t, onPlan, "João", [])).toEqual({
      title: "Usar o plano de João?",
      description:
        "As conversas com Ada vão usar o plano do ChatGPT de João e os limites dele. João vai receber um email avisando.",
    });
    expect(widenQuestion(t, onPlan, "João", [box])?.description).toContain(
      "João vai receber um email avisando. Ada tem acesso à caixa de email de João.",
    );
    const screen = await Bun.file(new URL("../../src/features/chat/ReachLines.tsx", import.meta.url).pathname).text();
    expect(screen.match(/ask\(audience\)/g)).toHaveLength(2);
  });
});

describe("Perfil: the Modelo row says how it thinks on the value's line (#44)", () => {
  test("through the API: the model, then Pela API; on a plan: the plan's model, then the plan", async () => {
    const pt = await translator("pt-BR");
    expect(modelRow(pt, undefined, "Claude Sonnet 4.5")).toEqual({ value: "Claude Sonnet 4.5", valueNote: "Pela API" });
    expect(modelRow(pt, { kind: "model", model: null }, "Automático")).toEqual({
      value: "Automático",
      valueNote: "Pela API",
    });
    expect(modelRow(pt, { kind: "claude_code", model: "Sonnet" }, "Claude Sonnet 4.5")).toEqual({
      value: "Sonnet",
      valueNote: "Claude",
    });
    expect(modelRow(pt, { kind: "claude_code", model: "auto" }, "Claude Sonnet 4.5").value).toBe("Automático");
    // Automático through the API: the maker its models come from, then Automático.
    expect(modelRow(pt, { kind: "model", model: null, maker: "anthropic" }, "Automático")).toEqual({
      value: "Claude",
      valueNote: "Automático",
    });
    // The profile names Automático by its key's maker already (`apiModelName`): the note still says Automático.
    expect(modelRow(pt, { kind: "model", model: null, maker: "anthropic" }, "Claude").valueNote).toBe("Automático");
  });
});
