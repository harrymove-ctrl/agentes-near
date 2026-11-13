import {
  CODING_PLANS,
  type CodingPlan,
  claudeCodeModel,
  GEMINI_ENTERPRISE_PROVIDER,
  type PlanModel,
  planModel,
  planModelValue,
  planOf,
} from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";
import type { AgentBrain } from "../api/types";
import { agentGrammar } from "./grammar";
import { isAuto } from "./providers";

export * from "@agenteschat/providers/plans";

export interface BrainModelChoice extends Pick<PlanModel, "label" | "tag" | "needs" | "free" | "maker"> {
  value: string;
  /** Cursor: its CLI said the person's plan includes it (the others cost API prices there). */
  inPlan?: boolean;
}

const planChoice = (m: PlanModel, value: string): BrainModelChoice => ({
  value,
  label: m.label,
  ...(m.tag ? { tag: m.tag } : {}),
  ...(m.needs ? { needs: m.needs } : {}),
  ...(m.free ? { free: m.free } : {}),
  ...(m.maker ? { maker: m.maker } : {}),
});

/** How OpenCode's CLI names a model of the Go plan, which an OpenCode key runs (`OPENCODE_API_KEY`, as models.dev says). */
export const opencodeGoModel = (id: string) => `opencode-go/${id}`;

/**
 * A computer brain's model choices (web and phone): every model of the account's coding plan, each by its alias
 * where it has one (`planModelValue`), else the brain's own (`models`: Claude's aliases, Codex's, what the computer's
 * CLI lists). An OpenCode key (`provider` `zen`) adds OpenCode Go's models: the computer lists its CLI's models with
 * no key, OpenCode's free tier alone, so a Go model a key pays for would never show.
 */
export function brainModelChoices(
  plan: CodingPlan | undefined,
  models: readonly { value: string; label: string; inPlan?: boolean; free?: boolean }[],
  provider?: string | null,
): BrainModelChoice[] {
  if (plan) return plan.claudeCode.models.map((m) => planChoice(m, planModelValue(m)));
  const own = models.map(({ value, label, inPlan, free }) => ({
    value,
    label,
    ...(inPlan ? { inPlan } : {}),
    ...(free ? { free } : {}),
  }));
  if (provider !== "zen") return own;
  const go = (planOf("opencode")?.claudeCode.models ?? []).map((m) => planChoice(m, opencodeGoModel(m.id)));
  return [...own, ...go.filter((m) => !own.some((o) => o.value === m.value))];
}

/**
 * Under OpenCode Go's models (web and phone): Go's key thinks through Claude Code, where OpenCode's free tier
 * (`glm-5.3-flash-free`…) never answers, so its free models show only on the OpenCode brain (ADR 0132 §7).
 */
export const planFreeHint = (t: TFunction, plan: CodingPlan | undefined) =>
  plan?.name === CODING_PLANS.opencode.name ? t("brain.opencodeFreeHint") : undefined;

/**
 * The choice a stored model shows as: on a plan, the model it runs there (an alias the plan leaves out or another
 * plan's model: `sonnet`'s); on Claude, another plan's model as Sonnet; `auto` and Codex's as stored.
 */
export function brainModelChoice(kind: string, plan: CodingPlan | undefined, value: string): string {
  if (kind !== "claude_code" || isAuto(value)) return value;
  return plan ? planModelValue(planModel(plan, value)) : claudeCodeModel(undefined, value);
}

/** The plan of an account (its `provider`), or none for the CLI's own sign-in. */
export const accountPlan = (account: { provider: string | null } | null | undefined) => planOf(account?.provider);

/** The plan of the account an agent thinks with, which names its models. */
export const brainPlan = (view: Pick<AgentBrain, "account" | "accounts">) =>
  accountPlan(view.accounts.find((a) => a.id === view.account));

/** The plan as the CLI says it (`team`, `max`), as a name ("Team"). */
/**
 * A Cursor account made with its API key instead of a sign-in (ADR 0114): the key step as a coding plan's, the key
 * made in Cursor's dashboard. Not a coding plan: Cursor's CLI thinks with it, never Claude Code.
 */
export const CURSOR_KEY_PLAN: Pick<CodingPlan, "label" | "name" | "maker" | "site" | "keyPattern" | "placeholder"> = {
  label: "Cursor",
  name: "Cursor API key",
  maker: "Cursor",
  site: "https://cursor.com/dashboard?tab=integrations",
  keyPattern: "^[\\x21-\\x7e]{16,512}$",
  placeholder: "key_",
};

/**
 * An OpenCode account (ADR 0132): its key is its only sign-in, made in OpenCode's console. Without one the agent
 * still thinks on OpenCode's free tier with the computer's own CLI.
 */
export const OPENCODE_KEY_PLAN: Pick<CodingPlan, "label" | "name" | "maker" | "site" | "keyPattern" | "placeholder"> = {
  label: "OpenCode",
  name: "OpenCode API key",
  maker: "OpenCode",
  site: "https://opencode.ai/console",
  keyPattern: "^[\\x21-\\x7e]{16,512}$",
  placeholder: "oc_sk_",
};

/**
 * The key step an account sign-in shows, if any: a coding plan's (its `provider`), Cursor's API key when chosen
 * under Cursor's sign-in, or OpenCode's, its only one; and the `provider` the sign-in starts with.
 */
export function signInKey(provider: string | undefined, kind: string, cursorKey: boolean) {
  const coding = planOf(provider);
  if (coding) return { plan: coding as typeof CURSOR_KEY_PLAN, provider };
  if (kind === "opencode") return { plan: OPENCODE_KEY_PLAN, provider: "zen" };
  return kind === "cursor" && cursorKey
    ? { plan: CURSOR_KEY_PLAN, provider: "cursor" }
    : { plan: undefined, provider: undefined };
}

/**
 * A Gemini plan chosen on a personal Google account, or with no account yet (ADR 0143): Google's warning about other
 * apps shows plainly there, on the web and the phone. A Gemini Enterprise seat has only the usual note.
 */
export const geminiPersonal = (account: { provider?: string | null } | undefined) =>
  account?.provider !== GEMINI_ENTERPRISE_PROVIDER;

export const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

/** Team and enterprise seats are one person's each, not a personal subscription. */
const SEATS = new Set(["team", "enterprise"]);

/**
 * What "Atende outras pessoas" on a plan says (ADR 0059 §5), web and phone: the line under the switch, whom the agent
 * answers in that state and on which plan (`agent` null: every agent of a plan's panel), and for the line's ⓘ (named
 * `about`) what the plan's terms say, in a coding plan's maker's words (`coding`), a seat's, else a personal plan's.
 */
export function planReplies(
  t: TFunction,
  {
    on,
    agent,
    owner,
    brain,
    plan,
    coding,
  }: {
    on: boolean;
    agent: string | null;
    /** The plan's owner, to anyone else (an admin): "pelo plano do Claude de Walter". Absent: the viewer's own. */
    owner?: string;
    brain: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
    /** The account's plan as the CLI says it (`max`, `team`…): a seat has its own words. */
    plan?: string | null;
    coding?: CodingPlan;
  },
) {
  const provider = t(`aiAccounts.connect.${brain}`);
  const seat = SEATS.has(plan?.toLowerCase() ?? "");
  const which = coding
    ? t("aiAccounts.share.plan.coding", { label: coding.label })
    : t(seat ? "aiAccounts.share.plan.seat" : "aiAccounts.share.plan.own", { provider });
  return {
    line:
      agent === null
        ? t(on ? "aiAccounts.share.line.onAll" : "aiAccounts.share.line.offAll", { plan: which })
        : owner
          ? t(on ? "aiAccounts.share.lineOf.on" : "aiAccounts.share.lineOf.off", {
              ...agentGrammar(agent),
              plan: which,
              owner,
            })
          : t(on ? "aiAccounts.share.line.on" : "aiAccounts.share.line.off", { ...agentGrammar(agent), plan: which }),
    about: t("common.about", { label: t("aiAccounts.share.terms.about") }),
    text: coding
      ? t("aiAccounts.share.terms.other", { maker: coding.maker })
      : t(seat ? "aiAccounts.share.terms.seat" : "aiAccounts.share.terms.own", { provider }),
  };
}
