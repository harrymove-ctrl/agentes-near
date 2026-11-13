import { useLocalSearchParams } from "expo-router";
import { routeAgent } from "@/features/settings/install-from-card";
import { InstallSkillScreen } from "@/features/settings/SkillsScreen";

/**
 * "Instalar skill", pushed over Skills; `url`: an agent's card, the link read to pick from; `agent`: that agent, kept
 * only when its card opened this screen (`routeAgent`).
 */
export default function SettingsInstallSkillRoute() {
  const { url, agent } = useLocalSearchParams<{ url?: string; agent?: string }>();
  return <InstallSkillScreen initialUrl={url} forAgentId={routeAgent(url, agent)} />;
}
