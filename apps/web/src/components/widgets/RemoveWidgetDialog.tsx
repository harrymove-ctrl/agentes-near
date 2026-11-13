import type { Dashboard, Widget } from "@agenteschat/client";
import { useRemoveWidget } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Dialog, DialogFooter } from "@agenteschat/ui";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { useWidgetAgent, widgetTitle } from "./parts";

/**
 * "Remove “Sales today”?" (ADR 0135): every way to remove a widget (its card's menu, Organize, its panel) asks here
 * first, since its routine stops and its history goes with it. Remove removes it and says so in a toast; Cancel keeps
 * it. Open while `widget` is set.
 */
export function RemoveWidgetDialog({
  orgId,
  widget,
  boardKind,
  onClose,
  onRemoving,
  onRemoved,
}: {
  orgId: string;
  widget: Widget | null;
  boardKind: Dashboard["kind"];
  onClose: () => void;
  /** Right before the request (a board animates its cells closing the gap). */
  onRemoving?: () => void;
  /** After it is gone (a panel closes). */
  onRemoved?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const remove = useRemoveWidget(orgId);
  // The last widget asked about stays drawn while the dialog closes.
  const last = useRef<Widget | null>(widget);
  if (widget) last.current = widget;
  const shown = last.current;
  const { name } = useWidgetAgent(shown?.agentId ?? "");
  const title = shown ? widgetTitle(t, shown) : "";
  const scheduled = shown !== null && shown.schedule !== "manual";
  const confirm = () => {
    if (!shown) return;
    onRemoving?.();
    remove.mutate(shown.id, {
      onSuccess: () => {
        toast.show(t(boardKind === "home" ? "widgets.removed.home" : "widgets.removed.board", { title, name }));
        onClose();
        onRemoved?.();
      },
      onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
    });
  };
  return (
    <Dialog
      open={widget !== null}
      onOpenChange={(o) => !o && !remove.isPending && onClose()}
      title={t("widgets.removeConfirm.title", { title })}
      description={scheduled ? t("widgets.removeConfirm.textRoutine", { name }) : t("widgets.removeConfirm.textManual")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose} disabled={remove.isPending}>
          {t("common.cancel")}
        </Button>
        <Button variant="danger" loading={remove.isPending} onClick={confirm}>
          {t("widgets.removeConfirm.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
