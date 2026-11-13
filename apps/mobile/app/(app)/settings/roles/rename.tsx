import { useLocalSearchParams } from "expo-router";
import { RenameRoleScreen } from "@/features/settings/RolesScreen";

/** A role's name (`roleId`), pushed over it. */
export default function SettingsRoleRenameRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RenameRoleScreen roleId={roleId ?? ""} />;
}
