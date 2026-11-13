import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentSetupChecklist } from "../src/api/types";
import {
  askedLine,
  beatRow,
  FIRST_RUN_STEPS,
  type FirstRunFacts,
  type FirstRunPowers,
  firstRunAiLabel,
  firstRunAppList,
  firstRunApps,
  firstRunAsks,
  firstRunBeats,
  firstRunDone,
  firstRunRow,
  firstRunRowState,
  firstRunSteps,
  nextStep,
  type SetupRowFacts,
  setupApps,
  setupDone,
  setupRole,
  setupRow,
  setupSteps,
  setupTaskKeys,
  suggestedChannels,
  suggestedLevels,
  teamRole,
} from "../src/lib/setup-checklist";

// A new agent's setup checklist (ADR 0155 §2): who sees which steps, what counts as done, what it suggests.

const fresh = (role: string | null = "support"): AgentSetupChecklist => ({ role, done: [] });
const agent = (setup: AgentSetupChecklist | null, ownerUserId: string | null = "u_owner") => ({
  setup,
  ownerUserId,
  builtin: null,
});

describe("setup checklist", () => {
  test("who manages agents sees every step; its owner the ones they may change; anyone else none", () => {
    expect(setupSteps(agent(fresh()), { meId: "u_admin", admin: true })).toEqual(["ai", "apps", "where", "who", "how"]);
    expect(setupSteps(agent(fresh()), { meId: "u_owner", admin: false })).toEqual(["ai", "where", "who"]);
    expect(setupSteps(agent(fresh()), { meId: "u_other", admin: false })).toEqual([]);
  });

  test("an agent made before it, or the right hand, has none", () => {
    expect(setupSteps(agent(null), { meId: "u_admin", admin: true })).toEqual([]);
    expect(setupSteps({ ...agent(fresh()), builtin: "right_hand" }, { meId: "u_admin", admin: true })).toEqual([]);
  });

  test("a step is done when confirmed or when its data says so; the next is the first not done", () => {
    const done = setupDone({ role: null, done: ["who"] }, { ai: true, apps: false, where: true });
    expect([...done].sort()).toEqual(["ai", "where", "who"]);
    expect(nextStep(["ai", "apps", "where", "who", "how"], done)).toBe("apps");
    expect(nextStep(["ai", "where", "who"], done)).toBeNull();
  });

  test("the role's suggestions: its apps, its channels by name, else #general", () => {
    expect(setupRole(fresh("support"))).toBe("support");
    expect(setupRole(fresh("not-a-role"))).toBeNull();
    expect(suggestedLevels("support")).toMatchObject({ intercom: "write" });
    expect(suggestedLevels(null)).toEqual({});
    const channels = [
      { id: "c1", name: "general" },
      { id: "c2", name: "Suporte" },
    ];
    expect(suggestedChannels("support", channels)).toEqual(["c2"]);
    expect(suggestedChannels("dev", channels)).toEqual(["c1"]);
    expect(suggestedChannels(null, [{ id: "c3", name: "random" }])).toEqual([]);
  });

  test("what an agent from scratch was asked is said back only when it is one short line", () => {
    expect(askedLine("  Responde dúvidas sobre os planos ")).toBe("Responde dúvidas sobre os planos");
    // The sentence that says it back closes it: no ".." at its end.
    expect(askedLine("Responde dúvidas sobre os planos.")).toBe("Responde dúvidas sobre os planos");
    expect(askedLine("one\ntwo")).toBeNull();
    expect(askedLine("")).toBeNull();
  });

  test("its first tasks: a ready-made role's three, a blank agent's own two", () => {
    expect(setupTaskKeys("support")).toEqual([
      "newAgent.roles.support.tasks.a",
      "newAgent.roles.support.tasks.b",
      "newAgent.roles.support.tasks.c",
    ]);
    expect(setupTaskKeys(null)).toEqual(["agentSetup.tasks.a", "agentSetup.tasks.b"]);
    // A personal starter's own three (ADR 0164); an unknown one is a blank agent's.
    expect(setupTaskKeys(null, "clara")).toEqual([
      "newAgent.starters.clara.tasks.a",
      "newAgent.starters.clara.tasks.b",
      "newAgent.starters.clara.tasks.c",
    ]);
    expect(setupTaskKeys(null, "nobody")).toEqual(["agentSetup.tasks.a", "agentSetup.tasks.b"]);
  });

  test("the apps it suggests: its card's (ADR 0164), else its role's, else its personal starter's at write", () => {
    expect(setupApps({ role: "dev", done: [], apps: { github: "read" } })).toEqual({ github: "read" });
    expect(setupApps(fresh("pm"))).toEqual(suggestedLevels("pm"));
    expect(setupApps({ role: null, done: [], starter: "clara" })).toEqual({
      "google-calendar": "write",
      todoist: "write",
    });
    expect(setupApps({ role: null, done: [] })).toEqual({});
    expect(setupApps(null)).toEqual({});
  });

  test("a line said back keeps no trailing period inside the quotes", () => {
    expect(askedLine("Cuida da sua agenda antes que seja tarde. ")).toBe("Cuida da sua agenda antes que seja tarde");
    expect(askedLine("Cuida da agenda…")).toBe("Cuida da agenda");
  });

  test("a row's words, the same on the web and the phone: the suggestion while left, what it has once done", () => {
    // The key and its values, so each case shows which sentence it picked.
    const t = ((key: string, o?: Record<string, unknown>) =>
      o ? `${key} ${JSON.stringify(o)}` : key) as never as TFunction;
    const facts: SetupRowFacts = {
      org: "Acme",
      role: "support",
      granted: null,
      suggested: "o Intercom",
      channels: null,
      firstChannel: "#suporte",
      audience: "everyone",
      otherOwner: null,
      onPlan: false,
    };
    expect(setupRow(t, "ai", false, facts)).toEqual({
      title: "agentSetup.ai.todo",
      desc: "agentSetup.ai.todoDesc",
      action: "agentSetup.ai.action",
    });
    expect(setupRow(t, "apps", false, facts).title).toBe('agentSetup.apps.todo {"apps":"o Intercom"}');
    expect(setupRow(t, "apps", true, facts).title).toBe("agentSetup.apps.doneNone");
    expect(setupRow(t, "apps", false, { ...facts, suggested: null }).action).toBe("agentSetup.choose");
    expect(setupRow(t, "where", false, facts).title).toBe('agentSetup.where.todo {"channel":"#suporte"}');
    expect(setupRow(t, "where", true, { ...facts, channels: "#suporte" }).title).toBe(
      'agentSetup.where.done {"channels":"#suporte"}',
    );
    expect(setupRow(t, "who", false, { ...facts, onPlan: true }).title).toBe("agentSetup.who.todoPlan");
    expect(setupRow(t, "who", true, { ...facts, audience: "owner", otherOwner: "Ana" }).title).toBe(
      'agentSetup.who.doneOwner {"name":"Ana"}',
    );
    expect(setupRow(t, "who", true, { ...facts, audience: "owner" }).title).toBe("agentSetup.who.doneYou");
    expect(setupRow(t, "how", false, { ...facts, role: null }).desc).toBe("agentSetup.how.todoDescBlank");
    expect(setupRow(t, "how", true, facts)).toEqual({ title: "agentSetup.how.done", action: "agentSetup.see" });
  });

  test("a personal workspace's rows say 'your apps' and 'here', never the workspace's name (ADR 0159)", () => {
    const t = ((key: string, o?: Record<string, unknown>) =>
      o ? `${key} ${JSON.stringify(o)}` : key) as never as TFunction;
    const facts: SetupRowFacts = {
      org: "Personal",
      role: null,
      granted: null,
      suggested: null,
      channels: null,
      firstChannel: null,
      audience: "everyone",
      otherOwner: null,
      onPlan: false,
      personal: true,
    };
    expect(setupRow(t, "apps", false, facts).title).toBe("agentSetup.apps.todoNonePersonal");
    expect(setupRow(t, "who", false, facts).title).toBe("agentSetup.who.todoPersonal");
    expect(setupRow(t, "who", true, facts).title).toBe("agentSetup.who.doneEveryonePersonal");
    // The rest reads as in a team's workspace.
    expect(setupRow(t, "ai", false, facts).title).toBe("agentSetup.ai.todo");
  });
});

describe("the right hand's first run (ADR 0155 §6, ADR 0162)", () => {
  const lodi = (setup: AgentSetupChecklist | null = { role: null, done: [] }) => ({
    setup,
    builtin: "right_hand" as const,
  });
  const owner: FirstRunPowers = {
    owner: true,
    configure: true,
    createAgents: true,
    connectAi: true,
    pay: true,
    connectors: true,
    invite: true,
  };
  const none: FirstRunFacts = { context: false, team: false, ai: false, apps: false, people: false };

  test("what the onboarding leaves, one order everywhere, for the owners, each row by what they may do", () => {
    expect(FIRST_RUN_STEPS).toEqual(["plan", "about", "team", "ai", "apps", "people"]);
    // A team's onboarding asked what it does and made its team (ADR 0162): its card has the rest.
    expect(firstRunSteps(lodi(), owner)).toEqual(["ai", "apps", "people"]);
    expect(firstRunSteps(lodi(), { ...owner, connectors: false, invite: false })).toEqual(["ai"]);
    // An invited person sees none of it, nor anyone once the right hand has no checklist; nor on another agent.
    expect(firstRunSteps(lodi(), { ...owner, owner: false })).toEqual([]);
    expect(firstRunSteps(lodi(null), owner)).toEqual([]);
    expect(firstRunSteps({ setup: { role: null, done: [] }, builtin: null }, owner)).toEqual([]);
  });

  test("a workspace waiting for its first plan leads with the plan row, for whoever may pay (ADR 0162)", () => {
    expect(firstRunSteps(lodi(), { ...owner, waitsForPlan: true })).toEqual(["plan", "ai", "apps", "people"]);
    expect(firstRunSteps(lodi(), { ...owner, waitsForPlan: true, pay: false })).toEqual(["ai", "apps", "people"]);
    expect(firstRunSteps(lodi(), { ...owner, waitsForPlan: true, personal: true })).toEqual([
      "plan",
      "about",
      "team",
      "ai",
      "apps",
    ]);
    // The data never does it (it leaves when the hold lifts), so it is never a beat either.
    expect([...firstRunDone({ role: null, done: [] }, { ...none, ai: true })]).toEqual(["ai"]);
    expect(firstRunBeats(["plan", "ai"], { members: 1, invited: 0 })).toEqual(["ai"]);
  });

  test("each row reads done from its data; only a skip of apps or people is stored", () => {
    const setup = { role: null, done: [] };
    expect([...firstRunDone(setup, none)]).toEqual([]);
    expect([...firstRunDone(setup, { ...none, ai: true, apps: true, people: true })]).toEqual(["ai", "apps", "people"]);
    expect([...firstRunDone(setup, { ...none, context: true, team: true })]).toEqual(["about", "team"]);
    expect([...firstRunDone({ role: null, done: ["apps", "people"] }, none)]).toEqual(["apps", "people"]);
    // A stored step of a new agent's checklist ticks nothing here.
    expect([...firstRunDone({ role: null, done: ["ai", "who"] }, none)]).toEqual([]);
  });

  test("on a hold the rows wait for the plan, a skipped one stays done, and no ask shows", () => {
    const done = firstRunDone({ role: null, done: ["apps"] }, none);
    const state = (s: Parameters<typeof firstRunRowState>[0], held: boolean) => firstRunRowState(s, { done, held });
    // The plan row, and a personal workspace's first two, stay open: they are what can be done on the hold.
    expect(FIRST_RUN_STEPS.map((s) => state(s, true))).toEqual([
      "open",
      "open",
      "open",
      "afterPlan",
      "done",
      "afterPlan",
    ]);
    expect(FIRST_RUN_STEPS.map((s) => state(s, false))).toEqual(["open", "open", "open", "open", "done", "open"]);
    const thinks = new Set([...done, "ai" as const]);
    expect(firstRunAsks(thinks, true, true)).toBe(false);
    expect(firstRunAsks(thinks, false, true)).toBe(true);
    // The asks are for a team: none before there is one.
    expect(firstRunAsks(thinks, false, false)).toBe(false);
    expect(firstRunAsks(done, false, true)).toBe(false);
  });

  test("its words: open rows ask, done rows say what is there, apps and people may be skipped", () => {
    const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)) as TFunction;
    const f = { org: "Acme", label: "Claude", apps: "Gmail", members: 1, invited: null };
    expect(firstRunRow(t, "apps", "open", f, false)).toEqual({
      title: 'agentSetup.firstRun.apps.todo {"org":"Acme"}',
      desc: 'agentSetup.firstRun.apps.todoDesc {"org":"Acme"}',
      action: "agentSetup.firstRun.apps.action",
      skip: "agentSetup.firstRun.notNow",
    });
    expect(firstRunRow(t, "ai", "done", f, false).title).toBe('agentSetup.firstRun.ai.done {"label":"Claude"}');
    expect(firstRunRow(t, "ai", "done", { ...f, label: null }, false).title).toBe("agentSetup.firstRun.ai.doneAny");
    expect(firstRunRow(t, "people", "done", f, true).title).toBe("agentSetup.firstRun.people.doneNone");
    // On a hold the AI row is the step right after the plan's; the others open with the plan.
    expect(firstRunRow(t, "ai", "afterPlan", f, false)).toEqual({
      title: 'agentSetup.firstRun.ai.todo {"org":"Acme"}',
      desc: "agentSetup.firstRun.afterPlanNext",
      action: "",
    });
    expect(firstRunRow(t, "apps", "afterPlan", f, false)).toEqual({
      title: 'agentSetup.firstRun.apps.todo {"org":"Acme"}',
      desc: "agentSetup.firstRun.afterPlan",
      action: "",
    });
    // The plan row asks with its button and is never skipped.
    expect(firstRunRow(t, "plan", "open", f, false)).toEqual({
      title: 'agentSetup.firstRun.plan.todo {"org":"Acme"}',
      desc: 'agentSetup.firstRun.plan.todoDesc {"org":"Acme"}',
      action: "agentSetup.firstRun.plan.action",
    });
    expect(firstRunRow(t, "plan", "open", { ...f, personal: true }, false)).toEqual({
      title: 'agentSetup.firstRun.plan.todoPersonal {"org":"Acme"}',
      desc: 'agentSetup.firstRun.plan.todoDescPersonal {"org":"Acme"}',
      action: "agentSetup.firstRun.plan.action",
    });
  });

  test("the AI it names: a plan's line, else its API's maker, the workspace key's on Automático", () => {
    expect(firstRunAiLabel({ text: "Sonnet pelo plano do Claude", kind: "claude_code" }, "anthropic")).toBe(
      "Sonnet pelo plano do Claude",
    );
    expect(firstRunAiLabel({ text: "Automático", kind: "agent" }, "anthropic")).toBe("Claude");
    expect(firstRunAiLabel({ text: "Automático", kind: "agent" }, undefined)).toBeNull();
  });

  test("an invitation waiting for its answer finishes the people row, by who was invited", () => {
    const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)) as TFunction;
    expect([...firstRunDone({ role: null, done: [] }, { ...none, people: true })]).toEqual(["people"]);
    const f = { org: "Acme", label: null, apps: null, members: 1, invited: "joao.lima@example.com" };
    expect(firstRunRow(t, "people", "done", f, false).title).toBe(
      'agentSetup.firstRun.people.invited {"names":"joao.lima@example.com"}',
    );
    // Once someone joined, how many people are here.
    expect(firstRunRow(t, "people", "done", { ...f, members: 2 }, false).title).toBe(
      'agentSetup.firstRun.people.done {"count":2}',
    );
  });

  test("an invitation only sent is a beat of its own, so the right hand says it went out; someone joining is the one it celebrates", () => {
    expect(firstRunBeats(["ai", "people"], { members: 1, invited: 1 })).toEqual(["ai", "invited"]);
    // The same row turns `people` as the invitee joins: a beat of its own, so it has its line then.
    expect(firstRunBeats(["ai", "people"], { members: 2, invited: 0 })).toEqual(["ai", "people"]);
    // Skipped with nobody invited: `people`, which says nothing (the card's rule for a skip).
    expect(firstRunBeats(["people"], { members: 1, invited: 0 })).toEqual(["people"]);
    expect(beatRow("invited")).toBe("people");
    expect(beatRow("apps")).toBe("apps");
  });

  test("a personal workspace (ADR 0159): no people row, and its rows in its own words", () => {
    expect(firstRunSteps(lodi(), { ...owner, personal: true })).toEqual(["about", "team", "ai", "apps"]);
    const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)) as TFunction;
    const f = { org: "Personal", agents: 2, label: "Claude", apps: null, members: 1, invited: null, personal: true };
    expect(firstRunRow(t, "about", "open", f, false)).toEqual({
      title: 'agentSetup.firstRun.about.todoPersonal {"org":"Personal"}',
      desc: 'agentSetup.firstRun.about.todoDescPersonal {"org":"Personal"}',
      action: "agentSetup.firstRun.about.action",
    });
    expect(firstRunRow(t, "about", "done", f, false).title).toBe(
      'agentSetup.firstRun.about.donePersonal {"org":"Personal"}',
    );
    expect(firstRunRow(t, "team", "open", f, false).action).toBe("agentSetup.firstRun.team.actionPersonal");
    expect(firstRunRow(t, "team", "done", f, false).title).toBe('agentSetup.firstRun.team.donePersonal {"count":2}');
    expect(firstRunRow(t, "apps", "open", f, false).title).toBe(
      'agentSetup.firstRun.apps.todoPersonal {"org":"Personal"}',
    );
    // Words with no personal variant stay the same.
    expect(firstRunRow(t, "apps", "open", f, false).action).toBe("agentSetup.firstRun.apps.action");
    expect(firstRunRow(t, "ai", "open", f, false).title).toBe('agentSetup.firstRun.ai.todo {"org":"Personal"}');
  });

  test("the apps a team made from a template would use, the most suggested first", () => {
    const a = (handle: string) => ({ handle, setup: null });
    expect(teamRole(a("iara-2"))).toBe("support");
    expect(teamRole({ handle: "zed", setup: { role: "dev", done: [] } })).toBe("dev");
    expect(teamRole(a("zed"))).toBeNull();
    expect(firstRunApps([a("iara"), a("bia")]).slice(0, 1)).toEqual(["intercom"]);
    expect(firstRunApps([a("zed")])).toEqual([]);
    // A personal template's agents (ADR 0159): a person's calendar, lists and files.
    expect(teamRole(a("clara"))).toBeNull();
    expect(firstRunApps([a("clara"), a("leo-2")])).toEqual(["google-calendar", "todoist"]);
    expect(firstRunApps([a("duda")])).toEqual(["google-sheets", "drive"]);
  });

  test("the apps row lists the apps that connect in one click here, not connected yet, the team's first", () => {
    const def = (
      id: string,
      more: Partial<{
        auth: ("oauth" | "api_key")[];
        oauthConfigured: boolean;
        available: boolean;
        soon: boolean;
      }> = {},
    ) => ({
      id,
      auth: ["oauth" as const],
      oauthConfigured: true,
      available: true,
      ...more,
    });
    const defs = [
      def("gmail"),
      def("intercom"),
      def("apikey", { auth: ["api_key"] }),
      def("off", { oauthConfigured: false }),
      def("later", { available: false }),
      def("vendor", { soon: true }),
      def("notion"),
    ];
    const list = firstRunAppList(defs, new Set(["notion"]), [{ handle: "iara", setup: null }]);
    expect(list.map((x) => [x.def.id, x.suggested])).toEqual([
      ["intercom", true],
      ["gmail", false],
    ]);
    expect(
      firstRunAppList(
        Array.from({ length: 9 }, (_, i) => def(`app${i}`)),
        new Set(),
        [],
      ),
    ).toHaveLength(6);
  });
});
