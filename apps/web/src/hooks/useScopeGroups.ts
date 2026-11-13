import { useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import { type ScopeGroup, scopeGroups } from "@agenteschat/client/lib/scopes";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/** Built-in scopes, one group per active connection, then the reviewed custom MCP servers. */
export function useScopeGroups(orgId: string): ScopeGroup[] | undefined {
  const { t } = useTranslation();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const custom = useCustomServers(orgId);
  return useMemo(
    () =>
      catalog.data && connections.data
        ? scopeGroups(
            t,
            catalog.data,
            connections.data,
            { name: t("agent.builtinName"), note: t("agent.builtinNote") },
            custom.data ?? [],
          )
        : undefined,
    [catalog.data, connections.data, custom.data, t],
  );
}
