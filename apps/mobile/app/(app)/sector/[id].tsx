import { useLocalSearchParams } from "expo-router";
import { SectorScreen } from "@/features/team/SectorScreen";

/** One setor, from Equipe: who cares for it, its agents, and deleting it. */
export default function SectorRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SectorScreen id={id} />;
}
