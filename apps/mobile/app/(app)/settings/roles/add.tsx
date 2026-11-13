import { useLocalSearchParams } from "expo-router";
import { AddToRoleScreen } from "@/features/settings/RolesScreen";

/** Adicionar pessoas to a role (`roleId`), pushed over it. */
export default function SettingsRoleAddRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <AddToRoleScreen roleId={roleId ?? ""} />;
}
