import { useLocalSearchParams } from "expo-router";
import { scopeParam } from "@/features/vault/logic";
import { VaultNewScreen } from "@/features/vault/VaultNewScreen";

/** A new Vault item (`?scope=personal|team`, the tab it was started from; ADR 0144). */
export default function SettingsVaultNewRoute() {
  const params = useLocalSearchParams<{ scope?: string }>();
  return <VaultNewScreen scope={scopeParam(params.scope)} />;
}
