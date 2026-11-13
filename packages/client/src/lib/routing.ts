import type { TFunction } from "i18next";
import type { AiRouting, AiStatus, DecidedBy } from "../api/types";
import type { ReceiptView } from "../realtime/receipts";
import { agentGrammar } from "./grammar";
import { providerLabel } from "./providers";

/**
 * Whether something reads this person's messages that mention nobody (Jev, a small model, or their own plan), so an
 * agent set to answer on its own can join in (ADR 0074). An older server says nothing: as before, yes.
 */
export const picksForMe = (routing: AiRouting | undefined) =>
  !routing || routing.mine === "jev" || routing.mine === "model" || routing.mine === "plan";

/** What "On its own" means for this person's messages: the topic, only replies and follow-ups, or only mentions. */
export const replyAloneKey = (routing: AiRouting | undefined) =>
  picksForMe(routing)
    ? "channelMembers.replyAloneHelp"
    : routing?.mine === "off"
      ? "channelMembers.replyAloneOff"
      : "channelMembers.replyAloneRules";

/**
 * The line on who picks the agents now, by `ai-status`: its key and words. Null while it loads, in a workspace with
 * no AI, and for a small model the catalog can't name.
 */
export function routingLineOf(status: AiStatus | undefined, modelLabel: (id: string) => string | null) {
  const routing = status?.any ? status.routing : undefined;
  if (!routing) return null;
  if (routing.by === "model") {
    const model = routing.model ? modelLabel(routing.model) : null;
    return model ? { key: "routing.by.model" as const, params: { model } } : null;
  }
  if (routing.by === "rules" && routing.noSmallModel)
    return { key: "routing.by.noSmall" as const, params: { provider: providerLabel(routing.noSmallModel) } };
  return { key: `routing.by.${routing.by}` as const, params: {} };
}

/** Why the agent was picked, as the receipt's last line: the rule it followed (ADR 0074). */
export interface Decider {
  rule: Exclude<Extract<DecidedBy, { step: "rule" }>["rule"], "coordinator" | "alone">;
  text: string;
}

/**
 * The receipt's last line, once a rule picked an agent ("Uma resposta para a Ada"). Null when an AI picked (Jev, a
 * small model, a plan: which one means nothing to most people, the decision stays stored), for `alone` (a person with
 * nobody else here: the reason adds nothing for them, it stays stored), for a decision for nobody (the line under the
 * message says it) and one made before the server said who decided.
 */
export function deciderOf(t: TFunction, view: ReceiptView, names: { agent: (id: string) => string }): Decider | null {
  const by = view.decidedBy;
  const status = view.status;
  const first =
    status && status.kind !== "nobody" && status.kind !== "no_ai" && status.kind !== "platform_cap"
      ? status.agents[0]
      : undefined;
  if (by?.step !== "rule" || by.rule === "alone" || first === undefined) return null;
  // A coordinator's pick (before ADR 0137) reads as the default it was.
  const rule = by.rule === "coordinator" ? "default" : by.rule;
  return { rule, text: t(`receipts.by.${rule}`, agentGrammar(names.agent(first))) };
}
