import { Redirect, useLocalSearchParams } from "expo-router";
import { RoutineScreen } from "@/features/routines/RoutineScreen";
import { isSafeId } from "@/features/shared/logic";

/** One routine (`/routines/<id>`): from the list, a notification, a routine's message or an agent's receipt. */
export default function RoutineRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <Redirect href="/routines" />;
  return <RoutineScreen key={id} id={id} />;
}
