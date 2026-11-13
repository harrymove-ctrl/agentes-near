import type { TFunction } from "i18next";
import type { AgentBrainInput, AiAccounts, BrainMachine, MachineAccountKind, Model } from "../api/types";
import { accountChoices, accountTitle, ownSignInReady } from "./ai-accounts";
import { thinksWith } from "./brain";
import { isClaudeAlias } from "./brain-advanced";
import { namesComputers } from "./machines";
import { kindOf, PLAN_CHOICES, type PlanChoice, planLabel, planMark, planOfAccount, planSearchNames } from "./no-ai";
import {
  type BrainModelChoice,
  brainModelChoices,
  type CodingPlan,
  type PlanModelNeed,
  planFreeHint,
  planOf,
} from "./plans";
import { AUTO, isAuto, type ModelChoice, providerLabel } from "./providers";

/*
 * "Quem pensa" as one searchable list (web and phone): the new agent's step offers what the agent's page offers,
 * from the same pieces (`modelChoices` for the API, `PLAN_CHOICES` and `brainModelChoices` for the plans, the same
 * model lines). Automático first, then each API provider's models, then each plan on each computer that runs it with
 * Automático and its models. A coding plan with no key of the person's yet is one pick that connects it once the
 * agent exists; its models show, unpickable, so a search still finds them.
 */

/** What a pick makes the agent think with. */
export type BrainPick =
  | { kind: "model"; model: string }
  | {
      kind: MachineAccountKind;
      choice: PlanChoice;
      machineId: string;
      /** A coding plan's key account of the person's; none: the computer's own sign-in. */
      accountId?: string;
      account?: string;
      model: string;
    }
  /** A plan with nothing to think with yet: the agent is made on Automático, then Connect opens on this plan. */
  | { kind: "connect"; choice: PlanChoice };

export interface BrainPickOption {
  value: string;
  label: string;
  /** What the chosen option reads as ("Sonnet on the Claude plan"). */
  title: string;
  /** Its heading; none for Automático. */
  group?: string;
  /** A `ProviderLogo` id; none: Automático's bulb. */
  mark?: string;
  description?: string;
  /** What the plan's account must allow before it answers, and that as a note behind its ⓘ. */
  needs?: PlanModelNeed;
  hint?: string;
  disabled: boolean;
  free: boolean;
  /** What a search finds it by besides its label, value and group. */
  keywords: string;
  pick: BrainPick;
}

/** Claude's own models describe themselves by family; any other, by its price ("Grátis" for a free one). */
const CLAUDE_FAMILIES = ["sonnet", "opus", "haiku"] as const;
const claudeFamily = (model: Model) =>
  model.provider === "anthropic" ? CLAUDE_FAMILIES.find((f) => model.id.toLowerCase().includes(f)) : undefined;
const freeModel = (model: Model) => model.inputUsdPerMTok === 0 && model.outputUsdPerMTok === 0;

export function modelDescription(t: TFunction, locale: string, model: Model) {
  const family = claudeFamily(model);
  if (family) return t(`newAgent.modelDesc.${family}`);
  if (freeModel(model)) return t("newAgent.modelDesc.free");
  const fmt = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  return t("newAgent.modelDesc.other", { input: fmt(model.inputUsdPerMTok), output: fmt(model.outputUsdPerMTok) });
}

/** A plan's model line, as the agent's page and the new agent's step say it: what it's for, sold as, or costs. */
export function brainModelLine(
  t: TFunction,
  kind: string,
  plan: CodingPlan | undefined,
  m: BrainModelChoice,
  /** Cursor's CLI said which models the plan includes (ADR 0114). */
  cursorPlanSays = false,
): string | undefined {
  if (!plan && kind === "claude_code" && isClaudeAlias(m.value)) return t(`agentPage.work.brain.modelLine.${m.value}`);
  if (cursorPlanSays) return t(m.inPlan ? "brain.cursorModel.inPlan" : "brain.cursorModel.apiPrice");
  const parts = [m.free ? t("brain.free") : undefined, m.tag ? t(`brain.modelTag.${m.tag}`) : undefined];
  return parts.filter(Boolean).join(" · ") || undefined;
}

/** What a search reads of an option. */
export const brainPickText = (o: Pick<BrainPickOption, "label" | "value" | "group" | "keywords">) =>
  `${o.label} ${o.value} ${o.group ?? ""} ${o.keywords}`;

/** The API's models, as the agent's page lists them: each provider's under its name, a long list's good picks first. */
export function apiPickOptions(t: TFunction, locale: string, choices: [string, ModelChoice[]][]): BrainPickOption[] {
  return choices.flatMap(([provider, list]) =>
    list.map(({ model: m, available }) => ({
      value: m.id,
      label: m.label,
      title: m.label,
      group: m.pick ? t("models.picks", { provider: providerLabel(provider) }) : providerLabel(provider),
      mark: provider,
      description: available
        ? modelDescription(t, locale, m)
        : t("newAgent.modelNeedsKey", { provider: providerLabel(provider) }),
      disabled: !available,
      free: freeModel(m),
      keywords: freeModel(m) ? `free ${t("brain.free")}` : "",
      pick: { kind: "model", model: m.id },
    })),
  );
}

/** The first of the person's plan accounts "Quem pensa" offers, on Automático: what a new agent of theirs defaults to. */
export const planAccountOption = (options: readonly BrainPickOption[]) =>
  options.find((o) => !o.disabled && "accountId" in o.pick && Boolean(o.pick.accountId) && o.pick.model === AUTO);

/** A plan account option that wasn't among `before` (the options' values when "Conectar uma IA" opened): the one just connected. */
export const newPlanAccountOption = (options: readonly BrainPickOption[], before: ReadonlySet<string>) =>
  planAccountOption(options.filter((o) => !before.has(o.value)));

/** The API provider whose models a plan also thinks with (Claude's plan: Anthropic's models). */
const PLAN_PROVIDER: Partial<Record<PlanChoice, string>> = { claude: "anthropic", chatgpt: "openai" };

export function brainPickOptions(
  t: TFunction,
  locale: string,
  {
    api,
    machines,
    accounts,
    ownerIsMe,
    held = false,
  }: {
    /** `modelChoices(…)`. */
    api: [string, ModelChoice[]][];
    /** The computers the person may give the agent (`useBrainMachines`). */
    machines: readonly BrainMachine[];
    /** The person's AI accounts (`useAiAccounts`). */
    accounts: AiAccounts["accounts"];
    /** The new agent is the viewer's: only the owner of both the agent and an account chooses it. */
    ownerIsMe: boolean;
    /** A billing hold stops the plans (`planHoldOf`): that, not the computers, is why they are off. */
    held?: boolean;
  },
): BrainPickOption[] {
  const auto: BrainPickOption = {
    value: AUTO,
    label: t("brain.auto.label"),
    title: t("brain.auto.label"),
    description: t("brain.auto.hint"),
    // "Automático" picks from the line of the agent's key: usable once any model is.
    disabled: !api.some(([, list]) => list.some((c) => c.available)),
    free: false,
    keywords: "",
    pick: { kind: "model", model: AUTO },
  };
  const names = namesComputers(machines);
  // The accounts it can think with at once, one per account as the agent's page lists them (`accountChoices`): the
  // viewer's, signed in, and free or made for all of their agents. One in use moves, or signs in once more, only from
  // the agent's page; the server refuses it here (`account.in_use`, `account.not_owner`).
  const ready = ownerIsMe
    ? accountChoices(accounts, [])
        .map((c) => c.login)
        .filter((a) => a.mine && a.status === "active" && (a.shared === true || a.usedBy.length === 0))
    : [];
  const plans = PLAN_CHOICES.flatMap((choice): BrainPickOption[] => {
    const kind = kindOf(choice);
    const coding = planOf(choice);
    const name = thinksWith(t, choice, null);
    const searched = `${name} ${planSearchNames(choice)}`;
    const freeHint = planFreeHint(t, coding);
    const on = machines.filter((m) => m.options.some((o) => o.kind === kind && o.available));
    const rows = (
      base: Omit<Extract<BrainPick, { machineId: string }>, "model">,
      group: string,
      models: BrainModelChoice[],
    ): BrainPickOption[] => {
      const cursorSays = kind === "cursor" && models.some((m) => m.inPlan);
      const key = `${choice}@${base.machineId}${base.accountId ? `#${base.accountId}` : ""}`;
      // Claude's, ChatGPT's or Cursor's account names itself; a coding plan's key is already its plan's name.
      const of = base.account && !coding ? ` · ${base.account}` : "";
      return [
        {
          value: `${key}/${AUTO}`,
          label: t("brain.auto.label"),
          title: `${name}${of}`,
          group,
          mark: planMark(choice),
          // Claude's, ChatGPT's and Cursor's say whose plan it is; a coding plan is the person's own key.
          description: coding ? t("brain.auto.hint") : t(`brain.${kind}Text`),
          ...(freeHint ? { hint: freeHint } : {}),
          disabled: false,
          free: false,
          keywords: searched,
          pick: { ...base, model: AUTO },
        },
        ...models.map((m) => {
          const line = brainModelLine(t, kind, coding, m, cursorSays);
          return {
            value: `${key}/${m.value}`,
            label: m.label,
            title: `${thinksWith(t, choice, m.label)}${of}`,
            group,
            mark: m.maker ?? planMark(choice),
            ...(line ? { description: line } : {}),
            ...(m.needs ? { needs: m.needs, hint: t(`brain.modelNeeds.${m.needs}`) } : {}),
            disabled: false,
            free: m.free === true,
            keywords: `${searched} ${m.maker ? providerLabel(m.maker) : ""} ${m.free ? `free ${t("brain.free")}` : ""}`,
            pick: { ...base, model: m.value },
          };
        }),
      ];
    };
    const mine = ready.filter((a) => planOfAccount(a) === choice && on.some((m) => m.machineId === a.machineId));
    if (coding) {
      const keys = mine;
      if (keys.length === 0) {
        const needs = t("newAgent.brainPick.needsKey", { plan: coding.label });
        return [
          {
            value: `connect:${choice}`,
            label: t("newAgent.brainPick.connect", { plan: coding.label }),
            title: name,
            group: name,
            mark: choice,
            description: t("newAgent.brainPick.connectText", { plan: coding.label }),
            ...(freeHint ? { hint: freeHint } : {}),
            disabled: false,
            free: false,
            keywords: "",
            pick: { kind: "connect", choice },
          },
          ...brainModelChoices(coding, []).map((m) => ({
            value: `connect:${choice}/${m.value}`,
            label: m.label,
            title: thinksWith(t, choice, m.label),
            group: name,
            mark: m.maker ?? choice,
            description: m.free ? `${t("brain.free")} · ${needs}` : needs,
            disabled: true,
            free: m.free === true,
            keywords: `${m.maker ? providerLabel(m.maker) : ""} ${m.free ? `free ${t("brain.free")}` : ""}`,
            pick: { kind: "connect" as const, choice },
          })),
        ];
      }
      return keys.flatMap((a) =>
        rows(
          { kind, choice, machineId: a.machineId, accountId: a.id, account: a.label },
          keys.length > 1 || names ? `${name} · ${a.label}` : name,
          brainModelChoices(coding, []),
        ),
      );
    }
    if (on.length === 0) {
      // Cursor (ADR 0114), OpenCode (ADR 0132), Grok (ADR 0142) and Gemini (ADR 0143) only where a computer runs
      // them; Claude's and ChatGPT's plans say why they can't.
      if (choice === "cursor" || choice === "zen" || choice === "grok" || choice === "gemini") return [];
      return [
        {
          value: `none:${choice}`,
          label: planLabel(t, choice),
          title: name,
          group: name,
          mark: planMark(choice),
          description: held
            ? t("connectAi.billing")
            : machines.length === 0
              ? t("brain.foot.noComputer")
              : t("brain.foot.unavailable"),
          disabled: true,
          free: false,
          keywords: planSearchNames(choice),
          pick: { kind: "connect", choice },
        },
      ];
    }
    const modelsOn = (machineId: string, provider?: string | null) =>
      brainModelChoices(
        undefined,
        on.find((m) => m.machineId === machineId)?.options.find((o) => o.kind === kind)?.models ?? [],
        provider,
      );
    return [
      ...on.flatMap((m) =>
        rows(
          { kind, choice, machineId: m.machineId },
          names || !m.online ? `${name} · ${m.online ? m.name : t("brain.foot.offline", { computer: m.name })}` : name,
          modelsOn(m.machineId),
        ),
      ),
      ...mine
        .map((a) => ({ ...a, label: accountTitle(a) }))
        .flatMap((a) =>
          rows(
            { kind, choice, machineId: a.machineId, accountId: a.id, account: a.label },
            names ? `${name} · ${a.label} · ${a.computer}` : `${name} · ${a.label}`,
            modelsOn(a.machineId, a.provider),
          ),
        ),
    ];
  });
  // A plan ready here thinks with its maker's models: those that would need an API key leave the list, so Claude's
  // models read as the plan's (available), not as "needs a Claude API key".
  const covered = new Set(
    plans.flatMap((o) =>
      !o.disabled && o.pick.kind !== "connect" && "choice" in o.pick ? (PLAN_PROVIDER[o.pick.choice] ?? []) : [],
    ),
  );
  const apiRows = apiPickOptions(t, locale, api).filter((o) => !(o.disabled && o.mark && covered.has(o.mark)));
  return [auto, ...apiRows, ...plans];
}

/** The option a new agent's choice shows as (undefined: one the list no longer has). */
export function brainPickValue(
  options: readonly BrainPickOption[],
  chosen:
    | { kind: "model"; model: string }
    | { kind: "connect"; choice: PlanChoice }
    | { kind: MachineAccountKind; machineId: string; accountId?: string; model?: string },
): string | undefined {
  return options.find((o) => {
    const p = o.pick;
    if (o.disabled) return false;
    if (chosen.kind === "model") return p.kind === "model" && p.model === chosen.model;
    if (chosen.kind === "connect") return p.kind === "connect" && p.choice === chosen.choice;
    return (
      p.kind === chosen.kind &&
      p.machineId === chosen.machineId &&
      (p.accountId ?? null) === (chosen.accountId ?? null) &&
      p.model === (chosen.model ?? AUTO)
    );
  })?.value;
}

/**
 * What a plan chosen for a new agent saves once it exists: its brain, the account, its model (Automático is the
 * agent's own already, carried onto the brain).
 */
export const brainPickInput = (p: {
  kind: MachineAccountKind;
  accountId?: string;
  model?: string;
}): AgentBrainInput => ({
  brain: p.kind,
  ...(p.accountId ? { account: p.accountId } : {}),
  ...(p.model && !isAuto(p.model) ? { model: p.model } : {}),
});

/**
 * A plan picked on a computer's own sign-in that thinks for nobody yet: its sign-in opens once the agent exists (web
 * and phone). Only for an agent of the person's own: only its owner signs a plan in for it.
 */
export function needsOwnSignIn(
  computers: AiAccounts["computers"] | undefined,
  p: { kind: MachineAccountKind; machineId: string; accountId?: string },
) {
  if (p.accountId) return false;
  const row = computers?.find((c) => c.machineId === p.machineId);
  return !ownSignInReady({ ownSignIn: row?.mine === true }, row, p.kind);
}

/** The list's runs of options under one heading, in order (the phone draws each as a group). */
export function pickGroups<O extends Pick<BrainPickOption, "group">>(options: readonly O[]) {
  const out: { group?: string; options: O[] }[] = [];
  for (const o of options) {
    const last = out.at(-1);
    if (last && last.group === o.group) last.options.push(o);
    else out.push({ ...(o.group ? { group: o.group } : {}), options: [o] });
  }
  return out;
}
