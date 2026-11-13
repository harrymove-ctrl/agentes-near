import { Redirect, useLocalSearchParams } from "expo-router";
import { textParam, vaultHref } from "@/features/vault/logic";
import { VaultConnectScreen } from "@/features/vault/VaultConnectScreen";

/** Connecting a password manager (`?kind=`), or new sign-in details for one (`&connection=`; ADR 0144). */
export default function SettingsVaultConnectRoute() {
  const params = useLocalSearchParams<{ kind?: string; connection?: string }>();
  const kind = textParam(params.kind);
  const connectionId = textParam(params.connection);
  if (!kind) return <Redirect href={vaultHref.list as never} />;
  return <VaultConnectScreen key={`${kind}:${connectionId}`} kind={kind} {...(connectionId ? { connectionId } : {})} />;
}
