import type { Level } from "@agenteschat/client/lib/access-levels";
import { ROLE_DEFAULTS, ROLE_IDS, type RoleId } from "@agenteschat/client/lib/new-agent";
import type { AgentAppearance, IconName } from "@agenteschat/ui";

export * from "@agenteschat/client/lib/new-agent";

/**
 * "Criar agente" in steps: each role's icon on the web (what it starts with is shared:
 * `@agenteschat/client/lib/new-agent`).
 */

export interface RolePreset {
  icon: IconName;
  look: Required<AgentAppearance>;
  /** Levels by catalog connector id ("github"); connectors not listed start at "Sem acesso". */
  levels: Record<string, Level>;
  /** Channels it joins when the workspace has them (by name; only channels you're in). */
  channels: string[];
}

const ROLE_ICON: Record<RoleId, IconName> = {
  dev: "code",
  ops: "bolt",
  qa: "checks",
  pm: "issues",
  support: "message",
  sales: "coin",
  marketing: "globe",
  content: "edit",
  data: "chart",
  finance: "wallet",
  people: "members",
  research: "search",
  assistant: "calendar",
  custom: "plus",
};

/** Picking a role fills the rest (name and instructions come from i18n: `newAgent.roles.{id}`). */
export const ROLE_PRESETS = Object.fromEntries(
  ROLE_IDS.map((id) => [id, { ...ROLE_DEFAULTS[id], icon: ROLE_ICON[id] }]),
) as Record<RoleId, RolePreset>;
