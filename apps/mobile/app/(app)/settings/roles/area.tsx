import { useLocalSearchParams } from "expo-router";
import { RoleAreaScreen } from "@/features/settings/RolesScreen";

/** A role's area (`roleId`, `area`): its levels and items, pushed over the role. */
export default function SettingsRoleAreaRoute() {
  const { roleId, area } = useLocalSearchParams<{ roleId: string; area: string }>();
  return <RoleAreaScreen roleId={roleId ?? ""} area={area ?? ""} />;
}
