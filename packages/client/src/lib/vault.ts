import type { VaultAccess } from "../vault/types";

/** No agent may use it: neither all of them nor any one picked. */
export const vaultNoAgents = (access: Pick<VaultAccess, "allAgents" | "agentIds">) =>
  !access.allAgents && access.agentIds.length === 0;
