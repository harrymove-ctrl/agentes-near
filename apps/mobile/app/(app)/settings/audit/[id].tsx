import { useLocalSearchParams } from "expo-router";
import { AuditRowScreen } from "@/features/settings/AuditScreen";

/** A row of the audit log (`id`), pushed over Auditoria. */
export default function SettingsAuditRowRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AuditRowScreen id={id ?? ""} />;
}
