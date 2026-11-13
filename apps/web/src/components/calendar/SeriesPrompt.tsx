import type { SeriesScope } from "@agenteschat/client";
import { Button, Dialog, DialogBody, DialogFooter } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/** "Só este / Este e os próximos / Todos" for an edit (or delete) of a recurring event. */
export function SeriesPrompt({
  open,
  action,
  onPick,
  onCancel,
}: {
  open: boolean;
  action: "edit" | "delete";
  onPick: (scope: SeriesScope) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      title={action === "edit" ? t("calendar.series.editTitle") : t("calendar.series.deleteTitle")}
      description={t("calendar.series.body")}
      closeLabel={t("common.close")}
      width={420}
    >
      <DialogBody className="cal-series">
        {(["this", "following", "all"] as const).map((scope) => (
          <Button key={scope} variant={scope === "this" ? "primary" : "default"} onClick={() => onPick(scope)}>
            {t(`calendar.series.${scope}`)}
          </Button>
        ))}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
      </DialogFooter>
    </Dialog>
  );
}
