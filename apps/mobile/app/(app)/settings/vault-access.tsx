import { Redirect, useLocalSearchParams } from "expo-router";
import { textParam, vaultHref } from "@/features/vault/logic";
import { VaultAccessScreen } from "@/features/vault/VaultAccessScreen";

/** Who has access to a Vault item (`?id=`) or, by default, to a connection's items (`?connection=`; ADR 0144). */
export default function SettingsVaultAccessRoute() {
  const params = useLocalSearchParams<{ id?: string; connection?: string }>();
  const itemId = textParam(params.id);
  const connectionId = textParam(params.connection);
  if (itemId) return <VaultAccessScreen key={itemId} itemId={itemId} />;
  if (connectionId) return <VaultAccessScreen key={connectionId} connectionId={connectionId} />;
  return <Redirect href={vaultHref.list as never} />;
}
