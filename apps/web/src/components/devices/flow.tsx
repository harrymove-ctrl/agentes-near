import { Button, DialogFooter } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** What each flow's step needs from the dialog: a way out, a way back, and its title as it changes. */
export interface FlowProps {
  onClose: () => void;
  onBack?: () => void;
  setTitle: (title: ReactNode) => void;
}

/** The flow's own Back (to the chooser) and Cancel, with an optional note on the left. */
export function FlowFooter({
  onClose,
  onBack,
  note,
  children,
}: {
  onClose: () => void;
  onBack?: () => void;
  note?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DialogFooter note={note}>
      {onBack && (
        <Button variant="ghost" icon="chevronLeft" onClick={onBack}>
          {t("common.back")}
        </Button>
      )}
      {children ?? <Button onClick={onClose}>{t("common.cancel")}</Button>}
    </DialogFooter>
  );
}
