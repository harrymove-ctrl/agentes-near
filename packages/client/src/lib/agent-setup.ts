import type { TFunction } from "i18next";
import type {
  AgentBrain,
  AgentBrainInput,
  AgentSetup,
  AgentSetupResult,
  BrainMachine,
  CommandApproval,
  Model,
  NewAgentSetup,
} from "../api/types";
import { thinksWith } from "./brain";
import { advancedParts, effortLevel, viewSpeedFits } from "./brain-advanced";
import { isContextLimit } from "./context-limits";
import { firstName } from "./format";
import { planLabel, planOfAccount } from "./no-ai";
import { planModel, planOf } from "./plans";
import { isAuto } from "./providers";

/*
 * One agent's "Quem pensa" and its Autonomia on others (ADR 0094), the same on the web (a dialog over "Quem pensa")
 * and the phone (a screen from "Pensa com"), and the setup a new agent starts with. The server decides what each agent
 * takes.
 */

/** The setup an agent's saved "Quem pensa" and Autonomia say, for a computer brain (the phone's "Pensa com"). */
export function setupOfBrain(view: AgentBrain): AgentSetup | null {
  if (view.brain === "model" || !view.computer) return null;
  return {
    brain: view.brain,
    machineId: view.computer.machineId,
    account: view.account,
    model: view.model,
    effort: view.effort,
    ...(viewSpeedFits(view) ? { speed: view.speed } : {}),
    contextTokens: view.contextTokens,
    fallback: view.fallback,
    onlyOwner: view.onlyOwner,
    ...(view.autonomy ? { autonomy: view.autonomy } : {}),
  };
}

/** It changes: it takes the AI, or its Autonomia (even where its AI can't change). */
export const changes = (r: AgentSetupResult) => r.status === "applied" || r.autonomy !== undefined;

const rank = (r: AgentSetupResult) => {
  if (!changes(r)) return r.status === "same" ? 2 : 3;
  return r.status === "skipped" ? 1 : 0;
};

/**
 * Who takes it all first, then who takes only the Autonomia, then who already has it all, then who can't take it;
 * each group in the order asked.
 */
export const sortedResults = (results: readonly AgentSetupResult[]) => [...results].sort((a, b) => rank(a) - rank(b));

/** The agents "Todos" picks: those that change. */
export const takers = (results: readonly AgentSetupResult[]) => results.filter(changes).map((r) => r.agentId);

/** After "Usar": how many think with the setup now, how many took only its Autonomia, how many didn't change. */
export function setupOutcome(results: readonly AgentSetupResult[], asked: number) {
  const done = results.filter((r) => r.status !== "skipped").length;
  const autonomyOnly = results.filter((r) => r.status === "skipped" && r.autonomy).length;
  return { done, autonomyOnly, missed: asked - done - autonomyOnly };
}

/** A new agent's Autonomia when nobody chose one, as the engine's `DEFAULT_MISSION_COMMAND_APPROVAL`. */
export const DEFAULT_AUTONOMY: CommandApproval = "low_risk_auto";

/** "Não pergunta": an Autonomia's name. */
export const autonomyName = (t: TFunction, a: CommandApproval) => t(`missions.commandApproval.${a}`);

/** "Autonomia: Não pergunta", the last of a setup's words. */
export const autonomyWords = (t: TFunction, a: CommandApproval) =>
  t("missions.commandApproval.changed", { value: autonomyName(t, a) });

/**
 * The line under an agent: what it thinks with now (`now`), what it keeps, that it already thinks so, or why it
 * can't take it (`owner`: the agent's owner's first name, for who else may change it); then its Autonomia's change.
 */
export function setupResultLine(
  t: TFunction,
  r: AgentSetupResult,
  o: { now: string; owner?: string | null | undefined },
): string {
  const ai = aiLine(t, r, o);
  if (!r.autonomy) return ai;
  const { from, to } = r.autonomy;
  const autonomy = t("agentPage.work.brain.copy.autonomy", { from: autonomyName(t, from), to: autonomyName(t, to) });
  return `${ai} · ${autonomy}`;
}

function aiLine(t: TFunction, r: AgentSetupResult, o: { now: string; owner?: string | null | undefined }): string {
  const p = r.params ?? {};
  if (r.status === "same") return t("agentPage.work.brain.copy.same");
  if (r.status === "applied") {
    if (!r.keeps) return t("agentPage.work.brain.copy.now", { brain: o.now });
    return r.keeps.account
      ? t("agentPage.work.brain.copy.keeps", { account: r.keeps.account })
      : t("agentPage.work.brain.copy.keepsOwn");
  }
  switch (r.reason) {
    case "not_allowed":
      return o.owner
        ? t("agentPage.work.brain.copy.reasons.not_allowed", { owner: o.owner })
        : t("agentPage.work.brain.copy.reasons.not_allowedNobody");
    case "admins_only":
      return t("agentPage.work.brain.copy.reasons.admins_only");
    case "account_owner":
      return p.owner
        ? t("agentPage.work.brain.copy.reasons.account_ownerOf", { owner: firstName(p.owner) })
        : t("agentPage.work.brain.copy.reasons.account_owner");
    case "account_single":
      return t("agentPage.work.brain.copy.reasons.account_single", { agent: p.agent ?? "" });
    case "other_computer":
      return p.computer
        ? t("agentPage.work.brain.copy.reasons.other_computer", { computer: p.computer })
        : t("agentPage.work.brain.copy.reasons.other_computerNone");
    case "model_missing":
      return t("agentPage.work.brain.copy.reasons.model_missing", { plan: p.plan ?? "", model: p.model ?? "" });
    default:
      return t("agentPage.work.brain.copy.reasons.failed");
  }
}

/** What "Criar agente" starts on: the API's model, key and context window, or a plan on a computer, saved after. */
export type NewAgentStart = (
  | { brain: "model"; model: string; key: string | null; contextTokens: number | null }
  | {
      brain: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
      machineId: string;
      computer: string;
      account: { id: string; label: string } | null;
      /** Saved as its "Quem pensa" once the agent exists. */
      input: AgentBrainInput;
    }
) & {
  /** Its Autonomia, sent with the agent: only where the person may set it, on their own agent or, as an admin, any. */
  autonomy?: CommandApproval;
};

/**
 * The setup a new agent starts with (ADR 0094), where it can think for it: the API's while its model runs (`usable`,
 * as `usableModels` says), with its key where the person sees it (`keys`, else the workspace's default); a plan only
 * for an agent of the person's own, on their account with room for one more agent or on a computer they connected
 * (its own sign-in). Its Autonomia goes with it where the person could set it by hand: their own agent, or any agent
 * for an admin (`admin`). Null: "Automático" on the API, as before.
 */
export function newAgentStart(
  s: NewAgentSetup | null | undefined,
  o: { ownerIsMe: boolean; admin?: boolean; usable: ReadonlySet<string>; keys: readonly { id: string }[] },
): NewAgentStart | null {
  if (!s) return null;
  const autonomy = s.autonomy && (o.ownerIsMe || o.admin) ? { autonomy: s.autonomy } : {};
  if (s.brain === "model") {
    if (!s.model || !(isAuto(s.model) ? o.usable.size > 0 : o.usable.has(s.model))) return null;
    const key = o.keys.some((k) => k.id === s.key) ? s.key : null;
    return { brain: "model", model: s.model, key, contextTokens: s.contextTokens, ...autonomy };
  }
  if (!o.ownerIsMe || !s.computer) return null;
  if (s.account ? !(s.account.mine && s.account.free) : !s.ownSignIn) return null;
  return {
    brain: s.brain,
    machineId: s.computer.machineId,
    computer: s.computer.name,
    account: s.account ? { id: s.account.id, label: s.account.label } : null,
    input: {
      brain: s.brain,
      account: s.account?.id ?? null,
      model: s.model,
      effort: s.effort ?? null,
      contextTokens: s.contextTokens,
      fallback: s.fallback ?? true,
    },
    ...autonomy,
  };
}

/**
 * What a new agent starts with, in words: the API's model ("Claude Opus 5.5", "Automático"), or the model by its plan
 * and what differs in its advanced settings ("Opus pelo plano do Claude · Esforço alto"), then its Autonomia.
 */
export function newAgentStartText(
  t: TFunction,
  language: string,
  start: NewAgentStart,
  o: { models: readonly Model[]; machines: readonly BrainMachine[]; provider?: string | null | undefined },
): string {
  const autonomy = start.autonomy ? [autonomyWords(t, start.autonomy)] : [];
  if (start.brain === "model") {
    const model = isAuto(start.model)
      ? t("brain.auto.label")
      : (o.models.find((m) => m.id === start.model)?.label ?? start.model);
    return [model, ...autonomy].join(" · ");
  }
  const option = o.machines.find((m) => m.machineId === start.machineId)?.options.find((x) => x.kind === start.brain);
  const value = start.input.model ?? option?.defaultModel ?? null;
  const coding = planOf(o.provider);
  const name = isAuto(value)
    ? t("brain.auto.label")
    : coding
      ? planModel(coding, value).label
      : (option?.models.find((m) => m.value === value)?.label ?? value);
  const parts = advancedParts(t, language, {
    kind: start.brain,
    autoModel: isAuto(value),
    apiKey: true,
    now: {
      effort: effortLevel(start.input.effort),
      speed: "standard",
      contextTokens: isContextLimit(start.input.contextTokens) ? start.input.contextTokens : null,
      onlyOwner: true,
      fallback: start.input.fallback ?? true,
    },
  });
  const plan = planOfAccount({ kind: start.brain, provider: o.provider ?? null });
  return [name ? thinksWith(t, plan, name) : planLabel(t, plan), ...parts, ...autonomy].filter(Boolean).join(" · ");
}
