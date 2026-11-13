import { Redirect, useLocalSearchParams } from "expo-router";
import { WidgetScreen } from "@/features/dashboards/WidgetScreen";
import { isSafeId } from "@/features/shared/logic";

/** A widget (`/widget/<id>`): from its board, an alert or a failure in Activity, or its routine. */
export default function WidgetRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <Redirect href="/dashboards" />;
  return <WidgetScreen key={id} id={id} />;
}
