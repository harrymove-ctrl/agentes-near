import { type ApiClient, keys, useApi, useWifiPairState } from "@agenteschat/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgId } from "../shared/hooks";

/**
 * The devices list (`GET …/devices`) and its changes. `devices.changed` refetches `machines`, which holds this key,
 * so the list stays live; `pollMs` adds a refetch while a screen waits on a computer (a phone being plugged in).
 */
export function useDevices(pollMs: number | false = false) {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: keys.devices(orgId),
    queryFn: () => api.devices.list(orgId),
    retry: false,
    refetchInterval: pollMs,
    meta: { quiet: true },
  });
}

/** One change to a device or a request; the devices (and the computers) refetch after it, done or not. */
export function useDeviceMutation<V, R = unknown>(run: (api: ApiClient, orgId: string, input: V) => Promise<R>) {
  const api = useApi();
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useMutation({
    mutationFn: (input: V) => run(api, orgId, input),
    meta: { silent: true },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.machines(orgId) }),
  });
}

/** A connect link's state, asked every 2 s while the computer hasn't joined, been denied or run out of time. */
export function useConnectLink(linkId: string | null) {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: keys.connectLink(orgId, linkId ?? ""),
    queryFn: () => api.devices.link(orgId, linkId ?? ""),
    enabled: Boolean(linkId),
    retry: false,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === undefined || s === "waiting" || s === "asking" ? 2000 : false;
    },
    meta: { quiet: true },
  });
}

/** Pairing this phone with `machineId` the six-digit way: the code and the address Wireless debugging shows. */
export function useWifiPairCode(machineId: string | null) {
  const api = useApi();
  const orgId = useOrgId();
  const start = useMutation({
    mutationFn: ({ on, ...input }: { on: string; address: string; code: string }) =>
      api.devices.startWifiPairing(orgId, on, input),
    meta: { silent: true },
  });
  // A code sent to the computer picked before isn't this one's.
  const sent = start.variables?.on === machineId;
  return {
    pairing: useWifiPairState(orgId, machineId, sent ? start.data : undefined),
    pending: sent && start.isPending,
    error: sent ? start.error : null,
    pair: (input: { address: string; code: string }) => {
      if (machineId) start.mutate({ ...input, on: machineId });
    },
  };
}
