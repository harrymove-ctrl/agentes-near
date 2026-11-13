import type { BrainPickOption } from "@agenteschat/client/lib/brain-picker";
import { useTranslation } from "react-i18next";
import { Sheet } from "@/ui";
import { PickList } from "../shared/PickList";
import { SheetTitle } from "../shared/PromptForm";

/**
 * The web's "Quem pensa" on the new agent's step, as a sheet: every model and plan the agent's page offers
 * (`brainPickOptions`), searched by name, maker, plan or "free", in their groups, the chosen one checked.
 */
export function BrainPickSheet({
  open,
  onClose,
  options,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  options: BrainPickOption[];
  value: string | undefined;
  onPick: (option: BrainPickOption) => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose}>
      <SheetTitle title={t("brain.title")} />
      <PickList
        options={options}
        value={value}
        onPick={(o) => {
          onPick(o);
          onClose();
        }}
        placeholder={t("newAgent.brainPick.searchPlaceholder")}
        searchLabel={t("models.search")}
        noResults={t("models.noResults")}
      />
    </Sheet>
  );
}
