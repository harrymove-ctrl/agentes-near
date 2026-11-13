import type { OrgSummary } from "@agenteschat/client";
import { createContext, type ReactNode, useContext } from "react";
import { useOrgMaybe } from "@/providers/org";

/**
 * The workspace the AI panels connect for: the one chosen in the app, or, in the first run (before one is chosen),
 * the one just created there (`AiOrgProvider`).
 */
export interface AiOrg {
  orgId: string;
  org: OrgSummary | null;
}

const AiOrgContext = createContext<AiOrg | null>(null);

export function AiOrgProvider({ value, children }: { value: AiOrg; children: ReactNode }) {
  return <AiOrgContext.Provider value={value}>{children}</AiOrgContext.Provider>;
}

export function useAiOrg(): AiOrg {
  const given = useContext(AiOrgContext);
  const chosen = useOrgMaybe();
  return given ?? { orgId: chosen?.orgId ?? "", org: chosen?.org ?? null };
}
