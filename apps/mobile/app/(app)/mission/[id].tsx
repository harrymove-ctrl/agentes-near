import { useLocalSearchParams } from "expo-router";
import { MissionScreen } from "@/features/missions/MissionScreen";
import { FocusLive } from "@/features/shared/parts";

/** A mission (deep link `agenteschat://mission/<id>`). */
export default function MissionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <FocusLive>
      <MissionScreen key={id} id={id} />
    </FocusLive>
  );
}
