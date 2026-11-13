import { planState, planWindows } from "@agenteschat/ui/plan-state";
import { ago, zoneOf } from "./context";
import { defaultAccountLabel } from "./machine-accounts";
import { type AgentPlanUsageView, type ApiAgentUsage, agentUsageFor, type PlanAccountUsage } from "./plan-usage";
import { personBehindCall } from "./requester";
import { describeWhen } from "./schedule";
import type { ToolDefinition, ToolSource } from "./tools/types";

export const USAGE_TOOL = "get_my_usage";

/** The apps' English names of a plan's windows (`aiAccounts.usage.window`). */
const WINDOW_NAMES: Record<string, string> = {
  five_hour: "5 hours",
  seven_day: "Week",
  seven_day_opus: "Week · Opus",
  seven_day_sonnet: "Week · Sonnet",
  monthly: "Month",
};

/** `Claude plan "Pessoal" (Max), Ana's`; a computer's own sign-in by its maker. */
function planName(a: PlanAccountUsage) {
  const maker = defaultAccountLabel(a.kind, [], a.provider);
  const plan = a.plan ? ` (${a.plan.charAt(0).toUpperCase()}${a.plan.slice(1)})` : "";
  const whose = a.ownerName ? `, ${a.ownerName}'s` : "";
  return a.label ? `${maker} plan "${a.label}"${plan}${whose}` : `the computer's own ${maker} sign-in${plan}${whose}`;
}

/** The plan it thinks with: its windows as the apps draw them (tightest first, a reset one empty), with its part. */
function planText(a: PlanAccountUsage, agentId: string, zone: string, now: Date) {
  const head = `You think with ${planName(a)}${a.signedOut ? ", signed out on its computer" : ""}.`;
  const usage = a.usage;
  if (!usage || (usage.windows.length === 0 && !usage.limited)) {
    return `${head} Its limits aren't known yet: its computer reports them while you think.`;
  }
  const at = now.getTime();
  const when = (iso: string) => describeWhen(new Date(iso), zone, now);
  const lines = planWindows(usage, at).map((w) => {
    const name = WINDOW_NAMES[w.kind] ?? w.label ?? "Other limit";
    const resets = w.resetsAt && Date.parse(w.resetsAt) > at ? `, resets ${when(w.resetsAt)}` : "";
    // Null: a window of unknown length has no estimate.
    const part = w.used > 0 && w.agents ? (w.agents.find((p) => p.agentId === agentId)?.percent ?? 0) : null;
    return `- ${name}: ${w.used}% used${resets}.${part === null ? "" : ` Your part: about ${part}%.`}`;
  });
  const { state, until } = planState(usage, at);
  return [
    head,
    lines.length > 0
      ? `Its limits, shared by everyone who thinks with it (your part is an estimate), as its computer reported them ${ago(new Date(usage.at), at)}:\n${lines.join("\n")}`
      : "",
    state === "limited"
      ? `At the limit${until ? ` until ${when(until)}` : " now"}.`
      : state === "almost"
        ? "Almost at the limit."
        : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** This month's tokens, plans and API apart. */
function tokensText(view: AgentPlanUsageView) {
  const plan = view.sources.filter((s) => s.type === "plan").reduce((n, s) => n + s.tokens, 0);
  const api = view.tokens - plan;
  const split =
    plan > 0 && api > 0
      ? ` (${plan.toLocaleString("en-US")} on plans, ${api.toLocaleString("en-US")} through the API)`
      : plan > 0
        ? " (all on plans)"
        : api > 0
          ? " (all through the API)"
          : "";
  return `Tokens this month (UTC): ${view.tokens.toLocaleString("en-US")}${split}.`;
}

function budgetText(api: ApiAgentUsage, zone: string, now: Date) {
  const resets = describeWhen(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)), zone, now);
  return `API budget this month: ${api.budgetPercent}% used. It resets ${resets}.`;
}

/**
 * `get_my_usage`: the agent's own usage as its page's Uso tab shows it (ADR 0063 §6): the windows of the plan it
 * thinks with and its part of each, its tokens this month, and how much of its API budget it used where it thinks
 * through the API (always on the model brain, on a plan once it spent through the API this month). Never another
 * agent's numbers, an account's email or money, whoever asks: the result stays in the run, whose steps the agent's
 * owner reads without `view_usage`, and the answer may go to a channel where not everyone may see costs.
 */
export function createUsageToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: USAGE_TOOL,
    description:
      "Your own usage: the limits of the AI plan you think with (5 hours, week, month: how much is used, your part and when each resets), your tokens this month, and how much of your API budget you used. Call it whenever someone asks about your limits, usage, quota, tokens or what you cost, instead of guessing or saying you can't check.",
    scope: "",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, ctx) {
      const now = new Date();
      const person = await personBehindCall(ctx);
      const [{ view, brain, api }, zone] = await Promise.all([
        agentUsageFor(ctx.db, null, ctx.orgId, ctx.agentId, now),
        zoneOf(ctx.db, ctx.orgId, person),
      ]);
      const onApi = brain === "model";
      const parts = [
        view.current
          ? planText(view.current, ctx.agentId, zone, now)
          : onApi
            ? "You think through the API (a key, not a plan): no plan limits, only your monthly budget."
            : "No plan thinks for you right now.",
        tokensText(view),
        api && (onApi || view.sources.some((s) => s.type === "api")) ? budgetText(api, zone, now) : "",
        "People see the same on your page's Usage tab and in Settings › Budget and usage (in Portuguese, Uso and Configurações › Orçamento e uso). Amounts in US$ are there too, for people allowed to see the workspace's costs, never here.",
      ];
      return { content: parts.filter(Boolean).join("\n\n") };
    },
  };
  return { name: "usage", tools: async () => [tool] };
}
