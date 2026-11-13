import { ComputerSetupSheet } from "@/features/computer/SetupWait";
import { goBack } from "@/features/shared/parts";

/**
 * The workspace's own computer on its way, as a native form sheet over Conversas (presentation set in
 * `_layout`; from its notice there).
 */
export default function ComputerSetupRoute() {
  return <ComputerSetupSheet onClose={goBack} />;
}
