import { PushAskSheet } from "@/features/push/PushAskSheet";
import { goBack } from "@/features/shared/parts";

/** Our notifications sheet before the system's prompt, opened by Conversas (presentation set in `_layout`). */
export default function PushAskRoute() {
  return <PushAskSheet onClose={goBack} />;
}
