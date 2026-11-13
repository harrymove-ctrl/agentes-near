import { Redirect, useLocalSearchParams } from "expo-router";
import { BoardScreen } from "@/features/dashboards/BoardScreen";
import { isSafeId } from "@/features/shared/logic";

/** A dashboard (`/board/<id>`, `/board/home` for My Home): from Dashboards, a notification or a widget. */
export default function BoardRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <Redirect href="/dashboards" />;
  return <BoardScreen key={id} id={id} />;
}
