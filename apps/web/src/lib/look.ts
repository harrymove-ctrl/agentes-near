import { BLANK_LOOK } from "@agenteschat/client/lib/new-agent";
import { type AgentAppearance, normalizeAppearance } from "@agenteschat/ui";

/** An agent's look for `<Avatar appearance>` (unknown values fall back to the default). */
export const lookOf = (agent: { appearance?: unknown } | undefined | null): AgentAppearance | undefined =>
  agent?.appearance ? normalizeAppearance(agent.appearance) : undefined;

/** Every part of a look, the blank one's where it has none (the editors need all three). */
export const fullLook = (a: AgentAppearance | undefined): Required<AgentAppearance> => ({
  color: a?.color ?? BLANK_LOOK.color,
  eyes: a?.eyes ?? BLANK_LOOK.eyes,
  accessory: a?.accessory ?? BLANK_LOOK.accessory,
});
