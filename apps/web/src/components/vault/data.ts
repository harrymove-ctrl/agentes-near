import type {
  VaultConnectInput,
  VaultConnection,
  VaultConnectionPatch,
  VaultImportResult,
  VaultItem,
  VaultItemInput,
  VaultItemPatch,
  VaultScope,
} from "@agenteschat/client";
import {
  useConnectVault,
  useCreateVaultItem,
  useDeleteVaultConnection,
  useDeleteVaultItem,
  useImportVault,
  useSyncVaultConnection,
  useUpdateVaultConnection,
  useUpdateVaultItem,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";

/*
 * The Vault's writes as the web's screens call them (ADR 0144), in one place: each resolves to its result, or to
 * null when it failed. The hooks are silent (`meta: { silent: true }`), so the app's own toast never says why: a
 * failure is said here, in a toast in the person's words, or by the caller's `onError` (a form that says it in place).
 * The hooks invalidate the Vault's queries themselves.
 */

type OnError = (error: unknown) => void;

/** Runs a write; a failure goes to `onError` and resolves to null. */
async function attempt<T>(run: () => Promise<T>, onError: OnError): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    onError(error);
    return null;
  }
}

/** A failed write as a toast, in the words the app's own toast would use. */
function useErrorToast(): OnError {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  return (error) => toast.show(errorText(t, error, i18n.language), "error");
}

export function useVaultItemActions(orgId: string) {
  const failed = useErrorToast();
  const create = useCreateVaultItem(orgId);
  const update = useUpdateVaultItem(orgId);
  const remove = useDeleteVaultItem(orgId);
  return {
    create: (input: VaultItemInput): Promise<VaultItem | null> => attempt(() => create.mutateAsync(input), failed),
    update: (itemId: string, patch: VaultItemPatch): Promise<VaultItem | null> =>
      attempt(() => update.mutateAsync({ ...patch, itemId }), failed),
    remove: async (itemId: string): Promise<boolean> =>
      (await attempt(async () => {
        await remove.mutateAsync(itemId);
        return true;
      }, failed)) === true,
    creating: create.isPending,
    updating: update.isPending,
    removing: remove.isPending,
  };
}

export function useVaultImport(orgId: string) {
  const failed = useErrorToast();
  const run = useImportVault(orgId);
  return {
    run: (input: { csv: string; scope: VaultScope; dryRun: boolean }): Promise<VaultImportResult | null> =>
      attempt(() => run.mutateAsync(input), failed),
    busy: run.isPending,
  };
}

/** `onError`: says a failure in place instead of the toast (the connect form, under its fields). */
export function useVaultConnectionActions(orgId: string, onError?: OnError) {
  const toast = useErrorToast();
  const failed = onError ?? toast;
  const connect = useConnectVault(orgId);
  const update = useUpdateVaultConnection(orgId);
  const sync = useSyncVaultConnection(orgId);
  const remove = useDeleteVaultConnection(orgId);
  return {
    connect: (input: VaultConnectInput): Promise<VaultConnection | null> =>
      attempt(() => connect.mutateAsync(input), failed),
    update: (connectionId: string, patch: VaultConnectionPatch): Promise<VaultConnection | null> =>
      attempt(() => update.mutateAsync({ ...patch, connectionId }), failed),
    sync: (connectionId: string): Promise<VaultConnection | null> =>
      attempt(() => sync.mutateAsync(connectionId), failed),
    remove: async (connectionId: string): Promise<boolean> =>
      (await attempt(async () => {
        await remove.mutateAsync(connectionId);
        return true;
      }, failed)) === true,
    connecting: connect.isPending,
    updating: update.isPending,
    syncing: sync.isPending,
    removing: remove.isPending,
  };
}
