import {
  type Agent,
  type AgentAccess,
  keys,
  useApi,
  useCatalog,
  useConnections,
  useCustomServers,
  useMembers,
} from "@agenteschat/client";
import { type AccessResource, type Level, saveLevels } from "@agenteschat/client/lib/access-levels";
import { type ConnectedItem, connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { isSolo, othersHere } from "@agenteschat/client/lib/personal-view";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useOrg } from "@/providers/org";
import { useMeId, useOrgId } from "../shared/hooks";
import { stepAt } from "./logic";

/** The web's settings hooks (`AccessLevels.tsx`, `useAgentsAccess`), on the phone. */

/**
 * A personal workspace's view (ADR 0159): whether it is personal, how many other people are members (undefined while
 * the list loads) and `solo`, personal with nobody else in it yet. A control leaves the screen while solo only when it
 * still holds its default, and while the list loads the full control shows, so nothing hides and then comes back for
 * a family member. Read it for what is in sight, never to refuse anything.
 */
export function usePersonalView() {
  const { orgId, org } = useOrg();
  const members = useMembers(orgId).data;
  const meId = useMeId();
  const others = members && meId ? othersHere(members, meId) : undefined;
  return { personal: isPersonal(org), others, solo: isSolo(org, others) };
}

type TT = (key: string, options: { defaultValue: string }) => string;

/**
 * Every agent's access tree, one query per agent (the same cache as the agent's page): Acesso's levels.
 * `unavailable`: the server has no access API (404).
 */
export function useAgentsAccess(agents: Agent[], enabled = true) {
  const api = useApi();
  const orgId = useOrgId();
  const queries = useQueries({
    queries: agents.map((a) => ({
      queryKey: keys.agentAccess(orgId, a.id),
      queryFn: () => api.access.get(orgId, a.id),
      enabled,
      retry: false,
    })),
  });
  const byAgent = new Map<string, AgentAccess>();
  queries.forEach((q, i) => {
    const a = agents[i];
    if (a && q.data) byAgent.set(a.id, q.data);
  });
  return {
    byAgent,
    loading: queries.some((q) => q.isLoading),
    unavailable: queries.some((q) => (q.error as { status?: number } | null)?.status === 404),
  };
}

/** The connected services by connection id (their names and marks). */
export function useConnectedById() {
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  return useMemo(
    () =>
      new Map(
        connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).map((i) => [
          i.id,
          i,
        ]),
      ),
    [connections.data, servers.data, catalog.data],
  );
}

/** A resource's name in the app's language: the service's name, or the built-in area's. */
export function resourceName(t: TFunction, r: AccessResource, items: Map<string, ConnectedItem>) {
  if (r.connectionId) {
    const item = items.get(r.connectionId);
    return item ? itemName(t, item) : r.label;
  }
  return (t as unknown as TT)(`access.area.${r.area}`, { defaultValue: r.label });
}

/** Saves levels for one agent (its grants read fresh, one write) and refreshes the shared cache. */
export function useSetLevels() {
  const api = useApi();
  const orgId = useOrgId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, changes }: { agentId: string; changes: Record<string, Level> }) =>
      saveLevels(api, orgId, agentId, changes),
    onSuccess: (saved, { agentId }) => {
      qc.setQueryData(keys.agentAccess(orgId, agentId), saved);
      void qc.invalidateQueries({ queryKey: keys.scopes(orgId, agentId) });
    },
  });
}

/** A long action's line while it runs ("Baixando a skill…" → "Lendo os arquivos…"); undefined otherwise. */
export function useStepText(active: boolean, steps: string[]): string | undefined {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setSince(null);
      return;
    }
    const start = Date.now();
    setSince(start);
    setNow(start);
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  if (!active || since === null || steps.length === 0) return undefined;
  return steps[stepAt(since, now, steps.length)];
}
