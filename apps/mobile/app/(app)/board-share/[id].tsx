import { Redirect, useLocalSearchParams } from "expo-router";
import { ShareScreen } from "@/features/dashboards/ShareScreen";
import { isSafeId } from "@/features/shared/logic";

/** "Share" a dashboard (`/board-share/<id>`), pushed from its bar. */
export default function BoardShareRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <Redirect href="/dashboards" />;
  return <ShareScreen key={id} id={id} />;
}
