import { useLocalSearchParams } from "expo-router";
import { SkillScreen } from "@/features/settings/SkillsScreen";

/** A skill of the library (`id`), pushed over Skills. */
export default function SettingsSkillRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SkillScreen id={id ?? ""} />;
}
