import type { Me, OrgSummary } from "@agenteschat/client";
import { createContext, type ReactNode, useContext, useMemo } from "react";

interface OrgContextValue {
  org: OrgSummary;
  me: Me;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ org, me, children }: OrgContextValue & { children: ReactNode }) {
  // Stable across the layout's re-renders (every navigation): every row and avatar reads it.
  const value = useMemo(() => ({ org, me }), [org, me]);
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

/** The current organization and the signed-in person, inside `/org/$orgId/*`. */
export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (!value) throw new Error("useOrg must be used inside an organization route");
  return value;
}
