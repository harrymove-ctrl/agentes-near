import { useLocalSearchParams } from "expo-router";
import { ConnectionScreen } from "@/features/connectors/ConnectionScreen";

/** A connection (`id`), pushed over Conectores (a clear bar over its brand's sky; presentation set in `_layout`). */
export default function ConnectionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ConnectionScreen id={id ?? ""} />;
}
