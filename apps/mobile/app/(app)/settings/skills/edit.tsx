import { useLocalSearchParams } from "expo-router";
import { EditSkillScreen } from "@/features/settings/SkillsScreen";

/** Editar a skill (`id`), pushed over its page. */
export default function SettingsEditSkillRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <EditSkillScreen id={id ?? ""} />;
}
