import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBrain, Credential, MachineAccount, PlanUsage } from "@agenteschat/client";
import { newAgentStart } from "@agenteschat/client/lib/agent-setup";
import { accountTitle, ownSignInTitle } from "@agenteschat/client/lib/ai-accounts";
import { setupPlanQuestion } from "@agenteschat/client/lib/audience";
import { CURSOR_KEY_PLAN, geminiPersonal, planOf, planReplies, signInKey } from "@agenteschat/client/lib/plans";
import { markOf } from "@agenteschat/ui/brand/marks";
import type { TFunction } from "i18next";
import {
  accountInput,
  accountKindOf,
  accountRow,
  accountSaved,
  agentAccounts,
  existingRows,
  flowBack,
  modelInput,
  modelRows,
  modelSections,
  newAgentAi,
  pickedAi,
  setupWords,
  takenFrom,
  thinkingUsage,
} from "../../src/features/ai/logic";
import { translator } from "./fixtures";

const usage = (used: number): PlanUsage => ({
  windows: [{ kind: "five_hour", usedPercent: used }],
  source: "turn",
  at: "2026-10-27T12:00:00.000Z",
});

const account = (id: string, over: Partial<MachineAccount> = {}): MachineAccount => ({
  id,
  kind: "claude_code",
  label: id,
  email: null,
  plan: "max",
  status: "active",
  ownerId: "u1",
  ownerName: "Walter Nogueira",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  ...over,
});

type View = Pick<AgentBrain, "accounts" | "account" | "ownSignIn" | "ownUsage">;

describe("the agent's AI", () => {
  test("only a plan brain has accounts to pick", () => {
    expect(accountKindOf("claude_code")).toBe("claude_code");
    expect(accountKindOf("codex")).toBe("codex");
    expect(accountKindOf("model")).toBeNull();
    expect(accountKindOf(undefined)).toBeNull();
  });

  test("its page lists its owner's accounts of that kind, to an admin too, and someone else's only while it's this agent's", () => {
    const view: View = {
      account: "theirs-now",
      ownSignIn: false,
      ownUsage: {},
      accounts: [
        account("mine"),
        account("codex", { kind: "codex" }),
        account("theirs", { mine: false, ownerId: "u2" }),
        account("theirs-now", { mine: false, ownerId: "u2" }),
      ],
    };
    const owner = { ...view, canUsePlans: true };
    expect(agentAccounts(owner, "claude_code", "u1").map((a) => a.id)).toEqual(["mine", "theirs-now"]);
    expect(agentAccounts(owner, "codex", "u1").map((a) => a.id)).toEqual(["codex"]);
    // An admin of u1's agent: u1's, never their own.
    const admin = { ...view, account: null, canUsePlans: false };
    expect(agentAccounts(admin, "claude_code", "u1").map((a) => a.id)).toEqual(["mine"]);
  });

  test("who may use other people's plans sees a teammate's too, never one another agent has (ADR 0059 §3)", async () => {
    const t = await translator("pt-BR");
    const view = {
      account: null,
      ownSignIn: false,
      ownUsage: {},
      canUsePlans: false,
      canUseOthersPlans: true,
      accounts: [
        account("owners"),
        account("bias", { mine: false, ownerId: "u2", ownerName: "Bia" }),
        account("busy", { mine: false, ownerId: "u3", usedBy: ["Theo"] }),
        account("all", { mine: false, ownerId: "u3", usedBy: ["Theo"], shared: true }),
        account("out", { mine: false, ownerId: "u3", status: "signed_out" }),
      ],
    };
    expect(agentAccounts(view, "claude_code", "u1", "Ada").map((a) => a.id)).toEqual(["owners", "bias", "all"]);
    expect(agentAccounts({ ...view, canUseOthersPlans: false }, "claude_code", "u1", "Ada").map((a) => a.id)).toEqual([
      "owners",
    ]);
    // Connect an AI's first rows: Bia's in one tap, whose it is under it; one another agent has stays locked.
    const rows = existingRows(t, view, [], "Ada").map((r) => [r.row.kind === "key" ? "key" : r.row.act, r.sub]);
    expect(rows).toContainEqual(["use", "De Bia"]);
    expect(rows.filter(([act]) => act === "locked")).toHaveLength(2);
  });

  test("the usage shown is its account's, or the computer's own sign-in's only where that thinks for it", () => {
    const base: View = { account: "a1", ownSignIn: true, ownUsage: { claude_code: usage(40) }, accounts: [] };
    expect(thinkingUsage({ ...base, accounts: [account("a1", { usage: usage(90) })] }, "claude_code")).toEqual(
      usage(90),
    );
    expect(thinkingUsage({ ...base, accounts: [account("a1")] }, "claude_code")).toBeUndefined();
    expect(thinkingUsage({ ...base, account: null }, "claude_code")).toEqual(usage(40));
    expect(thinkingUsage({ ...base, account: null, ownSignIn: false }, "claude_code")).toBeUndefined();
    expect(thinkingUsage({ ...base, account: null }, "codex")).toBeUndefined();
  });

  test("picking an account another agent thinks with takes it from that one, unless it is for all of them", () => {
    expect(takenFrom(account("a", { usedBy: ["Infra"] }), "Dev")).toEqual(["Infra"]);
    expect(takenFrom(account("a", { usedBy: ["Dev"] }), "Dev")).toEqual([]);
    expect(takenFrom(account("a", { usedBy: ["Infra"], shared: true }), "Dev")).toEqual([]);
  });

  test("the line under Atende outras pessoas follows the switch: its key by state, for one agent or all of them", () => {
    const keyOf = ((key: string) => key) as unknown as TFunction;
    const line = (on: boolean, agent: string | null) => planReplies(keyOf, { on, agent, brain: "claude_code" }).line;
    expect([line(false, "Ada"), line(true, "Ada"), line(false, null), line(true, null)]).toEqual([
      "aiAccounts.share.line.off",
      "aiAccounts.share.line.on",
      "aiAccounts.share.line.offAll",
      "aiAccounts.share.line.onAll",
    ]);
  });

  test("its words: whom the agent answers in each state and on which plan, the plan's terms behind the ⓘ", async () => {
    const en = await translator("en");
    const pt = await translator("pt-BR");
    const says = (t: TFunction, on: boolean, over: Partial<Parameters<typeof planReplies>[1]> = {}) =>
      planReplies(t, { on, agent: "Ada", brain: "claude_code", plan: "max", ...over });
    expect(says(en, false)).toEqual({
      line: "Ada answers only you, on your Claude plan.",
      about: "About the plan's terms",
      text: "Claude plans are for personal use. Letting other people use yours is a gray area in Claude's terms.",
    });
    expect(says(en, true).line).toBe("Ada answers anyone who can talk to her, on your Claude plan.");
    expect(says(pt, false)).toEqual({
      line: "A Ada só atende você, pelo seu plano do Claude.",
      about: "Sobre os termos do plano",
      text: "Os planos do Claude são para uso pessoal. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do Claude.",
    });
    expect(says(pt, true).line).toBe("A Ada atende quem pode falar com ela, pelo seu plano do Claude.");
    // A Grok plan (ADR 0142): the same note, in Grok's name.
    expect(says(en, false, { brain: "grok", plan: null })).toEqual({
      line: "Ada answers only you, on your Grok plan.",
      about: "About the plan's terms",
      text: "Grok plans are for personal use. Letting other people use yours is a gray area in Grok's terms.",
    });
    expect(says(pt, false, { brain: "grok", plan: null }).text).toBe(
      "Os planos do Grok são para uso pessoal. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do Grok.",
    );
    // A Gemini Enterprise seat (ADR 0143): a seat's usual words; a personal plan has Google's warning, said plainly.
    expect(says(en, false, { brain: "antigravity", plan: "enterprise" }).line).toBe(
      "Ada answers only you, on your Gemini seat.",
    );
    expect(pt("connectAi.plan.gemini.warning")).toBe(
      "O Google diz que usar um plano pessoal do Gemini dentro de outros apps pode suspender a conta. Para não correr esse risco, use uma chave de API ou o Gemini Enterprise.",
    );
    expect(geminiPersonal({ provider: "enterprise" })).toBe(false);
    expect(geminiPersonal(undefined)).toBe(true);
    expect(says(pt, true, { agent: "Theo" }).line).toBe(
      "O Theo atende quem pode falar com ele, pelo seu plano do Claude.",
    );
    // Every agent of a plan's panel.
    expect([false, true].map((on) => says(en, on, { agent: null }).line)).toEqual([
      "They answer only you, on your Claude plan.",
      "They answer anyone who can talk to them, on your Claude plan.",
    ]);
    expect([false, true].map((on) => says(pt, on, { agent: null }).line)).toEqual([
      "Só atendem você, pelo seu plano do Claude.",
      "Atendem quem pode falar com eles, pelo seu plano do Claude.",
    ]);
    // ChatGPT's plan, a seat, a coding plan by its name in its maker's words.
    expect(says(en, false, { brain: "codex", plan: null }).line).toBe("Ada answers only you, on your ChatGPT plan.");
    expect(says(en, false, { plan: "Team" })).toMatchObject({
      line: "Ada answers only you, on your Claude seat.",
      text: "Each Claude seat is for one person. Letting other people use yours is a gray area in Claude's terms.",
    });
    expect(says(pt, false, { plan: "team" }).line).toBe("A Ada só atende você, pelo seu assento do Claude.");
    const glm = planOf("zai");
    expect(says(en, true, { coding: glm })).toMatchObject({
      line: "Ada answers anyone who can talk to her, on your GLM Coding plan.",
      text: "Z.ai says the plan is for its subscriber only. Letting other people use yours is a gray area in Z.ai's terms.",
    });
    expect(says(pt, false, { coding: glm }).line).toBe("A Ada só atende você, pelo seu plano GLM Coding.");
    // The phone's header over it.
    expect([en("mobile.ai.audience", { context: "female" }), pt("mobile.ai.audience", { context: "female" })]).toEqual([
      "Who she answers",
      "Quem ela atende",
    ]);
  });

  test("the new agent's AI step: Conectar uma IA opens the same sheet as Settings, for the agent being made", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const read = (path: string) => Bun.file(new URL(`../../src/features/${path}`, import.meta.url).pathname).text();
    const [screen, sheet] = await Promise.all([read("agents/NewAgentScreen.tsx"), read("ai/ConnectAi.tsx")]);
    expect(screen).toContain('label={t("aiAccounts.page.connect")}');
    expect(screen).toContain('openConnectAi({ forNew: "1" });');
    // The plan it connects is what the agent thinks with once it shows up, over a pick made before; nothing new keeps it.
    expect(screen).toContain("newPlanAccountOption(brainOptions, optionsBefore)");
    expect(screen).toContain("connectedHere ?? picked");
    // For the agents I create: none of mine is offered, so a plan signs in for the new one.
    expect(sheet).toMatch(/params\.forNew === "1"\s*\? \[\]/);
    expect(sheet).toContain("queryKey: keys.brainMachines(orgId)");
  });

  test("under a hold, Uso's empty plans card says what comes first and invites no plan", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const usage = await Bun.file(new URL("../../src/features/usage/UsageScreen.tsx", import.meta.url).pathname).text();
    expect(usage).toContain("usePlanHold(orgId, org)");
    expect(usage.indexOf("<PlanHoldNote")).toBeGreaterThan(-1);
    expect(usage.indexOf("<PlanHoldNote")).toBeLessThan(usage.indexOf('place="ai"'));
    expect(usage).toContain("data.accounts.length === 0 && hold ?");
  });

  test("the agent's AI and a plan's page draw the same switch, line and ⓘ, and nothing asks to accept the terms", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    // The agent's switch is in its advanced settings (ADR 0086).
    const [screen, connect, parts] = await Promise.all([
      read("AgentAdvancedScreen.tsx"),
      read("ConnectAiSteps.tsx"),
      read("parts.tsx"),
    ]);
    for (const source of [screen, connect]) {
      expect(source).toMatch(/import \{[^}]*\bPlanReplies\b[^}]*\} from "\.\/parts"/);
      expect(source).toContain("<PlanReplies");
      expect(source).not.toMatch(/acceptPlanTerms|share\.title|share\.accept|connectAi\.onlyYou|own\.note/);
    }
    // One switch, its line under it saying what its state does, with the ⓘ, the plan's words behind it.
    expect(parts).toContain('label={t("aiAccounts.share.switch")}');
    expect(parts).toContain("planReplies(t, { on, agent, owner, brain, plan, coding })");
    expect(parts).toMatch(
      /<InfoHint\s+name=\{t\("common\.about", \{ label: t\("aiAccounts\.share\.terms\.about"\) \}\)\}\s+text=\{says\.text\}[^>]*>\s*<Text[^>]*>\s*\{says\.line\}/,
    );
    // The line names the agent.
    expect(screen).toMatch(/<PlanReplies\s+agent=\{name\}/);
    expect(connect).toMatch(/<PlanReplies\s+agent=\{done\?\.agent \?\? agent\?\.name \?\? ""\}/);
    // An admin who isn't the plan's owner gets the same switch, its line naming whose plan it is.
    expect(screen).toContain("owner={view.canUsePlans ? undefined : ownerFirst}");
    expect(screen).not.toContain("PlanRepliesOf");
    // On a plan's page: under its steps or the account cards, and on the page that says it's done.
    expect(connect).toContain("{steps || ownable ? repliesRow : null}");
    expect(connect).toContain("<View style={styles.doneReplies}>{repliesRow}</View>");
    // Both say the plan of what the agent thinks with, the computer's own sign-in's included (`signInPlan`).
    expect(screen).toContain("plan={signInPlan(view, row, kind)}");
    expect(connect).toContain("signInPlan(view, gates.row, kind)");
    expect(connect).toContain("plan={replies.plan}");
  });

  test("Claude's sign-in asks for no address: Claude's page picks the account, an account already there is offered", async () => {
    // The flow is a component the tests can't render: what it wires in, as text.
    const flow = await Bun.file(new URL("../../src/features/ai/AddAccount.tsx", import.meta.url).pathname).text();
    expect(flow).not.toMatch(/TextInput|emailAddress|aiAccounts\.add\.email/);
    // The hint (the account's own email, signing in again) goes through the shared start the client tests pin.
    expect(flow).toMatch(/beginLogin\(\s*\(input\) => api\.machines\.beginAccountLogin\(/);
    expect(flow).toMatch(/\{\s*again,\s*provider,\s*hint,\s*\}/);
    expect(flow).toContain("freeDuplicate(result)");
    expect(flow).toContain('t("connectAi.useAnyway"');
    // "Usar" only where an agent is in view (`onUse`); signing in again as someone else says both addresses.
    expect(flow).toContain("onPress={() => onUse(reuse)}");
    expect(flow).toContain("const otherEmail = other?.email ?? (hint ? result?.signedInAs : undefined);");
    expect(flow).toMatch(/otherEmail\s*\?\s*t\(`connectAi\.otherAccount\.\$\{kind\}`/);
    // A new login that comes back as another account than its hint never thinks by itself: Usar or Tentar de novo.
    expect(flow).toMatch(/if \(otherThanHint\(hint, result\.account\)\) setOther\(result\.account\);\s+else onAdded/);
    expect(flow).toContain("onPress={() => onAdded(other)}");
    expect(flow).toMatch(/if \(other && !again\) void api\.machines\.removeAccount\(orgId, machineId, other\.id\)/);
    const t = await translator("pt-BR");
    expect(t("agentPage.work.brain.add.duplicate.claude_code", { account: "ana@acme.com" })).toBe(
      "O Claude entrou como ana@acme.com, uma conta que você já conectou. Para usar outra, saia na página do Claude e tente de novo.",
    );
    expect(t("connectAi.otherAccount.claude_code", { email: "walt@gmail.com", account: "walt@acme.com" })).toBe(
      "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
    );
    expect(t("connectAi.own.one", { context: "female", name: "Ada" })).toBe("Uma conta só para a Ada");
    expect(t("connectAi.own.shared")).toBe("A conta que os seus agentes dividem");
  });

  test("signing in again sends the account's own email as the hint, from Settings and from Connect an AI", async () => {
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const settings = await read("AiAccountsScreen.tsx");
    const connect = await read("ConnectAiSteps.tsx");
    expect(settings).toMatch(/again=\{again\.id\}\s+email=\{again\.email\}/);
    expect(connect).toMatch(
      /again=\{hint \? hint\.again : signedOut\?\.id\}\s+email=\{hint \? hint\.email : signedOut\?\.email\}/,
    );
    // One more login of another agent's account (`email`, or a row of what the person has) is never the agent's own
    // signed-out login again.
    expect(connect).toContain("= login ?? (email ? { email } : undefined);");
    expect(connect).toContain('const signedOut = !hint && current?.status === "signed_out" ? current : undefined;');
    // Nor an account made for all of the person's agents: the sign-in asked for goes straight to its steps.
    expect(connect).toMatch(/const existing =\s+ready && !hint\s+\? groupPlans\(/);
    // An account already connected thinks for an agent only where one is in view: Connect an AI, never Settings.
    expect(connect).toContain("onUse={(a) => void assign(a)}");
    expect(settings).not.toContain("onUse=");
  });

  test("Claude's code goes by itself however it lands in the field; anything else waits for Enviar, with a line", async () => {
    // The flow and its field are components the tests can't render: what they wire in, as text.
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [flow, parts] = await Promise.all([read("AddAccount.tsx"), read("parts.tsx")]);
    // Typed, pasted with the keyboard or by Colar: one path, and only this sign-in's code sends with no tap.
    expect(flow).toMatch(
      /const take = \(text: string\) => \{[^}]*if \(!plan && login && ready && !loading && isSignInCode\(text, login\.url\)\) void send\(text\);/,
    );
    expect(flow).toContain("onChangeText={take}");
    expect(flow).toContain("onPasted={take}");
    expect(flow).toMatch(
      /key && !isSignInCode\(key, login\.url\) \? \(\s*<Note icon="x">\{t\("agentPage\.work\.brain\.add\.notCode"\)\}<\/Note>/,
    );
    // Colar only while the field is empty, the text's edge then the same on both sides.
    expect(parts).toMatch(/const empty = !value\.trim\(\);/);
    expect(parts).toMatch(/\{empty \? \(\s*<View style=\{styles\.insetAction\}>/);
    expect(parts).toContain("!empty && styles.insetFull");
    const t = await translator("pt-BR");
    expect(t("agentPage.work.brain.add.notCode")).toBe("Isso não parece o código do Claude.");
  });

  test("while the code or the key goes and the computer signs in, the orbit and a line stand in for the field and Enviar", async () => {
    // The flow is a component the tests can't render: what it wires in, as text.
    const flow = await Bun.file(new URL("../../src/features/ai/AddAccount.tsx", import.meta.url).pathname).text();
    expect(flow).toContain("const busy = (sending || sent) && !ended;");
    // Claude's code, Gemini's and a plan's key: the line in place of the field and its button, never beside them.
    expect(flow.match(/\{busy\s+\? busyLine\s+: pasteRow\(/g)).toHaveLength(3);
    expect(flow).toMatch(/<Note icon=\{<InkOrbit size=\{15\} \/>\} live>\s*\{busyText\}/);
    // A failed send brings the field back with what was in it: only a code that went clears it.
    expect(flow).toMatch(/setSent\(true\);\s+setCode\(""\);/);
    const t = await translator("pt-BR");
    expect(t("agentPage.work.brain.add.sending", { computer: "MacBook" })).toBe("Enviando o código ao MacBook…");
    expect(t("aiAccounts.add.keySent", { computer: "MacBook" })).toBe(
      "Chave enviada. O MacBook está terminando de entrar.",
    );
  });

  test("an account other agents think with, where it may have a login per agent: one row, signed in again for this one", async () => {
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [screen, sheet, connect] = await Promise.all([
      read("AgentAiScreen.tsx"),
      read("ConnectAi.tsx"),
      read("ConnectAiSteps.tsx"),
    ]);
    // One row per account (the web's choice), and "Também usada por" signs this agent in on Connect an AI.
    expect(screen).toContain("const choices = view ? accountChoices(accounts, [view.account]) : [];");
    expect(screen).toContain("{choices.map((c) => (");
    expect(screen).toContain("row={accountRow(t, c, name)}");
    expect(screen).toContain("onPress={() => (c.also ? connect(c.login, true) : choose(c.login))}");
    // That account's email goes along as Claude's hint, on Claude's page only, whatever the agent's own login is.
    expect(screen).toContain("...(also && a?.email ? { email: a.email } : {}),");
    expect(sheet).toContain("{...(params.email ? { email: params.email } : {})}");
    expect(connect).toContain('{...(choice === "claude" && props.email ? { email: props.email } : {})}');
    const t = await translator("pt-BR");
    const theo = account("t", { usedBy: ["Theo"] });
    expect(accountRow(t, { login: theo, usedBy: ["Theo", "Lia"], also: true }, "Ada").sub).toBe(
      "Também usada por Theo e Lia",
    );
  });

  test("Connect an AI starts with what the person already has: the free account, those other agents use, a workspace key, someone else's locked", async () => {
    const t = await translator("pt-BR");
    const key = (id: string, revokedAt: string | null = null): Credential => ({
      id,
      provider: "anthropic",
      label: "Claude da Acme",
      keyHint: "7f2a",
      createdAt: "2026-10-01T00:00:00.000Z",
      revokedAt,
    });
    const view = {
      account: "ada",
      accounts: [
        account("pessoal", { label: "Claude Pessoal", email: "walter@acme.com.br", usedBy: ["Atlas"] }),
        account("plus", {
          kind: "codex",
          label: "ChatGPT Plus",
          plan: "plus",
          email: "walt@gmail.com",
          usedBy: ["Atlas"],
        }),
        account("team", { label: "Claude Team", plan: "team", email: "team@example.com" }),
        // Her own login, signed out: its plan's page signs it in again, not this list.
        account("ada", { email: "ada@acme.com", status: "signed_out", usedBy: ["Ada"] }),
        account("joao", { label: "Claude Max", ownerId: "u2", ownerName: "João Silva", mine: false }),
      ],
    };
    const rows = existingRows(t, view, [key("k1"), key("k2", "2026-10-20T00:00:00.000Z")], "Ada");
    expect(
      rows.map((r) => [r.row.kind === "key" ? "key" : r.row.act, r.label, r.sub, "below" in r ? r.below : null]),
    ).toEqual([
      ["use", "Claude Team", "team@example.com", null],
      ["also", "Claude Pessoal · Max", "Também usada por Atlas", null],
      ["also", "ChatGPT Plus", "Também usada por Atlas", null],
      ["key", "Claude da Acme", "Claude · termina em 7f2a", "Pago por uso. Conta no orçamento da Ada."],
      ["locked", "Claude Max", "De João", null],
    ]);
    // The first page lists them before the plans, drawn as the agent's AI draws its accounts.
    const connect = await Bun.file(
      new URL("../../src/features/ai/ConnectAiSteps.tsx", import.meta.url).pathname,
    ).text();
    const home = connect.slice(connect.indexOf("function Home("));
    expect(home.indexOf('t("connectAi.have.title")')).toBeGreaterThan(-1);
    expect(home.indexOf('t("connectAi.have.title")')).toBeLessThan(home.indexOf('t("mobile.ai.planRow")'));
    expect(home).toContain("<AiRow");
    // A plan or a key, one row each; whose is one searched list, the plan's page and the key's steps as before.
    expect(home).toContain('onView({ page: "plans" })');
    expect(home).toContain('onView({ page: "key" })');
    const plans = connect.slice(connect.indexOf("function Plans("), connect.indexOf("function Makers("));
    expect(plans).toContain("<PickList");
    expect(plans).toContain("options={PLAN_CHOICES.map(");
    expect(plans).toContain('onView({ page: "plan", choice: o.value })');
    const makers = connect.slice(connect.indexOf("function Makers("));
    expect(makers).toContain("<PickList");
    expect(makers).toContain("...PROVIDERS.map(");
    expect(connect.slice(connect.indexOf("function KeyPage("))).toContain("onPress={onMakers}");
    expect(connect).toContain("existingRows(t, gates.view, credentials.data ?? [], forAgent.name)");
    // The workspace's keys only in Connect an AI (a sheet), as on the web: the first run's saved key already serves
    // every agent with no plan.
    expect(connect).toContain("useCredentials(orgId, mayAddKey && forAgent !== undefined && sheetTitle !== undefined)");
  });

  test("a card whose plan's sign-in ended: the agent says so, and Entrar de novo opens on its own plan", async () => {
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [card, sheet] = await Promise.all([read("NoAiCard.tsx"), read("ConnectAi.tsx")]);
    expect(card).toContain("t(noAiLineKey(card), agentGrammar(name))");
    // The plan the client tests pin (`signInAgainPlan`): ChatGPT for a Codex agent, never Claude's page.
    expect(card).toContain("const again = signInAgainPlan(card, agent);");
    expect(card).toContain('t(again ? "agentPage.work.brain.signInAgain" : "noAi.action")');
    expect(card).toContain("...(plan ? { plan } : {}),");
    expect(sheet).toContain("PLAN_CHOICES.find((c) => c === params.plan) ?? choiceOfIntent(");
    const t = await translator("pt-BR");
    expect(t("noAi.signedOut", { name: "Ada", context: "female" })).toBe(
      "Ada não vai responder porque a IA dela saiu da\u00a0conta.",
    );
  });

  test("the computer's own sign-in: listed only where it can think for the agent, and a card that says how when it isn't", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [screen, card, connect] = await Promise.all([
      read("AgentAiScreen.tsx"),
      read("NoAiCard.tsx"),
      read("ConnectAiSteps.tsx"),
    ]);
    // Its row only where the client tests say (`ownSignInListed`): never on the workspace's computer, nobody's.
    expect(screen).toContain("const ownRow = view !== undefined && kind !== null && ownSignInListed(view, row, kind);");
    expect(screen).toContain("{ownRow ? (");
    expect(screen).not.toContain("hereNotYours");
    // A plan's page waits for the computer's row for ChatGPT too, not only Claude (`ownSignInFor`).
    expect(connect).toContain("brain: view && (ai.data || !(isPlanId(choice) || view.ownSignIn)) ? view : undefined,");
    // Its card: what isn't signed in and where to connect, and Conectar on that CLI's plan.
    expect(card).toContain("t(noAiLineKey(card), agentGrammar(name))");
    expect(card).toContain("const plan = card.own ? planOfKind(card.own) : again;");
    const pt = await translator("pt-BR");
    expect(pt("noAi.notSignedIn.codex", { context: "female", name: "Ada" })).toBe(
      "O Codex está sem login neste computador. Conecte uma conta do ChatGPT na página da Ada.",
    );
    const en = await translator("en");
    expect(en("noAi.notSignedIn.codex", { name: "Ada" })).toBe(
      "Codex isn't signed in on this computer. Connect a ChatGPT account on Ada's page.",
    );
    expect(en("noAi.notSignedIn.claude_code", { name: "Ada" })).toBe(
      "Claude Code isn't signed in on this computer. Connect a Claude account on Ada's page.",
    );
  });

  test("nothing to pick on someone else's computer says who adds sign-ins there; Conectar opens on the agent's plan", async () => {
    const read = (path: string) => Bun.file(new URL(`../../src/${path}`, import.meta.url).pathname).text();
    const [screen, grouped, card, connect, profile] = await Promise.all([
      read("features/ai/AgentAiScreen.tsx"),
      read("ui/Grouped.tsx"),
      read("features/ai/NoAiCard.tsx"),
      read("features/ai/ConnectAiSteps.tsx"),
      read("features/agents/AgentProfileScreen.tsx"),
    ]);
    // No own row, no account of the owner's, no Adicionar conta: who adds sign-ins there, and no empty card.
    expect(screen).toContain(
      "const lockedHere = view !== undefined && kind !== null && !ownRow && choices.length === 0 && !adds;",
    );
    expect(screen).toMatch(/\{lockedHere \? \(\s*<Note icon="lock">\s*\{t\("connectAi\.accountsLocked", \{/);
    expect(grouped).toContain("if (items.length === 0) return null;");
    // Still waiting, a waiting pill (its sentence wraps to two or three lines on a phone): the breathing mark and
    // Connect tinted for who may connect, a quiet bolt and who can for anyone else.
    expect(card).toContain(
      '<AskWaiting forMe={action !== null} mark="bolt" words={title} actions={action} below={action ? null : locked} />',
    );
    expect(card).not.toContain("<Button");
    // "Ada's page": its Conectar opens on the plan she thinks with (`agentPlan`), ChatGPT for Codex.
    expect(profile).toContain("openConnectAi({ agentId: id, plan: agentPlan(agent) ?? undefined })");
    // A plan's page asks the computers for their own sign-ins again: Codex's is known by a usage read with it.
    expect(connect).toContain("if (asks) void api.machines.refreshAccountUsage(orgId).catch(() => undefined);");
    const pt = await translator("pt-BR");
    expect(pt("connectAi.accountsLocked", { name: "Theo", computer: "MacBook" })).toBe(
      "Só Theo conecta um plano no MacBook.",
    );
    // The line above the card, and the conversation lists' preview: never "saiu da conta" where nobody signed in.
    expect(pt("chat.body.no_ai_not_signed_in", { brain: "Codex" })).toBe(
      "Ainda não consigo responder: o Codex está sem login no meu computador.",
    );
    const en = await translator("en");
    expect(en("chat.body.no_ai_not_signed_in", { brain: "Claude Code" })).toBe(
      "I can't answer yet: Claude Code isn't signed in on my computer.",
    );
  });

  test("on the Cloud the account's sign-in says the computer, never its name; its being ready is a card of its own", async () => {
    const connect = await Bun.file(
      new URL("../../src/features/ai/ConnectAiSteps.tsx", import.meta.url).pathname,
    ).text();
    expect(connect).toMatch(/computer=\{edition === "cloud" \? t\("connectAi\.theComputer"\) : computer\}/);
    // Where the wait's card was: never read as the head of the account choice under it.
    expect(connect).toMatch(/<InfoCard icon="check" live>\s*\{t\("connectAi\.wait\.ready"\)\}/);
    const said = {
      "pt-BR": [
        "Enviar ao computador",
        "Pedindo ao computador…",
        "Código enviado. O computador está terminando de entrar.",
        "O computador não respondeu. Tente de novo em instantes.",
      ],
      en: [
        "Send to the computer",
        "Asking the computer…",
        "Code sent. Finishing the sign-in on the computer.",
        "No answer from the computer. Try again in a moment.",
      ],
    };
    for (const lang of ["pt-BR", "en"] as const) {
      const t = await translator(lang);
      const computer = t("connectAi.theComputer");
      expect(
        ["send", "starting", "sent", "startFailed"].map((k) => t(`agentPage.work.brain.add.${k}`, { computer })),
      ).toEqual(said[lang]);
    }
  });

  test("an account says its plan once, after its name, and Claude's plans go by Anthropic's names", async () => {
    expect(accountTitle(account("Claude", { plan: "ultra" }))).toBe("Claude · Ultra");
    expect(accountTitle(account("Claude 2"))).toBe("Claude 2 · Max");
    expect(accountTitle(account("GLM Coding", { plan: null, provider: "zai" }))).toBe("GLM Coding");
    // The agent's AI and Connect an AI (their rows), Contas de IA and Você name accounts so, and a computer's own
    // sign-in by its maker the same way ("Claude · Max").
    expect(ownSignInTitle(await translator("pt-BR"), { kind: "claude_code", plan: "max" })).toBe("Claude · Max");
    const read = (file: string) => Bun.file(new URL(`../../src/features/${file}`, import.meta.url).pathname).text();
    expect(await read("ai/logic.ts")).toContain("label: accountTitle(choice.login),");
    // AI accounts' grouped rows take a `label`, the Me page's rows a `title`.
    for (const [screen, row, prop] of [["ai/AiAccountsScreen.tsx", "a", "label"]]) {
      const source = await read(screen);
      expect(source).toContain(`${prop}={accountTitle(${row})}`);
      expect(source).toContain(`${prop}={ownSignInTitle(t, o)}`);
      expect(source).not.toContain("planWordOf(o.plan)");
    }
    expect((await translator("pt-BR"))("connectAi.plan.claude.tiers")).toBe("Pro, Max, Ultra, Team ou Enterprise");
    expect((await translator("en"))("connectAi.plan.claude.tiers")).toBe("Pro, Max, Ultra, Team or Enterprise");
  });

  test("its model: Automático, then every model of its plan with what it's sold as, the one it runs checked", async () => {
    const t = await translator("pt-BR");
    const claude: AgentBrain["options"][number] = {
      kind: "claude_code",
      available: true,

      models: [
        { value: "opus", label: "Opus" },
        { value: "sonnet", label: "Sonnet", recommended: true },
        { value: "haiku", label: "Haiku" },
      ],
      defaultModel: "sonnet",
    };
    const view = (effectiveModel: string) => ({ brain: "claude_code" as const, effectiveModel, options: [claude] });
    const go = modelRows(t, view("deepseek-v4.1-flash"), planOf("opencode"));
    expect(go).toHaveLength(32);
    expect(go[0]).toEqual({
      value: "auto",
      label: "Automático",
      sub: "Escolhe o modelo e o esforço para cada tarefa",
      checked: false,
    });
    expect(go.slice(1, 4).map((r) => [r.value, r.label, r.maker])).toEqual([
      ["sonnet", "MiniMax M3", "minimax"],
      ["minimax-m3.1-flash", "MiniMax M3.1 Flash", "minimax"],
      ["haiku", "Claude Haiku 5.5", "anthropic"],
    ]);
    // What it's sold as, and what the plan's account must allow first (read out with its name).
    expect(go.filter((r) => r.checked)).toEqual([
      {
        value: "deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash",
        sub: "Econômico",
        note: "Precisa da região Global no OpenCode.",
        needs: "globalRegion",
        maker: "deepseek",
        checked: true,
      },
    ]);
    // A list per maker after Automático's, as the web groups them.
    const sections = modelSections(go);
    expect(sections.map((s) => s.maker ?? null)).toEqual([
      null,
      "minimax",
      "anthropic",
      "zai",
      "moonshot",
      "Alibaba",
      "deepseek",
      "Xiaomi",
      "openai",
      "gemini",
      "xAI",
      "Meituan",
      "Tencent",
      "StepFun",
      "Meta",
      "Reflection",
      "OpenCode",
    ]);
    expect(sections[0]?.rows.map((r) => r.label)).toEqual(["Automático"]);
    // Every maker beside its own mark, never a letter.
    expect(sections.slice(1).filter((s) => !markOf(s.maker))).toEqual([]);
    // A model that trains on what it's sent: its provider does, said behind the row's ⓘ.
    expect(go.find((r) => r.value === "iceman-contributor-free")?.note).toBe(
      "Grátis. O provedor pode usar os pedidos para treinar o modelo. Ligue a permissão no OpenCode.",
    );
    expect(sections.flatMap((s) => s.rows)).toEqual(go);
    expect(modelSections(modelRows(t, view("k3-256k"), planOf("kimi")))).toHaveLength(1);
    // On Claude's sign-in: its aliases; a plan's model kept from before runs Sonnet there.
    const own = modelRows(t, view("deepseek-v4.1-flash"), undefined);
    expect(own.map((r) => r.label)).toEqual(["Automático", "Opus", "Sonnet", "Haiku"]);
    expect(own.find((r) => r.checked)?.label).toBe("Sonnet");
    // An alias the plan leaves out runs its main model.
    expect(modelRows(t, view("opus"), planOf("zai")).find((r) => r.checked)?.label).toBe("GLM-5.3");
    // OpenCode (ADR 0132): the models its CLI listed, the free ones marked Grátis.
    const opencode: AgentBrain["options"][number] = {
      kind: "opencode",
      available: true,
      models: [
        { value: "opencode/big-pickle", label: "Big Pickle", free: true },
        { value: "opencode/glm-5.3", label: "glm-5.3" },
      ],
      defaultModel: null,
    };
    const oc = modelRows(
      t,
      { brain: "opencode", effectiveModel: "opencode/big-pickle", options: [opencode] },
      undefined,
    );
    expect(oc.map((r) => [r.label, r.sub ?? null, r.checked])).toEqual([
      ["Automático", "Escolhe o modelo e o esforço para cada tarefa", false],
      ["Big Pickle", "Grátis", true],
      ["glm-5.3", null, false],
    ]);
    // An OpenCode key: the computer listed its CLI's models with no key (the free tier), so OpenCode Go's models come
    // after them, as its CLI names them with that key. DeepSeek V4.1 Flash is there, with the region it needs.
    const keyed = modelRows(
      t,
      {
        brain: "opencode",
        effectiveModel: "opencode-go/deepseek-v4.1-flash",
        options: [opencode],
        account: "oc",
        accounts: [account("oc", { kind: "opencode", provider: "zen", keyHint: "Q7f2" })],
      },
      undefined,
    );
    expect(keyed.slice(0, 3).map((r) => r.label)).toEqual(["Automático", "Big Pickle", "glm-5.3"]);
    expect(keyed.find((r) => r.checked)).toMatchObject({
      value: "opencode-go/deepseek-v4.1-flash",
      label: "DeepSeek V4.1 Flash",
      maker: "deepseek",
      needs: "globalRegion",
    });
    expect(keyed).toHaveLength(3 + 31);
  });

  test("picking a model saves as the web does: Automático picks the effort too, a fixed one after it starts at Médio", () => {
    const options: AgentBrain["options"] = [
      { kind: "claude_code", available: true, models: [], defaultModel: "sonnet" },
    ];
    const view = (effort: AgentBrain["effort"]) => ({ brain: "claude_code" as const, options, effort });
    expect(modelInput("auto", view(null))).toEqual({ model: "auto", effort: "auto" });
    expect(modelInput("k3-256k", view("auto"))).toEqual({ model: "k3-256k", effort: "medium" });
    expect(modelInput("k3-256k", view("high"))).toEqual({ model: "k3-256k" });
    // The brain's default is stored as none.
    expect(modelInput("sonnet", view("low"))).toEqual({ model: null });
  });

  test("an account of another plan starts on that plan's default model, Automático staying; the same plan, only the account", () => {
    const opencode = account("oc", { provider: "opencode", keyHint: "Ex2b" });
    const claude = account("cl");
    const view = (effectiveModel: string, current: string | null = "oc") => ({
      brain: "claude_code" as const,
      account: current,
      accounts: [opencode, claude, account("oc2", { provider: "opencode" })],
      effectiveModel,
    });
    // OpenCode's DeepSeek doesn't run on Claude: Claude's own default.
    expect(accountInput(view("deepseek-v4.1-flash"), claude)).toEqual({ account: "cl", model: null });
    expect(accountInput(view("deepseek-v4.1-flash"), null)).toEqual({ account: null, model: null });
    expect(accountInput(view("auto"), claude)).toEqual({ account: "cl", model: "auto" });
    // Another key of the same plan keeps the model.
    expect(accountInput(view("deepseek-v4.1-flash"), account("oc2", { provider: "opencode" }))).toEqual({
      account: "oc2",
    });
    expect(accountInput(view("opus", null), claude)).toEqual({ account: "cl" });
  });

  test("an account of another plan says what thinks now, its model changed with it; one of the same plan, the account", async () => {
    const t = await translator("pt-BR");
    const options: AgentBrain["options"] = [
      {
        kind: "claude_code",
        available: true,

        models: [
          { value: "opus", label: "Opus" },
          { value: "sonnet", label: "Sonnet", recommended: true },
        ],
        defaultModel: "sonnet",
      },
    ];
    const opencode = account("oc", { provider: "opencode", label: "Plano", keyHint: "Ex2b" });
    const work = account("cl2", { label: "Trabalho" });
    const opus = {
      brain: "claude_code" as const,
      effectiveModel: "opus",
      options,
      accounts: [account("cl", { label: "Pessoal" }), work, opencode],
      account: "cl",
    };
    // What the save returned: on OpenCode Go, the plan's default model.
    const saved = (account: string | null) => ({ ...opus, account, effectiveModel: "sonnet" });
    expect(accountSaved(t, "pt-BR", "Ada", opencode, accountInput(opus, opencode), saved("oc"))).toBe(
      "A Ada agora pensa com MiniMax M3 pelo OpenCode Go.",
    );
    // Back to the computer's own sign-in: Claude's default.
    expect(accountSaved(t, "pt-BR", "Ada", null, accountInput(saved("oc"), null), saved(null))).toBe(
      "A Ada agora pensa com Sonnet pelo plano do Claude.",
    );
    // The same plan keeps the model: the account, or the computer's own sign-in as the account the agents share.
    expect(accountSaved(t, "pt-BR", "Ada", work, accountInput(opus, work), { ...opus, account: "cl2" })).toBe(
      "A Ada agora usa a conta Trabalho.",
    );
    expect(accountSaved(t, "pt-BR", "Ada", null, accountInput(opus, null), { ...opus, account: null })).toBe(
      "Ada agora pensa com a conta que os seus agentes dividem.",
    );
    const screen = await Bun.file(new URL("../../src/features/ai/AgentAiScreen.tsx", import.meta.url).pathname).text();
    expect(screen).toContain(
      "const done = (saved: AgentBrain) => accountSaved(t, i18n.language, name, a, input, saved);",
    );
    expect(screen).toContain('toast({ title: typeof done === "string" ? done : done(saved), icon: "check" });');
  });

  test("its page: the account first (the plan choice), then the model with how to give what it needs, a refused key's own row", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const screen = await Bun.file(new URL("../../src/features/ai/AgentAiScreen.tsx", import.meta.url).pathname).text();
    const accountAt = screen.indexOf('<GroupedHeader>{t("agentPage.work.brain.account")}</GroupedHeader>');
    const modelAt = screen.indexOf('<GroupedHeader>{t("agentPage.work.brain.planModel")}</GroupedHeader>');
    expect(accountAt).toBeGreaterThan(0);
    expect(modelAt).toBeGreaterThan(accountAt);
    expect(screen).toContain("const input = accountInput(view, a);");
    expect(screen).toContain("save({ ...input, moveAccount: true }, done)");
    expect(screen).toMatch(/belowText: t\(`brain\.modelHow\.\$\{model\.needs\}`\)/);
    expect(screen).toContain("refused ? openConnectAi({ agentId, plan: refused }) : connect(current)");
    expect(screen).toContain('brain: ai === "key" ? r.label : thinksWith(t, ai, r.label),');
    // What a model needs is behind the ⓘ at its row's end, not a line of the row.
    expect(screen).toContain('hint: { name: t("common.about", { label: r.label }), text: r.note }');
    expect(screen).not.toContain("belowText: r.note");
    const t = await translator("pt-BR");
    expect(t("brain.modelHow.paidTraining")).toBe(
      "O provedor deste modelo pode usar os pedidos para treiná-lo. No OpenCode, em Settings\u00a0›\u00a0Privacy, ligue a permissão para os modelos pagos. Sem ela, este modelo não responde.",
    );
    expect(t("agentPage.work.brain.account")).toBe("Conta");
    expect(t("brain.modelHow.globalRegion")).toBe(
      "Ligue a região Global no OpenCode, em Settings\u00a0›\u00a0Privacy. Sem ela, este modelo não responde.",
    );
    const refused = account("oc", { provider: "opencode", keyHint: "Ex2b", status: "signed_out" });
    expect(accountRow(t, { login: refused, usedBy: [], also: false }, "Ada").sub).toBe(
      "A chave foi recusada: troque por uma nova.",
    );
    expect(t("aiAccounts.page.newKey")).toBe("Trocar a chave");
  });

  test("the agent's AI opens its model on a page of its own, pushed over it", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const screen = await Bun.file(new URL("../../src/features/ai/AgentAiScreen.tsx", import.meta.url).pathname).text();
    expect(screen).toContain("router.push(`/agent-model/");
    expect(screen).toContain("onPress={() => openAgentModel(agentId)}");
    expect(screen).toContain("void save(modelInput(r.value, view), done);");
    expect(screen).toContain("modelSections(rows).map(");
    expect(screen).toContain("<GroupedHeader>{providerLabel(s.maker)}</GroupedHeader>");
    expect(screen).toContain('hint: { name: t("common.about", { label: r.label }), text: r.note }');
    const route = await Bun.file(new URL("../../app/(app)/agent-model/[id].tsx", import.meta.url).pathname).text();
    expect(route).toContain("<AgentModelScreen agentId={id");
  });

  test("a sign-in through a restart or a reconnect: Reconectando while reads fail, the same sign-in kept, then a failure", async () => {
    // The flow and its panel are components the tests can't render: what they wire in, as text. How long reads may
    // fail, and which failures pass, are the client's `loginRead` (its tests pin them).
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [flow, connect] = await Promise.all([read("AddAccount.tsx"), read("ConnectAiSteps.tsx")]);
    expect(flow).toContain("const read = loginRead(status);");
    expect(flow).not.toContain("status.isError");
    expect(flow).toMatch(/read === "reconnecting" \? t\("agentPage\.work\.brain\.add\.reconnecting"\)/);
    // Past the wait, the computer that didn't answer; what the computer says still shows at once.
    expect(flow).toContain('const noAnswer = startFailed !== null || read === "noAnswer";');
    expect(flow).toMatch(
      /: noAnswer\s*\?\s*\(startFailed \?\? t\("agentPage\.work\.brain\.add\.startFailed", \{ computer \}\)\)/,
    );
    expect(flow).toContain('result?.state === "failed" || result?.state === "expired"');
    // Its computer offline mid-sign-in: the steps stay, with no offline card or key over them, and nothing restarts.
    expect(connect).toContain(
      'const steps = ready || gate.state === "preparing" || (gate.state === "offline" && signingIn);',
    );
    expect(connect).toContain('} else if (why && !(gate.state === "offline" && signingIn)) {');
    expect(connect).toContain("offersKeyNow(gate, hold !== null) && !signingIn");
    expect(connect).toContain("onSigningIn={setSigningIn}");
    expect(flow).toMatch(
      /useEffect\(\(\) => \{\s*onSigningIn\?\.\(begun\);\s*return \(\) => onSigningIn\?\.\(false\);/,
    );
    // Claude's code meanwhile: Reconectando by its field, a code that lands there waits for Enviar (`take` sends only
    // to a ready computer), and one that couldn't go says the computer didn't answer, never to check the code.
    expect(flow).toContain('side={read === "reconnecting" ? waiting : undefined}');
    expect(flow).toContain('setSendFailed(loginReadPasses(error) ? "away" : "refused");');
    expect(flow).toMatch(
      /sendFailed === "away"\s*\?\s*t\("agentPage\.work\.brain\.add\.startFailed", \{ computer \}\)/,
    );
    expect((await translator("pt-BR"))("agentPage.work.brain.add.reconnecting")).toBe("Reconectando…");
    expect((await translator("en"))("agentPage.work.brain.add.reconnecting")).toBe("Reconnecting…");
  });

  test("Usar em outros agentes says the setup as the web does: brain, the model it runs, what differs (ADR 0094)", async () => {
    const t = await translator("pt-BR");
    const claude: AgentBrain["options"][number] = {
      kind: "claude_code",
      available: true,

      models: [
        { value: "opus", label: "Opus" },
        { value: "sonnet", label: "Sonnet", recommended: true },
      ],
      defaultModel: "sonnet",
    };
    const view = {
      brain: "claude_code" as const,
      effectiveModel: "opus",
      options: [claude],
      accounts: [],
      account: null,
    };
    const now = {
      effort: "high" as const,
      speed: "standard" as const,
      contextTokens: null,
      onlyOwner: true,
      fallback: true,
    };
    expect(setupWords(t, "pt-BR", view, { apiKey: true, now })).toBe("Opus pelo plano do Claude · Esforço alto");
    expect(setupWords(t, "pt-BR", view, { apiKey: true, now: { ...now, speed: "fast" } })).toBe(
      "Opus pelo plano do Claude · Esforço alto · Velocidade rápida",
    );
    // On a coding plan, its own model; everything at its default says nothing more.
    const glm = { ...view, effectiveModel: "sonnet", accounts: [account("glm", { provider: "zai" })], account: "glm" };
    expect(setupWords(t, "pt-BR", glm, { apiKey: true, now: { ...now, effort: "medium" } })).toBe(
      "GLM-5.3 pelo GLM Coding",
    );
    // Its Autonomia last, as on the web; one that changes only it can take it, and the toast says so.
    expect(setupWords(t, "pt-BR", { ...view, autonomy: "never" }, { apiKey: true, now })).toBe(
      "Opus pelo plano do Claude · Esforço alto · Autonomia: Não pergunta",
    );
    const advanced = await Bun.file(
      new URL("../../src/features/ai/AgentAdvancedScreen.tsx", import.meta.url).pathname,
    ).text();
    // Velocidade as on the web: only where it fits, read-only for who can't edit, saved at once.
    expect(advanced).toContain("{viewSpeedFits(view) ? (");
    expect(advanced).toContain('t("agentPage.work.brain.speedText")');
    expect(advanced).toContain("disabled={!view.canEdit}");
    expect(advanced).toContain('speed: viewSpeedFits(view) ? view.speed : "standard"');
    const setup = await Bun.file(
      new URL("../../src/features/ai/AgentSetupScreen.tsx", import.meta.url).pathname,
    ).text();
    expect(setup).toContain("disabled={busy || !changes(r)}");
    expect(setup).toContain('t("agentPage.work.brain.copy.autonomyOnly", { count: autonomyOnly })');
    // "Levar a autonomia" over the agents, as on the web: off, the setup and its words leave it out.
    expect(setup).toContain("toggle={withAutonomy}");
    expect(setup).toContain("brain.data && !withAutonomy ? { ...brain.data, autonomy: undefined } : brain.data");
    expect(t("agentPage.work.brain.copy.withAutonomyLine", { value: t("missions.commandApproval.never") })).toBe(
      "Não pergunta, como neste agente. Desligado, cada um fica com a sua.",
    );
    const screen = await Bun.file(new URL("../../src/features/ai/AgentAiScreen.tsx", import.meta.url).pathname).text();
    expect(screen).toContain("onPress={() => openAgentSetup(agentId)}");
    const route = await Bun.file(new URL("../../app/(app)/agent-setup/[id].tsx", import.meta.url).pathname).text();
    expect(route).toContain("<AgentSetupScreen agentId={id");
  });

  test("Usar em outros agentes on other people's plans asks once before saving, naming every owner", async () => {
    const t = await translator("pt-BR");
    const claude = { kind: "claude_code" as const, provider: null };
    expect(setupPlanQuestion(t, claude, [])).toBeNull();
    expect(
      setupPlanQuestion(t, claude, [
        { agent: "Ada", owner: "João" },
        { agent: "Atlas", owner: "João" },
        { agent: "Lia", owner: "Bia" },
      ]),
    ).toEqual({
      title: "Usar os planos de João e Bia?",
      description: [
        "As conversas com Ada e Atlas vão usar o plano do Claude de João e os limites dele. João vai receber um email avisando.",
        "As conversas com Lia vão usar o plano do Claude de Bia e os limites dele. Bia vai receber um email avisando.",
      ].join("\n"),
    });
    // Asked before anything saves: Cancelar returns before the one call.
    const setup = await Bun.file(
      new URL("../../src/features/ai/AgentSetupScreen.tsx", import.meta.url).pathname,
    ).text();
    const asked = setup.indexOf("await confirmQuestion(t, setupPlanQuestion(");
    expect(asked).toBeGreaterThan(-1);
    expect(setup.indexOf("api.agents.applySetup(")).toBeGreaterThan(asked);
    expect(setup.match(/api\.agents\.applySetup\(/g)).toHaveLength(1);
  });

  test("Criar agente on the phone thinks with the last setup: the API's model and key, or a plan saved right after", async () => {
    expect(newAgentAi(null)).toEqual({
      model: "auto",
      credentialId: null,
      contextTokens: null,
      plan: null,
      connect: null,
    });
    const api = { brain: "model" as const, model: "claude-opus-5-5", key: "k1", contextTokens: 400_000 };
    expect(newAgentAi(api)).toEqual({
      model: "claude-opus-5-5",
      credentialId: "k1",
      contextTokens: 400_000,
      plan: null,
      connect: null,
    });
    // A model no key runs now starts on Automático, and a key the creator can't see isn't sent, as on the web.
    const runs = { ownerIsMe: true, usable: new Set(["claude-opus-5-5"]), keys: [] };
    expect(newAgentAi(newAgentStart(api, { ...runs, usable: new Set() }))).toMatchObject({
      model: "auto",
      credentialId: null,
    });
    expect(newAgentAi(newAgentStart(api, runs))).toMatchObject({ model: "claude-opus-5-5", credentialId: null });
    const screen = await Bun.file(
      new URL("../../src/features/agents/NewAgentScreen.tsx", import.meta.url).pathname,
    ).text();
    expect(screen).toContain('{ brain: "model", contextTokens: thinks.contextTokens }');
    const input = { brain: "claude_code" as const, account: "a1", model: "opus", effort: "high" as const };
    expect(
      newAgentAi({
        brain: "claude_code",
        machineId: "m1",
        computer: "MacBook",
        account: { id: "a1", label: "Claude" },
        input,
      }),
    ).toEqual({
      model: "auto",
      credentialId: null,
      contextTokens: null,
      plan: { machineId: "m1", input },
      connect: null,
    });
    // The setup's Autonomia goes at creation, with the API's model or a plan.
    expect(newAgentAi({ ...api, autonomy: "never" })).toMatchObject({ model: "claude-opus-5-5", autonomy: "never" });
    const plan = { brain: "claude_code" as const, machineId: "m1", computer: "MacBook", account: null, input };
    expect(newAgentAi({ ...plan, autonomy: "always" })).toMatchObject({ model: "auto", autonomy: "always" });
    expect(newAgentAi(null).autonomy).toBeUndefined();
    expect(screen).toContain("...(thinks.autonomy ? { autonomy: thinks.autonomy } : {})");
  });

  test("Criar agente on the phone: anything Quem pensa offers, as the web's step sends it", async () => {
    expect(pickedAi({ kind: "model", model: "claude-sonnet-5-5" }, [])).toMatchObject({
      model: "claude-sonnet-5-5",
      plan: null,
      connect: null,
    });
    expect(
      pickedAi({ kind: "claude_code", choice: "opencode", machineId: "m1", accountId: "acc-go", model: "glm-5.3" }, []),
    ).toMatchObject({
      model: "auto",
      connect: null,
      plan: { machineId: "m1", input: { brain: "claude_code", account: "acc-go", model: "glm-5.3" } },
    });
    // Automático on a plan is the agent's own already: only the brain is saved. The computer's own ChatGPT sign-in
    // thinks for my agents there: nothing to connect.
    const signedIn = [
      { machineId: "m1", name: "Mac", online: true, mine: true, canAdd: true, keys: true, own: { codex: {} } },
    ] as never;
    const codex = pickedAi({ kind: "codex", choice: "chatgpt", machineId: "m1", model: "auto" }, signedIn);
    expect(codex.plan).toEqual({ machineId: "m1", input: { brain: "codex" } });
    expect(codex.connect).toBeNull();
    // Not signed in there (or not my computer): the plan is saved, then ChatGPT's sign-in opens, as on the web.
    expect(pickedAi({ kind: "codex", choice: "chatgpt", machineId: "m1", model: "auto" }, []).connect).toBe("chatgpt");
    expect(pickedAi({ kind: "claude_code", choice: "claude", machineId: "m1", model: "auto" }, signedIn).connect).toBe(
      "claude",
    );
    // A coding plan with no key yet: made on Automático, Connect opens on that plan once it exists.
    expect(pickedAi({ kind: "connect", choice: "opencode" }, [])).toMatchObject({
      model: "auto",
      plan: null,
      connect: "opencode",
    });
    const screen = await Bun.file(
      new URL("../../src/features/agents/NewAgentScreen.tsx", import.meta.url).pathname,
    ).text();
    expect(screen).toContain("openConnectAi({ agentId: agent.id, plan: thinks.connect })");
    expect(screen).toContain("<BrainPickSheet");
    // No last setup: a plan account of mine (one connected before I had an agent) thinks for it, as on the web.
    expect(screen).toContain("(proposed || start ? null : (ownPlan ?? null))");
    expect(screen).toContain("const ownPlan = planAccountOption(brainOptions);");
  });
});

test("a Cursor sign-in on the phone: its own steps, or its API key when chosen, never Claude's code", async () => {
  // The flow is a component the tests can't render: what it wires in, as text.
  const flow = await Bun.file(new URL("../../src/features/ai/AddAccount.tsx", import.meta.url).pathname).text();
  expect(flow).toContain('} else if (kind === "cursor") {');
  expect(flow).toContain("agentPage.work.brain.add.cursorFinish");
  expect(flow).toContain("signInKey(planId, kind, cursorKey)");
  expect(signInKey(undefined, "cursor", false)).toEqual({ plan: undefined, provider: undefined });
  expect(signInKey(undefined, "cursor", true)).toEqual({ plan: CURSOR_KEY_PLAN, provider: "cursor" });
  expect(signInKey(undefined, "claude_code", true).plan).toBeUndefined();
  expect(signInKey("zai", "claude_code", false)).toEqual({ plan: planOf("zai") as never, provider: "zai" });
});

describe("Seus planos' rows", () => {
  test("a list row keeps 14 above and below its words and a card's 16 at its sides", () => {
    const row = readFileSync(join(import.meta.dir, "../../src/ui/Row.tsx"), "utf8");
    expect(row).toContain("paddingHorizontal: CARD_PAD,\n        paddingVertical: 14,");
    expect(row).toContain("left: leading ? CARD_PAD + LEAD + 12 : CARD_PAD,");
  });
});

describe("Back in Connect an AI", () => {
  test("a plan picked from the list goes back to the list, a sign-in from a row of what the person has to that row", () => {
    const plan = { page: "plan", choice: "chatgpt" } as const;
    expect(flowBack(plan, false)).toEqual({ page: "plans" });
    expect(flowBack(plan, true)).toEqual({ page: "home" });
    expect(flowBack({ page: "plans" }, false)).toEqual({ page: "home" });
    expect(flowBack({ page: "makers" }, false)).toEqual({ page: "key" });
    expect(flowBack({ page: "key" }, false)).toEqual({ page: "home" });
    expect(flowBack({ page: "home" }, false)).toBeNull();
  });
});

describe("Outro provedor on the phone", () => {
  test("the API under a header across the width, Buscar modelos on the add line's header, + in the field, × per model", async () => {
    // The screen is a component the tests can't render: what it wires in, as text.
    const form = await Bun.file(new URL("../../src/features/ai/EndpointForm.tsx", import.meta.url).pathname).text();
    expect(form).toContain('<GroupedHeader>{t("endpoint.style")}</GroupedHeader>');
    expect(form).toContain('wide="fit"');
    expect(form.indexOf('t("endpoint.style")')).toBeLessThan(form.indexOf('t("endpoint.address")'));
    expect(form).toMatch(
      /<GroupedHeader\s+aside=\{\s*<Button\s+variant="text"\s+size="sm"\s+label=\{t\("endpoint\.fetch"\)\}/,
    );
    expect(form).toContain('<IconButton icon="plus" label={t("endpoint.add")}');
    expect(form).toContain("withoutModel(d, m.id)");
  });
});
