import { useLocalSearchParams } from "expo-router";
import { RoleScreen } from "@/features/settings/RolesScreen";

/** A role (`roleId`; `owner`: the owners), pushed over the roles. */
export default function SettingsRoleRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RoleScreen roleId={roleId ?? ""} />;
}
