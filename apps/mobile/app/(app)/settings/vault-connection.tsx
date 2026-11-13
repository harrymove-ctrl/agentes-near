import { Redirect, useLocalSearchParams } from "expo-router";
import { textParam, vaultHref } from "@/features/vault/logic";
import { VaultConnectionScreen } from "@/features/vault/VaultConnectionScreen";

/** A connected password manager (`?id=`; ADR 0144): its state, Sync now, default access, Disconnect. */
export default function SettingsVaultConnectionRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = textParam(params.id);
  if (!id) return <Redirect href={vaultHref.list as never} />;
  return <VaultConnectionScreen key={id} id={id} />;
}
