import { CodeSheet } from "@/features/chat/CodeCard";
import { SheetSurface } from "@/ui";

/** A message's code in full screen, as a native form sheet (opened from its card). */
export default function CodeRoute() {
  return (
    <SheetSurface>
      <CodeSheet />
    </SheetSurface>
  );
}
