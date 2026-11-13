import { createContext, type ReactNode, useContext } from "react";
import type { AuthClient } from "./client";

const AuthContext = createContext<AuthClient | null>(null);

export function AuthProvider({ client, children }: { client: AuthClient; children: ReactNode }) {
  return <AuthContext.Provider value={client}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthClient {
  const client = useContext(AuthContext);
  if (!client) throw new Error("useAuth must be used inside AuthProvider");
  return client;
}
