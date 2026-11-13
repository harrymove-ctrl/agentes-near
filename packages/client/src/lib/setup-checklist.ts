import type { TFunction } from "i18next";
import type { Agent, AgentSetupChecklist, AgentSetupStep, AudienceMode, ConnectorDef, SetupStep } from "../api/types";
import type { Level } from "./access-levels";
import { PERSONAL_STARTER_APPS, presetChannels, ROLE_DEFAULTS, ROLE_IDS, type RoleId } from "./new-agent";
import { providerLabel } from "./providers";
import { leadsWithPlan } from "./right-hand";

/*
 * A new agent's setup checklist (ADR 0155 §2): the top of its chat, in its voice, lists what it still needs. The
 * server keeps the role it started from and the steps a person confirmed; a step is also done when the agent's data
 * says so (an AI that works, an app it may use, a channel it is in). These are the rules the apps share.
 */

export const SETUP_STEPS: readonly AgentSetupStep[] = ["ai", "apps", "where", "who", "how"];

/** Only who manages agents changes its apps and how it works; its owner changes its AI, channels and audience. */
const ADMIN_STEPS: ReadonlySet<AgentSetupStep> = new Set<AgentSetupStep>(["apps", "how"]);

/** The ready-made role it started from, if the apps know it ("custom" is from scratch: none). */
export const setupRole = (setup: AgentSetupChecklist | null | undefined): RoleId | null =>
  setup?.role && setup.role !== "custom" && (ROLE_IDS as readonly string[]).includes(setup.role)
    ? (setup.role as RoleId)
    : null;

/**
 * The steps this person sees, in order: who manages agents, all of them; its owner, the ones they may change; anyone
 * else, none (the checklist is for who sets the agent up). An agent made before the checklist, or the right hand: none.
 */
export function setupSteps(
  agent: Pick<Agent, "setup" | "ownerUserId" | "builtin">,
  viewer: { meId: string; admin: boolean },
): AgentSetupStep[] {
  if (!agent.setup || agent.builtin) return [];
  if (viewer.admin) return [...SETUP_STEPS];
  if (agent.ownerUserId !== viewer.meId) return [];
  return SETUP_STEPS.filter((s) => !ADMIN_STEPS.has(s));
}

/** What the agent's data says, so a step done some other way (its page, a card) is done here too. */
export interface SetupFacts {
  /** Its AI works, or waits for its computer (not "no AI"). */
  ai?: boolean;
  /** It may use at least one app. */
  apps?: boolean;
  /** It is in at least one channel (DMs aside). */
  where?: boolean;
}

/** The steps done: confirmed by a person, or done as its data says. */
export function setupDone(setup: AgentSetupChecklist, facts: SetupFacts): Set<AgentSetupStep> {
  const done = new Set<AgentSetupStep>(setup.done.filter((s): s is AgentSetupStep => SETUP_STEPS.includes(s as never)));
  if (facts.ai) done.add("ai");
  if (facts.apps) done.add("apps");
  if (facts.where) done.add("where");
  return done;
}

/** The first step not done yet (the one whose button is the primary one), or null. */
export const nextStep = (steps: readonly AgentSetupStep[], done: ReadonlySet<AgentSetupStep>) =>
  steps.find((s) => !done.has(s)) ?? null;

/** The apps (catalog connector ids) its role suggests, at their levels; none for an agent from scratch. */
export const suggestedLevels = (role: RoleId | null): Record<string, Level> => (role ? ROLE_DEFAULTS[role].levels : {});

/**
 * The apps its checklist suggests, at their levels: the ones its card was made with (ADR 0164), else its role's, else
 * its personal starter's at write.
 */
export function setupApps(setup: AgentSetupChecklist | null | undefined): Record<string, Level> {
  if (setup?.apps) return setup.apps;
  const role = setupRole(setup);
  if (role) return suggestedLevels(role);
  return Object.fromEntries(
    (setup?.starter ? (PERSONAL_STARTER_APPS[setup.starter] ?? []) : []).map((id) => [id, "write"]),
  );
}

/**
 * The channels its role suggests among the ones given (by name); with none, the workspace's general channel, where
 * mentions reach it.
 */
export function suggestedChannels<C extends { id: string; name: string }>(
  role: RoleId | null,
  channels: C[],
): string[] {
  const picked = role ? presetChannels(role, channels) : [];
  if (picked.length > 0) return picked;
  const general = channels.find((c) => c.name === "general" || c.name === "geral");
  return general ? [general.id] : [];
}

/** How many first tasks a ready-made role suggests (`newAgent.roles.{id}.tasks.{a,b,c}`) and a blank one. */
export const TASK_KEYS = ["a", "b", "c"] as const;
export const BLANK_TASK_KEYS = ["a", "b"] as const;

/**
 * One line of instructions short enough to say back ("Você me pediu: …"): what an agent from scratch was asked, without
 * its closing period, which the sentence saying it back closes.
 */
export function askedLine(instructions: string): string | null {
  // "…tarde." said back as "“…tarde”.", never "“…tarde.”.".
  const text = instructions.trim().replace(/[\s.…]+$/, "");
  return text && !text.includes("\n") && text.length <= 200 ? text : null;
}

/**
 * The keys of its first tasks: a ready-made role's three, a personal starter's three (ADR 0164), or a blank agent's
 * own two.
 */
export const setupTaskKeys = (role: RoleId | null, starter?: string | null): string[] =>
  role
    ? TASK_KEYS.map((k) => `newAgent.roles.${role}.tasks.${k}`)
    : starter && PERSONAL_STARTER_APPS[starter]
      ? TASK_KEYS.map((k) => `newAgent.starters.${starter}.tasks.${k}`)
      : BLANK_TASK_KEYS.map((k) => `agentSetup.tasks.${k}`);

/** What a row says, from what the app read: names already joined in the person's language. */
export interface SetupRowFacts {
  org: string;
  role: RoleId | null;
  /** The apps it may use ("o Gmail e o Drive"), and the ones its role suggests; null when none. */
  granted: string | null;
  suggested: string | null;
  /** The channels it is in ("#suporte e #geral"), and the first one its role suggests ("#suporte"); null when none. */
  channels: string | null;
  firstChannel: string | null;
  audience: AudienceMode;
  /** Its owner's first name when that isn't the person reading; null for them, or nobody. */
  otherOwner: string | null;
  /** It thinks with someone's plan (whose terms say who it may answer). */
  onPlan: boolean;
  /** A personal workspace (ADR 0159): the rows that name the workspace speak of "your apps" and "here" instead. */
  personal?: boolean;
}

/** One row of the checklist, in the agent's voice: what it says, a line under it while left, its button's word. */
export interface SetupRow {
  title: string;
  desc?: string;
  action: string;
}

/** A row's words (the web's dialog buttons and the phone's screens say the same). */
export function setupRow(t: TFunction, step: AgentSetupStep, done: boolean, f: SetupRowFacts): SetupRow {
  switch (step) {
    case "ai":
      return done
        ? { title: t("agentSetup.ai.done"), action: t("agentSetup.switch") }
        : { title: t("agentSetup.ai.todo"), desc: t("agentSetup.ai.todoDesc"), action: t("agentSetup.ai.action") };
    case "apps":
      if (done) {
        return {
          title: f.granted ? t("agentSetup.apps.done", { apps: f.granted }) : t("agentSetup.apps.doneNone"),
          action: t("agentSetup.change"),
        };
      }
      return f.suggested
        ? {
            title: t("agentSetup.apps.todo", { apps: f.suggested }),
            desc: t("agentSetup.apps.todoDesc"),
            action: t("agentSetup.apps.action"),
          }
        : {
            title: f.personal ? t("agentSetup.apps.todoNonePersonal") : t("agentSetup.apps.todoNone", { org: f.org }),
            desc: t("agentSetup.apps.todoNoneDesc"),
            action: t("agentSetup.choose"),
          };
    case "where":
      if (done) {
        return {
          title: f.channels ? t("agentSetup.where.done", { channels: f.channels }) : t("agentSetup.where.doneNone"),
          action: t("agentSetup.change"),
        };
      }
      return f.firstChannel
        ? {
            title: t("agentSetup.where.todo", { channel: f.firstChannel }),
            desc: t("agentSetup.where.todoDesc"),
            action: t("agentSetup.where.action"),
          }
        : {
            title: t("agentSetup.where.todoNone"),
            desc: t("agentSetup.where.todoDesc"),
            action: t("agentSetup.choose"),
          };
    case "who":
      if (done) {
        const title =
          f.audience === "everyone"
            ? f.personal
              ? t("agentSetup.who.doneEveryonePersonal")
              : t("agentSetup.who.doneEveryone", { org: f.org })
            : f.audience === "owner"
              ? f.otherOwner
                ? t("agentSetup.who.doneOwner", { name: f.otherOwner })
                : t("agentSetup.who.doneYou")
              : t("agentSetup.who.donePeople");
        return { title, action: t("agentSetup.change") };
      }
      return f.onPlan
        ? {
            title: t("agentSetup.who.todoPlan"),
            desc: t("agentSetup.who.todoPlanDesc"),
            action: t("agentSetup.choose"),
          }
        : {
            title: f.personal ? t("agentSetup.who.todoPersonal") : t("agentSetup.who.todo", { org: f.org }),
            desc: t("agentSetup.who.todoDesc"),
            action: t("agentSetup.choose"),
          };
    case "how":
      return done
        ? { title: t("agentSetup.how.done"), action: t("agentSetup.see") }
        : {
            title: t("agentSetup.how.todo"),
            desc: f.role
              ? t("agentSetup.how.todoDesc", { role: t(`newAgent.roles.${f.role}.name`) })
              : t("agentSetup.how.todoDescBlank"),
            action: t("agentSetup.see"),
          };
  }
}

/* ---------- The right hand's first run (ADR 0155 §6, ADR 0162) ---------- */

/**
 * Its rows, one order everywhere: what the onboarding's steps leave (they made the workspace, said what it does and
 * made the team): an AI, apps, people. A personal workspace (ADR 0159) starts with what the person wants help with and
 * their agents, and has no people row. A workspace waiting for its first agentes.chat plan, its plan left in the
 * onboarding, leads with the plan (ADR 0162, amended 2026-11-10): the row with the way to pay, the rest after it.
 * "plan" is no `SetupStep`: nothing about it is stored, the row leaves when the hold lifts.
 */
type RowId = SetupStep | "plan";
export const FIRST_RUN_STEPS = ["plan", "about", "team", "ai", "apps", "people"] as const satisfies readonly RowId[];
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];
/** The rows the data can do, so each has a fact and a line once done: all but the plan's, which only leaves. */
export type FirstRunDoneStep = Exclude<FirstRunStep, "plan">;

/** What may each row's button do for this person (`stepPermissions` in lib/home, plus `configure`). */
export interface FirstRunPowers {
  owner: boolean;
  configure: boolean;
  createAgents: boolean;
  connectAi: boolean;
  pay: boolean;
  connectors: boolean;
  invite: boolean;
  /** A personal workspace (ADR 0159): its first run has no people row, it is for one person. */
  personal?: boolean;
  /** It waits for its first agentes.chat plan (a "payment" hold): the plan row leads, for whoever may pay. */
  waitsForPlan?: boolean;
}

/**
 * The rows this person sees: the right hand's checklist is for the workspace's owners, each row by what they may do.
 * An invited person sees none of it (their own Connect card and the style card, as before), nor anyone once the
 * right hand has no checklist (a workspace that had a team before it).
 */
export function firstRunSteps(agent: Pick<Agent, "setup" | "builtin">, may: FirstRunPowers): FirstRunStep[] {
  if (agent.builtin !== "right_hand" || !agent.setup || !may.owner) return [];
  const row: Record<FirstRunStep, boolean> = {
    plan: leadsWithPlan(agent, may),
    about: Boolean(may.personal) && may.configure,
    team: Boolean(may.personal) && may.createAgents,
    ai: may.connectAi || may.pay,
    apps: may.connectors,
    people: may.invite && !may.personal,
  };
  return FIRST_RUN_STEPS.filter((s) => row[s]);
}

/** What the workspace's data says, read by the apps (mirror of the prompt's `cardOpen`, engine right-hand-prompt). */
export interface FirstRunFacts {
  /** The workspace's context isn't empty. */
  context: boolean;
  /** An agent besides the right hand exists. */
  team: boolean;
  /** The right hand's AI is ready or waiting for its computer, and no billing hold. */
  ai: boolean;
  /** An app is connected. */
  apps: boolean;
  /** More than one member, or an invitation waiting for its answer. */
  people: boolean;
}

/** Whether the data did a row (a skip doesn't): what a row's line and burst celebrate. */
export const firstRunFact = (facts: FirstRunFacts, step: FirstRunDoneStep) =>
  facts[step === "about" ? "context" : step];

/**
 * The line a row says once done. A personal workspace's own words; its first two rows are only ever its own, so they
 * have no other.
 */
export const firstRunSayKey = (step: FirstRunDoneStep, personal: boolean) => {
  if (step === "about" || step === "team") return `agentSetup.firstRun.say.${step}Personal` as const;
  return personal ? (`agentSetup.firstRun.say.${step}Personal` as const) : (`agentSetup.firstRun.say.${step}` as const);
};

/** The rows done: from the data, or skipped ("Agora não", the only thing stored). */
export function firstRunDone(setup: AgentSetupChecklist, facts: FirstRunFacts): Set<FirstRunStep> {
  const done = new Set<FirstRunStep>();
  if (facts.context) done.add("about");
  if (facts.team) done.add("team");
  if (facts.ai) done.add("ai");
  if (facts.apps || setup.done.includes("apps")) done.add("apps");
  if (facts.people || setup.done.includes("people")) done.add("people");
  return done;
}

/**
 * What the right hand's line of the moment follows: each row done, the people row twice, `invited` while its
 * invitations only wait for an answer, then `people` once someone joined. Joining is what it celebrates; an
 * invitation it only says is sent.
 */
export type FirstRunBeat = FirstRunDoneStep | "invited";

/** The plan row is never done (it leaves when the hold lifts), so it is never a beat. */
export const firstRunBeats = (done: readonly FirstRunStep[], f: { members: number; invited: number }): FirstRunBeat[] =>
  done
    .filter((s): s is FirstRunDoneStep => s !== "plan")
    .map((s) => (s === "people" && f.members <= 1 && f.invited > 0 ? "invited" : s));

/** The row a beat's line shows under. */
export const beatRow = (beat: FirstRunBeat): FirstRunStep => (beat === "invited" ? "people" : beat);

/**
 * How a row reads now: done, open, or waiting for the plan (a billing hold: the plan row, where there is one, else the
 * hold's banner, holds the way to it).
 */
export type FirstRunRowState = "done" | "open" | "afterPlan";

/**
 * How a row reads now. On a hold the plan row is open, and a personal workspace's first two rows stay open too: its
 * agents wait for the plan asleep.
 */
export const firstRunRowState = (
  step: FirstRunStep,
  s: { done: ReadonlySet<FirstRunStep>; held: boolean },
): FirstRunRowState =>
  s.done.has(step) ? "done" : s.held && step !== "plan" && step !== "about" && step !== "team" ? "afterPlan" : "open";

/** The foot's asks wait for a team that can think: a team and an AI, never on a hold. */
export const firstRunAsks = (done: ReadonlySet<FirstRunStep>, held: boolean, team: boolean) =>
  !held && team && done.has("ai");

/** What the rows say, from what the app read: names already joined in the person's language. */
export interface FirstRunRowFacts {
  org: string;
  /** The agents besides the right hand, for a personal workspace's row of them. */
  agents?: number;
  /** What the right hand thinks with ("Claude"), once it does. */
  label: string | null;
  /** The apps connected ("o Gmail e o Drive"); null when none. */
  apps: string | null;
  members: number;
  /** Who was invited and hasn't answered yet ("João e Ana"); null when nobody. */
  invited: string | null;
  /** A personal workspace (ADR 0159): rows in its words (`PERSONAL_ROW_WORDS`). */
  personal?: boolean;
}

/**
 * What the card names as the right hand's AI ("Penso com …"): a plan's line ("Sonnet pelo plano do Claude"), else the
 * maker of the API it runs on ("Claude"), the workspace key's or its model's; null when unknown.
 */
export const firstRunAiLabel = (thinks: { text: string; kind: string }, maker: string | null | undefined) =>
  thinks.kind !== "agent" ? thinks.text : maker ? providerLabel(maker) : null;

/**
 * The words a personal workspace's rows say differently (ADR 0159), each a `<key>Personal` sibling of the row's key:
 * about the person instead of the company, their agents instead of a team, their apps instead of work apps.
 */
export const PERSONAL_ROW_WORDS: Partial<Record<FirstRunStep, readonly string[]>> = {
  plan: ["todo", "todoDesc"],
  about: ["todo", "todoDesc", "done"],
  team: ["todo", "todoDesc", "action", "done"],
  apps: ["todo", "todoDesc"],
};

/** One row's words: its title, a line under it while open, its button's word, and "Agora não" where a row skips. */
export function firstRunRow(
  tr: TFunction,
  step: FirstRunStep,
  state: FirstRunRowState,
  f: FirstRunRowFacts,
  skipped: boolean,
): SetupRow & { skip?: string } {
  // Keys built from the row's id, so read through an untyped `t`.
  const t = tr as unknown as (key: string, o?: Record<string, unknown>) => string;
  const k = (key: string) =>
    `agentSetup.firstRun.${step}.${key}${f.personal && PERSONAL_ROW_WORDS[step]?.includes(key) ? "Personal" : ""}`;
  // The AI row is the one right after the plan's, so it says so; the rest only open with the plan.
  if (state === "afterPlan")
    return {
      title: t(k("todo"), { org: f.org }),
      desc: t(step === "ai" ? "agentSetup.firstRun.afterPlanNext" : "agentSetup.firstRun.afterPlan"),
      action: "",
    };
  if (state === "done") {
    switch (step) {
      case "about":
        return { title: t(k("done"), { org: f.org }), action: t("agentSetup.change") };
      case "team":
        return { title: t(k("done"), { count: f.agents ?? 0 }), action: t("agentSetup.see") };
      case "ai":
        return { title: f.label ? t(k("done"), { label: f.label }) : t(k("doneAny")), action: t("agentSetup.switch") };
      case "apps":
        return { title: f.apps ? t(k("done"), { apps: f.apps }) : t(k("doneNone")), action: t("agentSetup.change") };
      case "people":
        return {
          title:
            f.members <= 1 && f.invited
              ? t(k("invited"), { names: f.invited })
              : skipped && f.members <= 1
                ? t(k("doneNone"))
                : t(k("done"), { count: f.members }),
          action: t(k("action")),
        };
    }
  }
  return {
    title: t(k("todo"), { org: f.org }),
    desc: t(k("todoDesc"), { org: f.org }),
    action: t(k("action")),
    ...(step === "apps" || step === "people" ? { skip: t("agentSetup.firstRun.notNow") } : {}),
  };
}

/**
 * The ready-made template agents' roles (mirror of `MEMBERS` in packages/engine/src/team-templates.ts), by handle,
 * for the apps a team just made would use (`firstRunApps`).
 */
const TEMPLATE_ROLES: Record<string, RoleId> = {
  iara: "support",
  caio: "finance",
  ada: "dev",
  lia: "content",
  theo: "sales",
  nina: "assistant",
  otto: "ops",
  bia: "support",
};

/** A template handle without its taken-name suffix (`iara-2` is Iara's). */
const templateHandle = (handle: string) => handle.replace(/-\d+$/, "");

/** A team agent's role, by its own role or its template handle (`iara-2` is Iara's). */
export const teamRole = (a: Pick<Agent, "handle" | "setup">): RoleId | null =>
  setupRole(a.setup) ?? TEMPLATE_ROLES[templateHandle(a.handle)] ?? null;

/** The apps (catalog connector ids) the team's roles suggest, the most suggested first. */
export function firstRunApps(team: readonly Pick<Agent, "handle" | "setup">[]): string[] {
  const count = new Map<string, number>();
  for (const a of team) {
    const role = teamRole(a);
    const apps = role
      ? Object.keys(ROLE_DEFAULTS[role].levels)
      : (PERSONAL_STARTER_APPS[templateHandle(a.handle)] ?? []);
    for (const id of apps) count.set(id, (count.get(id) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Row 4's list (web dialog, phone screen): the plug-and-play apps that connect here and aren't connected yet, the
 * team's suggestions first, at most six.
 */
export function firstRunAppList<D extends Pick<ConnectorDef, "id" | "auth" | "oauthConfigured" | "available" | "soon">>(
  defs: readonly D[],
  connected: ReadonlySet<string>,
  team: readonly Pick<Agent, "handle" | "setup">[],
): { def: D; suggested: boolean }[] {
  const order = firstRunApps(team);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return (
    defs
      // "Em breve" and an app the vendor hasn't approved yet open nothing: left out.
      .filter((d) => d.available && !d.soon && d.auth.includes("oauth") && d.oauthConfigured && !connected.has(d.id))
      .sort((a, b) => rank(a.id) - rank(b.id))
      .slice(0, 6)
      .map((def) => ({ def, suggested: order.includes(def.id) }))
  );
}
