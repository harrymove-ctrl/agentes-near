import type { AgentAudience, AgentSetupStep } from "@agenteschat/client";

/**
 * A new agent's checklist steps as the person sees them (ADR 0159): alone in a personal workspace (`solo`), "Who talks
 * to it" leaves the card while the agent's audience still holds a default (everyone, or only its owner: either way just
 * the person, alone), so nothing asks who else may talk to an agent when nobody else is here. Picked people keep the
 * step in sight. Only the view: who may talk to the agent doesn't change, and its own screen still opens. Pure.
 */
export const setupStepsInSight = (
  steps: readonly AgentSetupStep[],
  audience: Pick<AgentAudience, "mode">,
  solo: boolean,
): AgentSetupStep[] => (solo && audience.mode !== "people" ? steps.filter((s) => s !== "who") : [...steps]);
