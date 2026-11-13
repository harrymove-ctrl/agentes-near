import { useLocalSearchParams } from "expo-router";
import { HOME } from "@/features/dashboards/logic";
import { NewWidgetScreen } from "@/features/dashboards/NewWidgetScreen";
import { isSafeId } from "@/features/shared/logic";

/** "New widget" (`?dashboardId=<id>`, `home` for My Home), pushed from a board. */
export default function NewWidgetRoute() {
  const { dashboardId } = useLocalSearchParams<{ dashboardId?: string }>();
  return <NewWidgetScreen dashboardId={isSafeId(dashboardId) ? dashboardId : HOME} />;
}
