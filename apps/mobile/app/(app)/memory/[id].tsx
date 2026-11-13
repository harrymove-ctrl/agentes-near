import { useLocalSearchParams } from "expo-router";
import { MemoryDetailScreen } from "@/features/memory/MemoryScreen";

/** One memory: what it says, where it came from, and fixing or forgetting it. */
export default function MemoryDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MemoryDetailScreen id={id} />;
}
