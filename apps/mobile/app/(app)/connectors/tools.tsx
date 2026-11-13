import { useLocalSearchParams } from "expo-router";
import { ToolsScreen } from "@/features/connectors/ToolsScreen";

/** Ferramentas of a connection (`id`), pushed over Conectores. */
export default function ConnectorToolsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ToolsScreen connectionId={id ?? ""} />;
}
