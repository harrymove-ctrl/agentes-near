import { createContext, type ReactNode, useContext } from "react";

/**
 * The request a push, the inbox or a deep link opened this conversation for (`/chat/<id>?handoff=<id>`):
 * its card opens in place and takes the control, instead of a separate screen.
 */
const OpenHandoff = createContext<string | null>(null);

export function OpenHandoffProvider({ handoffId, children }: { handoffId: string | null; children: ReactNode }) {
  return <OpenHandoff.Provider value={handoffId}>{children}</OpenHandoff.Provider>;
}

export const useOpenHandoffId = () => useContext(OpenHandoff);
