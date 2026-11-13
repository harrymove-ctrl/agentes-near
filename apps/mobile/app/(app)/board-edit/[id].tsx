import { Redirect, useLocalSearchParams } from "expo-router";
import { BoardEditScreen } from "@/features/dashboards/BoardEditScreen";
import { isSafeId } from "@/features/shared/logic";

/** "Rename" a dashboard (`/board-edit/<id>`): its name and description, pushed from its "…". */
export default function BoardEditRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <Redirect href="/dashboards" />;
  return <BoardEditScreen key={id} id={id} />;
}
