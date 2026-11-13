import { PinScreen } from "@/features/dashboards/PinScreen";

/** "Pin to a dashboard", pushed from a message's actions (the chart comes with it, not in the URL). */
export default function WidgetPinRoute() {
  return <PinScreen />;
}
