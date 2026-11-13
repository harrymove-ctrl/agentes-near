import { createRequester, enc, keys, type RequestOptions } from "@agenteschat/client";
import type { MoveTarget } from "@agenteschat/client/lib/machine-outages";
import { visibleOutages } from "@agenteschat/client/lib/machine-outages";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { appHeaders, readCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { useOrgId } from "../shared/hooks";
import { type MachineOutages, type MoveAgentsResult, OUTAGES_POLL_MS } from "./logic";

/*
 * Mobile-local hooks for the offline-computer endpoints. The shared client (`@agenteschat/client`) gets
 * `useMachineOutages` / `useMoveAgents` from the web's work; once both are on main these become thin
 * re-exports (same query key, so nothing else changes).
 */

const request = <T>(path: string, options?: RequestOptions) =>
  createRequester({ baseUrl: serverUrl(), headers: async () => appHeaders(await readCookie()) })<T>(path, options);
const org = (orgId: string) => `/api/app/organizations/${enc(orgId)}`;

/** Under `keys.machines(orgId)`, so whatever refreshes the computers refreshes this too. */
export const outagesKey = (orgId: string) => [...keys.machines(orgId), "outages"] as const;

/**
 * The computers that went offline with agents waiting for them, and where those agents can go. Asked again
 * every 30 s while one shows and whenever the app comes back to the foreground. A person who can't manage
 * the agents gets an error from the server: nothing shows.
 */
export function useMachineOutages() {
  const orgId = useOrgId();
  const q = useQuery({
    queryKey: outagesKey(orgId),
    queryFn: () => request<MachineOutages>(`${org(orgId)}/machines/outages`),
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => (visibleOutages(query.state.data?.outages).length > 0 ? OUTAGES_POLL_MS : false),
  });
  const outages = useMemo(() => visibleOutages(q.data?.outages), [q.data]);
  return { ...q, outages, targets: q.data?.targets ?? [] };
}

/** "Trocar computador": moves the chosen agents off the offline computer. */
export function useMoveAgents() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { machineId: string; agentIds: string[]; target: MoveTarget }) =>
      request<MoveAgentsResult>(`${org(orgId)}/machines/${enc(input.machineId)}/move-agents`, {
        json: { agentIds: input.agentIds, target: input.target },
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
      void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      void qc.invalidateQueries({ queryKey: keys.working(orgId) });
    },
  });
}
