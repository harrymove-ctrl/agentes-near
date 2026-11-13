import { ChartSheet } from "@/features/chat/ChartCard";
import { SheetSurface } from "@/ui";

/** A message's chart in full screen, as a native form sheet: the chart big, its table under it. */
export default function ChartRoute() {
  return (
    <SheetSurface>
      <ChartSheet />
    </SheetSurface>
  );
}
