import { useLocalSearchParams } from "expo-router";
import { RoutineForm } from "@/features/routines/RoutineForm";
import { isSafeId } from "@/features/shared/logic";

/** "Nova rotina", pushed over Rotinas; `?edit=<id>` is "Editar rotina" (presentation set in `_layout`). */
export default function NewRoutineRoute() {
  const { edit } = useLocalSearchParams<{ edit?: string }>();
  return <RoutineForm editId={isSafeId(edit) ? edit : null} />;
}
