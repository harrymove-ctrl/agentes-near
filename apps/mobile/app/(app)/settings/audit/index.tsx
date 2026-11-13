import { useLocalSearchParams } from "expo-router";
import { AuditScreen } from "@/features/settings/AuditScreen";
import { isSafeId } from "@/features/shared/logic";

/** Configurações › Auditoria: what agents did and people changed (admins); `?agent=` opens it on one agent. */
export default function SettingsAuditRoute() {
  const { agent } = useLocalSearchParams<{ agent?: string }>();
  return <AuditScreen agentId={isSafeId(agent) ? agent : null} />;
}
