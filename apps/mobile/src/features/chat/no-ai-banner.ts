import type { AiStatus, Message } from "@agenteschat/client";
import { aiStateOf, noAiCardOf } from "@agenteschat/client/lib/no-ai";

/**
 * Which "no AI" banner the box shows, as the web's `NoAiBanner` (ADR 0061): in an agent's DM, that agent
 * without an AI; anywhere with agents, the whole workspace without one. `agentId`: the agent Conectar opens
 * for (the only one there). `askInChat`: the chat understands "use my Claude plan" too, only where Jev reads
 * the message (`ai-intent.ts`). Nothing while the status loads, or right under the agent's own no-AI card.
 */
export type NoAiBannerView = { kind: "agent"; agentId: string } | { kind: "org"; agentId?: string; askInChat?: true };

export function noAiBanner(
  status: AiStatus | undefined,
  where: { agentIds: readonly string[]; dmAgentId: string | null; cardShown: boolean },
): NoAiBannerView | null {
  if (!status || where.cardShown) return null;
  if (where.dmAgentId)
    return aiStateOf(status, where.dmAgentId) === "no_ai" ? { kind: "agent", agentId: where.dmAgentId } : null;
  if (status.any || where.agentIds.length === 0) return null;
  const only = where.agentIds.length === 1 ? where.agentIds[0] : undefined;
  return {
    kind: "org",
    ...(only ? { agentId: only } : {}),
    ...(status.routing?.by === "jev" ? { askInChat: true as const } : {}),
  };
}

/** The conversation ends on an agent's no-AI card (`meta.noAi`): the banner would repeat it right below. */
export function endsOnNoAiCard(messages: readonly Message[]): boolean {
  const last = messages.at(-1);
  return Boolean(last && last.author.type === "agent" && noAiCardOf(last.meta));
}
