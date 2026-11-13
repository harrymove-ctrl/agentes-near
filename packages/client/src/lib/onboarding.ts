import type { TFunction } from "i18next";
import type { Agent, AgentInput, OrgStanding, Routine } from "../api/types";
import { billingHoldOf } from "./billing";
import { AUTO } from "./providers";
import { handleFrom } from "./text";

/** The ready-made agents a new workspace is offered (in its right hand's DM, ADR 0137), in this order. */
export const PRESETS = ["theo", "ada", "lia", "atlas"] as const;
export type Preset = (typeof PRESETS)[number];

/** Each preset's own look, saved on the agent it creates (the emails draw the same faces). */
export const PRESET_LOOK: Record<Preset, { color: string; eyes: string; accessory: string }> = {
  theo: { color: "indigo", eyes: "round", accessory: "cap" },
  ada: { color: "green", eyes: "wide", accessory: "headphones" },
  lia: { color: "rose", eyes: "dots", accessory: "flower" },
  atlas: { color: "amber", eyes: "round", accessory: "antenna" },
};

/** The "Criar agente" role whose instructions each preset starts with; Lia has her own. */
const PRESET_ROLE: Record<Preset, "pm" | "dev" | "ops" | null> = { theo: "pm", ada: "dev", lia: null, atlas: "ops" };

/** A preset as the create route takes it: on Automático and the workspace's default key. */
export function presetInput(t: TFunction, preset: Preset): AgentInput {
  const name = t(`onboarding.presets.${preset}.name`);
  const role = PRESET_ROLE[preset];
  return {
    name,
    handle: handleFrom(name),
    role: t(`onboarding.presets.${preset}.role`),
    instructions: role ? t(`newAgent.roles.${role}.instructions`) : t("onboarding.presets.lia.instructions"),
    model: AUTO,
    credentialId: null,
    appearance: PRESET_LOOK[preset],
  };
}

/**
 * The onboarding's steps, in order (the server's `ONBOARDING_STEPS`, `packages/db/src/schema/tenancy.ts`, keeps the
 * furthest one reached).
 * "import" reads another product's export (apps/web/src/lib/import); its
 * agents arrive chosen in "agents", which only picks and creates the team.
 * "computer" comes before "ai": a computer the agents can use helps that step,
 * whose plan sign-in runs on it.
 * The web's rail reads them back as answers with no data of their own (`RailFunnel`, ADR 0162): "import" for a team
 * that brings no agents and goes on to its templates, "agents" for a team step left with no agents (a personal
 * workspace's "no agents yet", a team's "Skip this step" or "Create the agents later"), "computer" for a plan step that
 * was shown, "ai" for a team's AI step left for later ("Connect later", the people step next) and "team" for its
 * invitations sent.
 */
export const ONBOARDING_STEPS = [
  { id: "workspace", optional: false },
  { id: "context", optional: false },
  { id: "import", optional: true },
  { id: "agents", optional: false },
  { id: "computer", optional: true },
  { id: "ai", optional: false },
  { id: "team", optional: true },
  { id: "done", optional: false },
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

export const stepIndex = (id: OnboardingStepId) => ONBOARDING_STEPS.findIndex((s) => s.id === id);

/**
 * The onboarding's steps on the rail (ADR 0162), web and phone: the workspace's name, what it does, its team (its
 * agents), the plan (agentes.chat Cloud), connecting an AI and, last, inviting people (`people`: the web's team rail
 * only, amended 2026-11-11). A personal workspace (ADR 0159) has no "what it does" step: its name step is the purpose
 * question. The phone lists neither the AI step, the people step nor a personal path (`railState`'s `funnel`).
 */
export type RailStep = "name" | "business" | "team" | "plan" | "ai" | "people";
export const railSteps = (f: { plan: boolean; ai: boolean; personal: boolean; people?: boolean }): RailStep[] => [
  ...(f.personal ? (["name"] as const) : (["name", "business"] as const)),
  "team",
  ...(f.plan ? (["plan"] as const) : []),
  ...(f.ai ? (["ai"] as const) : []),
  ...(f.people ? (["people"] as const) : []),
];

/**
 * The step to show, read from the workspace's data (it exists, has its context, has a team, waits for its plan, its
 * team thinks, its people were invited), so a workspace left at any step resumes there; "open" once it is ready to
 * open. `ai` and `people` say whether the rail has those steps at all.
 */
export function railStepAt(f: {
  created: boolean;
  context: boolean;
  team: boolean;
  waitsForPlan: boolean;
  personal: boolean;
  ai: boolean;
  thinks: boolean;
  people?: boolean;
  invited?: boolean;
}): RailStep | "open" {
  if (!f.created) return "name";
  if (!f.personal && !f.context) return "business";
  if (!f.team) return "team";
  if (f.waitsForPlan) return "plan";
  if (f.ai && !f.thinks) return "ai";
  return f.people && !f.invited ? "people" : "open";
}

/**
 * What the web's rail reads besides the workspace's data (ADR 0162, amended 2026-11-10 and 2026-11-11): whether every
 * agent thinks (`teamThinks`; undefined while that isn't known, read as not yet) and the furthest step the server
 * stored (`onboarding.step`), which answers what has no data of its own: a team step left with no agents ("agents": a
 * personal workspace's "no agents yet", a team's "Skip this step" or "Create the agents later"), a plan step once
 * shown ("computer", so the step stays on the rail, answered, after paying), a team's AI step left for later ("ai")
 * and its people invited ("team").
 */
export interface RailFunnel {
  thinks: boolean | undefined;
  passed: OnboardingStepId | undefined;
}

/**
 * Where an onboarding stands, web and phone: its steps, the one its data reaches, how many are answered, and the step
 * to show, which is one the person went back to (`picked`) while it stays answered, else the one reached. Before the
 * workspace exists only the server's billing says whether a plan step will come.
 *
 * `funnel` null (the phone) keeps the rail it has always had: no AI step, and a personal workspace (ADR 0159) has no
 * steps once it exists (it opens, its right hand's card holds the rest). With a funnel (the web, ADR 0162 amended
 * 2026-11-10) the rail ends on connecting an AI, answered once every agent thinks, and a personal workspace walks it
 * too, with no "what it does" step. The team step is answered by agents brought in or made, or by leaving it with no
 * agents (amended 2026-11-11): a personal workspace's "no agents yet", a team's way out of its question or templates.
 * A team's rail then ends on inviting people (amended 2026-11-11), after the AI step, which every agent thinking or
 * "Connect later" answers; the invitations sent answer it, and leaving it for later finishes the onboarding.
 */
export function railState(f: {
  orgId: string | null;
  standing: OrgStanding | undefined;
  billingUrl: string | null | undefined;
  context: string;
  team: number;
  picked: RailStep | null;
  personal?: boolean;
  funnel: RailFunnel | null;
}) {
  const waitsForPlan = f.orgId ? billingHoldOf(f.standing) === "payment" : Boolean(f.billingUrl);
  const funnel = f.funnel;
  const personal = Boolean(f.personal);
  const passed = stepIndex(funnel?.passed ?? "workspace");
  const computer = stepIndex("computer");
  // A plan step shown once stays on the rail, answered, after paying; a server that never held the workspace has none.
  // Past it ("ai", "team"), only a server with billing showed it: a self-hosted one keeps none.
  const hasPlanStep =
    waitsForPlan || (funnel !== null && (passed === computer || (passed > computer && Boolean(f.billingUrl))));
  // Inviting people ends a team's rail on the web, never a personal workspace's nor the phone's.
  const people = funnel !== null && !personal;
  const steps = funnel
    ? railSteps({ plan: hasPlanStep, ai: true, personal, people })
    : railSteps({ plan: waitsForPlan, ai: false, personal: false });
  const at =
    !funnel && personal && f.orgId !== null
      ? "open"
      : railStepAt({
          created: f.orgId !== null,
          context: f.context.trim() !== "",
          // The step left with no agents ("agents") answers it, in a team's workspace too; a team's "no agents yet"
          // saves only "import", its templates still to come.
          team: f.team > 0 || (funnel !== null && passed >= stepIndex("agents")),
          waitsForPlan,
          personal: funnel !== null && personal,
          ai: funnel !== null,
          // Every agent thinks, or a team left its AI step for later ("ai").
          thinks: funnel?.thinks === true || (people && passed >= stepIndex("ai")),
          people,
          invited: passed >= stepIndex("team"),
        });
  const reached = at === "open" ? steps.length : steps.indexOf(at);
  const back = f.picked ? steps.indexOf(f.picked) : -1;
  const step = back >= 0 && back < reached ? steps[back] : steps[Math.min(reached, steps.length - 1)];
  return {
    steps,
    at,
    reached,
    step: step ?? "name",
    index: steps.indexOf(step ?? "name"),
    waitsForPlan,
    hasPlanStep,
    /** Every agent thinks (the AI step answered by its data, not left for later). */
    thinks: funnel?.thinks === true,
  };
}

/** What an agent does first, as the plan step lists it: its first routine, else its role. */
export const firstJob = (
  agent: Pick<Agent, "id" | "role">,
  routines: readonly Pick<Routine, "agentId" | "name">[] = [],
) => routines.find((r) => r.agentId === agent.id)?.name ?? agent.role;

/**
 * Where the workspace opens when the onboarding ends: #general, or its right hand's DM when the plan was left. A
 * personal workspace always opens in its right hand's DM, its card there (ADR 0159): its #general is out of sight.
 */
export const landingOf = (how: "paid" | "done" | "skipped", personal = false) =>
  personal || how === "skipped" ? "rightHand" : "general";
