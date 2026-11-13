import { useLocalSearchParams } from "expo-router";
import { MemoryScreen } from "@/features/memory/MemoryScreen";

/** What the agents learned, pushed from Você; `agent`: one agent's only (a link to its memory page). */
export default function MemoryRoute() {
  const { agent } = useLocalSearchParams<{ agent?: string }>();
  return <MemoryScreen agent={agent} />;
}
