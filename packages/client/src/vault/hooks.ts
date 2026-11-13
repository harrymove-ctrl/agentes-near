import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../api/client";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type {
  SecretToVaultInput,
  VaultConnectInput,
  VaultConnectionPatch,
  VaultItemDetail,
  VaultItemInput,
  VaultItemPatch,
  VaultScope,
} from "./types";

/*
 * The Vault in the apps (ADR 0144). What a person types here (a password, a key, a passwords file, a password
 * manager's credentials) never goes into the query cache, and every mutation that carries one is forgotten as soon
 * as nothing watches it (`gcTime: 0`). Nothing here ever brings a saved value back: no answer has one (§2).
 */

/** The client's Vault, or an error on a client without one (an older fake). */
function vaultOf(api: ApiClient): NonNullable<ApiClient["vault"]> {
  if (!api.vault) throw new Error("This server has no Vault");
  return api.vault;
}

/** After a change: everything of the Vault this person may see refetches (the overview and the open item). */
function useVaultRefresh(orgId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: keys.vault(orgId) });
}

/** The Vault as this person sees it: their personal items, the team ones shared with them, the connections. */
export function useVault(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.vaultOverview(orgId),
    queryFn: () => vaultOf(api).overview(orgId),
    enabled: enabled && Boolean(orgId) && Boolean(api.vault),
  });
}

/** One item with its recent uses; none while `itemId` is empty. */
export function useVaultItem(orgId: string, itemId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.vaultItem(orgId, itemId ?? ""),
    queryFn: () => vaultOf(api).item(orgId, itemId ?? ""),
    enabled: Boolean(orgId) && Boolean(itemId) && Boolean(api.vault),
  });
}

export function useCreateVaultItem(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (input: VaultItemInput) => vaultOf(api).create(orgId, input),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}

export function useUpdateVaultItem(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: ({ itemId, ...patch }: VaultItemPatch & { itemId: string }) =>
      vaultOf(api).update(orgId, itemId, patch),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: (item) => {
      // The open item shows the change at once; its uses come with the refetch.
      qc.setQueryData<VaultItemDetail>(keys.vaultItem(orgId, item.id), (open) => (open ? { ...open, ...item } : open));
      void refresh();
    },
  });
}

export function useDeleteVaultItem(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (itemId: string) => vaultOf(api).remove(orgId, itemId),
    meta: { silent: true },
    onSuccess: (_done, itemId) => {
      // Gone: never asked again (it would answer 404).
      qc.removeQueries({ queryKey: keys.vaultItem(orgId, itemId) });
      void refresh();
    },
  });
}

/** A passwords file: `dryRun` counts what would happen, then the same call without it imports. */
export function useImportVault(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (input: { csv: string; scope: VaultScope; dryRun: boolean }) => vaultOf(api).importCsv(orgId, input),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: (_result, { dryRun }) => {
      if (!dryRun) void refresh();
    },
  });
}

export function useConnectVault(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (input: VaultConnectInput) => vaultOf(api).connect(orgId, input),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}

/** Default access, or new credentials (reconnect). */
export function useUpdateVaultConnection(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: ({ connectionId, ...patch }: VaultConnectionPatch & { connectionId: string }) =>
      vaultOf(api).updateConnection(orgId, connectionId, patch),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}

/** "Sync now". */
export function useSyncVaultConnection(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (connectionId: string) => vaultOf(api).syncConnection(orgId, connectionId),
    meta: { silent: true },
    onSuccess: () => void refresh(),
  });
}

export function useDeleteVaultConnection(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (connectionId: string) => vaultOf(api).removeConnection(orgId, connectionId),
    meta: { silent: true },
    onSuccess: () => void refresh(),
  });
}

/** "Save to the Vault" on a secret request's card, after the value was delivered. */
export function useSaveSecretToVault(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: ({ requestId, ...input }: SecretToVaultInput & { requestId: string }) => {
      if (!api.secrets.saveToVault) throw new Error("This server has no Vault");
      return api.secrets.saveToVault(orgId, requestId, input);
    },
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}
