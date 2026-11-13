import type { WidgetSchedule } from "@agenteschat/client";
import { useDashboards, useHomeDashboard, usePinWidget } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Locked,
  Segmented,
  Select,
  Switch,
  WidgetCard,
} from "@agenteschat/ui";
import { chartBlockToWidgetSpec, defaultSize, sizeToLayout } from "@agenteschat/ui/widgets/spec";
import { useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useToast } from "@/lib/toast";
import { useWidgetAgent } from "./parts";
import "./widgets.css";

/** How often a pinned chart may be redone (not "manual": that is "just pin"). */
const KEEP_SCHEDULES = ["half", "hour", "day", "week"] as const satisfies readonly WidgetSchedule[];
type KeepSchedule = (typeof KEEP_SCHEDULES)[number];

/**
 * "Pin to a dashboard" on an agent's chart in the chat (ADR 0135): the chart as it will look, where it goes (My Home
 * or a board the person edits) and whether its agent keeps it updated; it keeps the chart's data either way.
 */
export function PinToDashboard({
  orgId,
  messageId,
  block,
  agentId,
  onClose,
}: {
  orgId: string;
  messageId: string;
  /** The ```chart block's JSON, as the message has it. */
  block: string;
  agentId: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const read = useMemo(() => chartBlockToWidgetSpec(block), [block]);
  const home = useHomeDashboard(orgId);
  const boards = useDashboards(orgId);
  const pin = usePinWidget(orgId);
  const { name, color } = useWidgetAgent(agentId);
  const [dest, setDest] = useState("home");
  const [keep, setKeep] = useState(false);
  const [schedule, setSchedule] = useState<KeepSchedule>("day");
  const id = useId();
  const editable = (boards.data?.dashboards ?? []).filter((d) => d.kind === "board" && d.canEdit);
  const target = dest === "home" ? home.data : editable.find((d) => d.id === dest);
  const where = dest === "home" ? t("widgets.home") : (target?.title ?? "");
  const size = defaultSize(read?.spec.kind ?? null);
  const chosen: WidgetSchedule = keep ? schedule : "manual";

  const submit = () => {
    if (!read || !target) return;
    pin.mutate(
      { dashboardId: target.id, messageId, block, schedule: chosen, size },
      {
        onSuccess: (widget) => {
          onClose();
          toast.show(
            keep
              ? t("widgets.pin.doneUpdating", { where, name, schedule: t(`widgets.schedulesInline.${chosen}`) })
              : t("widgets.pin.done", { where }),
            "success",
            {
              label: t("widgets.pin.open"),
              run: () =>
                void (target.kind === "home"
                  ? navigate({ to: "/org/$orgId/home", params: { orgId }, search: { widget: widget.id } })
                  : navigate({
                      to: "/org/$orgId/dashboards/$dashboardId",
                      params: { orgId, dashboardId: target.id },
                      search: { widget: widget.id },
                    })),
            },
          );
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("widgets.pin.label")}
      description={t("widgets.pin.subtitle")}
      closeLabel={t("common.close")}
      width={480}
      className="wpin"
    >
      <Locked when={pin.isPending}>
        <DialogBody>
          {read ? (
            <div className="wpin__stage">
              <WidgetCard
                className="wg--preview"
                title={read.title}
                spec={read.spec}
                status="ok"
                color={color}
                size={sizeToLayout(size)}
                locale={i18n.language}
                face={<AgentAvatar agentId={agentId} name={name} size="xs" />}
                footer={
                  <span className="wg__when">
                    <b>{name}</b> <span className="wg__dot">·</span> {t(`widgets.schedulesInline.${chosen}`)}
                  </span>
                }
              />
            </div>
          ) : (
            <Alert>{t("dashboards.errors.blockNotFound")}</Alert>
          )}
          <Field label={t("dashboards.newWidget.destination")}>
            <Select
              value={dest}
              onValueChange={setDest}
              options={[
                { value: "home", label: t("widgets.home") },
                ...editable.map((d) => ({ value: d.id, label: d.title })),
              ]}
            />
          </Field>
          <div className="wpin__keep">
            <Switch id={`${id}-keep`} checked={keep} onCheckedChange={setKeep} aria-describedby={`${id}-keep-hint`} />
            <span className="wpin__keep-text">
              <label htmlFor={`${id}-keep`}>{t("dashboards.newWidget.keepUpdated")}</label>
              <small id={`${id}-keep-hint`}>
                {keep
                  ? t("dashboards.newWidget.steps.redoes", { name, schedule: t(`widgets.schedulesInline.${schedule}`) })
                  : t("dashboards.newWidget.steps.noRedoHint")}
              </small>
            </span>
          </div>
          {keep && (
            <Field label={t("dashboards.newWidget.updates")} group>
              <Segmented<KeepSchedule>
                label={t("dashboards.newWidget.updates")}
                value={schedule}
                onValueChange={setSchedule}
                options={KEEP_SCHEDULES.map((s) => ({ value: s, label: t(`widgets.schedulesShort.${s}`) }))}
              />
            </Field>
          )}
          {pin.isError && <Alert>{errorText(t, pin.error, i18n.language)}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" icon="pin" loading={pin.isPending} disabled={!read || !target} onClick={submit}>
          {t("widgets.pin.action")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
