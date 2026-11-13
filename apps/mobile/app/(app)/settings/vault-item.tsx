import { Redirect, useLocalSearchParams } from "expo-router";
import { textParam, vaultHref } from "@/features/vault/logic";
import { VaultItemScreen } from "@/features/vault/VaultItemScreen";

/** A Vault item's page (`?id=`, ADR 0144): its fields, who has access, its recent uses. */
export default function SettingsVaultItemRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = textParam(params.id);
  if (!id) return <Redirect href={vaultHref.list as never} />;
  return <VaultItemScreen key={id} id={id} />;
}
