import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useConnection, useOrgId } from "../shared/hooks";
import { isVaultChanged, vaultQueryRoot } from "./logic";

/**
 * Someone changed the Vault (ADR 0144: an item, its access, a connection or a sync): the org event carries nothing
 * but its name, so every Vault screen refetches what this person may see. Mounted once with the app's stack; a
 * reconnect refetches everything already.
 */
export function useVaultEvents() {
  const connection = useConnection();
  const orgId = useOrgId();
  const qc = useQueryClient();
  useEffect(() => {
    if (!connection) return;
    return connection.onUserEvent((event) => {
      if (isVaultChanged(event)) void qc.invalidateQueries({ queryKey: vaultQueryRoot(orgId) });
    });
  }, [connection, orgId, qc]);
}
