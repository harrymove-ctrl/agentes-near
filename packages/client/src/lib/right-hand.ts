import type { TFunction } from "i18next";
import type { ApiClient } from "../api/client";
import type { Agent, AgentBrain, AgentStatus, BrainScope, Credential, DirectMessage, Me, Model } from "../api/types";
import { agentGrammar } from "./grammar";
import { AUTO, keyRuns, providerLabel } from "./providers";

/** The workspace's right hand (ADR 0137): every surface that treats it apart asks here. */
export const isRightHand = (agent: Pick<Agent, "builtin"> | null | undefined) => agent?.builtin === "right_hand";

/** Whether a channel's member pickers offer the agent: never the right hand, in no channel (an @mention reaches it). */
export const joinsChannels = (agent: Pick<Agent, "builtin">) => !isRightHand(agent);

/**
 * Whether an @mention in a conversation of `kind` reaches the agent though it isn't a member there: the right hand, in
 * any channel, never a DM (the server's `rightHandReaches`). The "@" pickers count it as in, with nothing to add.
 */
export const mentionReaches = (agent: Pick<Agent, "builtin">, kind: "channel" | "dm") =>
  kind === "channel" && isRightHand(agent);

/**
 * What the person's DM thinks with while they have no AI of their own (ADR 0137 §11), as one line: the workspace's key,
 * its plan where that serves them, or that it doesn't. `name`: its grammar (`agentGrammar`); `firstName`: of a member.
 */
export function rightHandFallback(
  t: TFunction,
  ai: NonNullable<AgentBrain["workspaceAi"]>,
  meId: string | undefined,
  name: Record<string, unknown>,
  firstName: (userId: string) => string | undefined,
  /** This server has a key of its own, which serves where the workspace has none. */
  platform = false,
): string {
  if (ai.brain === "model") {
    if (ai.key) return t("rightHand.settings.fallbackKeyOf", { label: ai.key.label });
    return t(ai.key === null && !platform ? "rightHand.settings.fallbackNoKey" : "rightHand.settings.fallbackKey");
  }
  const owner = (ai.ownerId && firstName(ai.ownerId)) ?? "";
  if (!ai.servesYou) return t("rightHand.settings.fallbackNone", { ...name, owner });
  return ai.ownerId === meId ? t("rightHand.settings.fallbackYours") : t("rightHand.settings.fallbackPlan", { owner });
}

/**
 * "Sua IA" as one status, web and phone alike: what answers the person in their own DM with the right hand. `own`: a
 * plan of theirs or one shared with them (`ownerId` when it isn't theirs); `key`: the workspace's API key, or this
 * server's own where the workspace has none (by its maker, the right hand's brain line's `maker`, when known); `plan`:
 * the workspace's plan, which serves them; `nobody`: nothing does yet. Null while the view loads.
 */
export type MineStatus =
  | { kind: "own"; brain: AgentBrain["brain"]; label?: string; ownerId?: string }
  | { kind: "key"; label?: string; provider?: string }
  | { kind: "plan"; brain: AgentBrain["brain"] }
  | { kind: "nobody" };

export function mineStatus(
  view: AgentBrain | undefined,
  meId: string,
  platform: boolean,
  maker?: string,
): MineStatus | null {
  if (!view) return null;
  if (view.brain !== "model") {
    const signIn = view.accounts.find((a) => a.id === view.account);
    const ownerId = signIn?.ownerId && signIn.ownerId !== meId ? signIn.ownerId : undefined;
    return { kind: "own", brain: view.brain, label: signIn?.label, ownerId };
  }
  const ai = view.workspaceAi;
  if (!ai) return { kind: "nobody" };
  if (ai.brain === "model") {
    if (ai.key) return { kind: "key", label: ai.key.label, provider: ai.key.provider };
    if (ai.key === null && !platform) return { kind: "nobody" };
    return maker ? { kind: "key", label: providerLabel(maker), provider: maker } : { kind: "key" };
  }
  return ai.servesYou ? { kind: "plan", brain: ai.brain } : { kind: "nobody" };
}

/**
 * What a connect flow says once an AI is chosen. The team's right hand has two AIs, and the words say which moved:
 * the workspace's (everyone without a plan of their own) or the person's alone. Any other agent has one.
 */
export const thinksWithLine = (t: TFunction, scope: BrainScope | undefined, agent: string, label: string) =>
  scope
    ? t(`rightHand.saved.${scope}`, { ...agentGrammar(agent), label })
    : t("aiAccounts.done.savedAgent", { agent, label });

/**
 * The right hand on a workspace key, web and phone: the workspace's AI goes to its API key, the key is pinned, with
 * Automático where the model chosen before can't run on it, and the person's own DM goes back to that AI. In that
 * order: someone the workspace's AI refuses keeps their own as it was.
 */
export async function rightHandOnKey(
  api: ApiClient,
  orgId: string,
  agent: Pick<Agent, "id" | "model">,
  key: Pick<Credential, "id" | "provider">,
  models: readonly Model[],
) {
  await api.agents.setBrain(orgId, agent.id, { scope: "workspace", brain: "model" });
  const fits = keyRuns(key, agent.model, models);
  await api.agents.update(orgId, agent.id, { credentialId: key.id, ...(fits ? {} : { model: AUTO }) });
  await api.agents.setBrain(orgId, agent.id, { brain: "model" });
}

/** Its one-time "Novo" is per person and workspace (`seenList` entries), gone once its DM opened. */
export const rightHandSeenKey = (userId: string, orgId: string) => `${userId}.${orgId}`;

/**
 * Whether this is the person's first visit to the right hand's DM, so it waves under its greeting (ADR 0137 §6):
 * they never read it, on any device. Unknown (undefined) while their DMs load or before it is one of them.
 */
export function firstVisitOf(dms: readonly DirectMessage[] | undefined, agentId: string): boolean | undefined {
  const dm = dms?.find((d) => d.with.type === "agent" && d.with.id === agentId);
  return dm ? dm.everRead === false : undefined;
}

/** The workspace's right hand among its agents, when this person may see it. */
export const rightHandOf = <A extends Pick<Agent, "builtin">>(agents: readonly A[]) => agents.find(isRightHand);

/**
 * Its name and look before the workspace exists (the onboarding's first question): the server's
 * `RIGHT_HAND_DEFAULTS` (packages/engine/src/right-hand.ts).
 */
export const RIGHT_HAND_DEFAULT = {
  name: "Lodi",
  appearance: { color: "teal", eyes: "happy", accessory: "headset" },
} as const;

/** Where its name comes from ("lodestar") is told only while it keeps that name: a renamed one has another story. */
export const tellsNameStory = (agent: Pick<Agent, "builtin" | "name"> | null | undefined) =>
  isRightHand(agent) && agent?.name === RIGHT_HAND_DEFAULT.name;

/** Where a workspace whose onboarding just ended opens, and `/me` as it is now (null: ask for it). */
export interface OpenedAt {
  orgId: string;
  agentId: string | null;
  me: Me | null;
}

/**
 * Ends a workspace's onboarding, for good, in one call, and says where it opens: its right hand's DM (ADR 0137), which
 * takes the setup on from there; the workspace itself (`agentId` null) when there is none to open. An older server
 * doesn't say: its agents do.
 */
export async function finishOnboarding(api: ApiClient, orgId: string): Promise<OpenedAt> {
  const done = await api.orgs.saveOnboarding(orgId, { finished: true });
  const agentId =
    done?.rightHandId !== undefined
      ? done.rightHandId
      : (rightHandOf(await api.agents.list(orgId).catch(() => []))?.id ?? null);
  return { orgId, agentId, me: done?.me ?? null };
}

/**
 * Whether its first-run card leads with the plan for this person (the card's plan row, `firstRunSteps`, ADR 0162):
 * the card still up, the workspace waiting for its first agentes.chat plan, and an owner who may pay. Here, apart from
 * the card's rows, for the hold's banner, which every page loads.
 */
export const leadsWithPlan = (
  agent: Pick<Agent, "setup" | "builtin">,
  may: { owner: boolean; pay: boolean; waitsForPlan?: boolean },
) => agent.builtin === "right_hand" && Boolean(agent.setup) && may.owner && Boolean(may.waitsForPlan) && may.pay;

/**
 * The line under its greeting: on a billing hold with no team yet, how the team comes and that it works with the
 * plan; otherwise what it does (once a team is here, the checklist's plan row, which leads it while the workspace
 * waits for its first plan, and the hold's banner already say the plan; ADR 0162).
 */
export const introLeadKey = (held: boolean, hasTeam: boolean) =>
  held && !hasTeam ? ("rightHand.intro.heldLead" as const) : ("rightHand.intro.lead" as const);

/** Where the first-run checklist stands for this person (ADR 0155 §6): `none` when it isn't theirs. */
export type FirstRunState = "none" | "open" | "complete";

/**
 * Whether its greeting ends with the way to build the team again, for whoever may create agents once an AI is there:
 * only with a team, no card left under the greeting (`cards`) and no open checklist, which would offer the same or
 * ask something first.
 */
export const offersTeamSetup = (s: {
  noAi: boolean;
  aiKnown: boolean;
  createsAgents: boolean;
  hasTeam: boolean;
  /** `introCards`. */
  cards: readonly string[];
  /** A billing hold (`planHoldOf`): it can't answer, so its line would send a message that gets refused. */
  held?: boolean;
  checklist?: FirstRunState;
}) => s.aiKnown && !s.noAi && !s.held && s.createsAgents && s.hasTeam && s.cards.length === 0 && s.checklist !== "open";

/**
 * The cards under the right hand's greeting at the top of its DM besides the first-run checklist (ADR 0137, ADR 0155
 * §6), one question at a time. The owner's checklist has the setup in its rows: while it is open nothing else asks,
 * and once complete, how the person wants agents to talk to them (ADR 0147) until they pick, asked only once the team
 * answered them (`answered`), so it never stands beside the first task. Anyone else: Connect AI while there is none,
 * then that question. On a billing hold neither: an AI comes after the plan.
 */
export function introCards(s: {
  noAi: boolean;
  /** The AI status has loaded. */
  aiKnown: boolean;
  /** They never picked how agents talk to them (`agentStyle` null; undefined from an older server). */
  askStyle?: boolean;
  /** A billing hold (`planHoldOf`). */
  held?: boolean;
  /** A no-AI card already answered them in this conversation: its Connect is the one to press. */
  noAiCard?: boolean;
  checklist?: FirstRunState;
  /** `teamAnswered`; absent, nothing to wait for. */
  answered?: boolean;
}): ("connect" | "style")[] {
  if (s.checklist === "open") return [];
  if (s.noAi && !s.held && s.checklist !== "complete") return s.noAiCard ? [] : ["connect"];
  if (s.askStyle && s.aiKnown && !s.held && s.answered !== false) return ["style"];
  return [];
}

/**
 * A team agent has worked (`activeAt`: its last run's end, null while it never did): the person's first task had its
 * answer, or a routine ran. With no team there is no first task to wait for; before the statuses load, it waits.
 */
export const teamAnswered = (
  team: readonly Pick<Agent, "id">[],
  statuses: readonly Pick<AgentStatus, "agentId" | "activeAt">[] | undefined,
) => team.length === 0 || (statuses?.some((s) => s.activeAt !== null && team.some((a) => a.id === s.agentId)) ?? false);
