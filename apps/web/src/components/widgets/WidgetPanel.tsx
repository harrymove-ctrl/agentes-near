import type { WidgetDetail, WidgetSchedule, WidgetUpdate } from "@agenteschat/client";
import { useAskWidgetChange, useRefreshWidget, useUpdateWidget, useWidget } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { upcomingAt, whenAt } from "@agenteschat/client/lib/format";
import { plainInline } from "@agenteschat/client/lib/markdown";
import {
  Button,
  Composer,
  Dialog,
  DialogBody,
  Icon,
  Input,
  Locked,
  Select,
  Spinner,
  Switch,
  WidgetCard,
} from "@agenteschat/ui";
import { WIDGET_SCHEDULES } from "@agenteschat/ui/widgets/spec";
import type { TFunction } from "i18next";
import { type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useFocusAtEnd, useSent } from "@/components/EditInPlace";
import { useOrg } from "@/components/org-context";
import { useNow } from "@/hooks/useNow";
import { useToast } from "@/lib/toast";
import { failureText, useWidgetAgent, WidgetFace, WidgetFoot, widgetTitle } from "./parts";
import { RemoveWidgetDialog } from "./RemoveWidgetDialog";
import "./widgets.css";

/**
 * A widget's side panel (ADR 0135): the widget big, how it updates (its schedule and next run, its alert, what its
 * agent reads), its latest updates, Update now, Remove, and "Ask for a change" to its agent. Whoever edits it renames
 * it in place: a press on the title (or its pencil) opens the field, Enter saves, Esc cancels. Opened from a board
 * (`?widget=<id>`), a notification or a push.
 */
export function WidgetPanel({
  orgId,
  widgetId,
  onClose,
}: {
  orgId: string;
  widgetId: string | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const query = useWidget(orgId, widgetId);
  const widget = widgetId ? query.data : undefined;
  const { name } = useWidgetAgent(widget?.agentId ?? "");
  const refresh = useRefreshWidget(orgId);
  const toast = useToast();
  const update = useUpdateWidget(orgId);
  const busy = widget?.status === "building" || widget?.status === "updating" || refresh.isPending;
  const gone = query.isError && widgetId !== null;
  // Renaming: the field's text while it is open, then what was sent until the widget comes back with it.
  const [naming, setNaming] = useState<string | null>(null);
  const sent = useSent<string>(widget?.title ?? "");
  const field = useFocusAtEnd<HTMLInputElement>(naming !== null);
  const cancelled = useRef(false);
  const shown = widget ? (sent.pending ?? widgetTitle(t, widget)) : gone ? t("dashboards.errors.widgetNotFound") : "";
  const startNaming = () => {
    if (!widget?.canEdit) return;
    cancelled.current = false;
    // A widget its agent hasn't named yet starts empty, not with the name it shows meanwhile.
    setNaming(sent.pending ?? (widgetTitle(t, widget) === widget.title ? widget.title : ""));
  };
  const saveName = () => {
    if (naming === null || !widget) return;
    const next = naming.trim();
    setNaming(null);
    if (cancelled.current || !next || next === widget.title) return;
    sent.send(next);
    update.mutate(
      { widgetId: widget.id, title: next },
      {
        onError: (e) => {
          sent.clear();
          toast.show(errorText(t, e, i18n.language), "error");
        },
      },
    );
  };
  const title: ReactNode =
    naming !== null ? (
      <input
        ref={field}
        className="wd__title-input"
        value={naming}
        maxLength={80}
        aria-label={t("widgets.panel.titleLabel")}
        onChange={(e) => setNaming(e.target.value)}
        onBlur={saveName}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== "Escape") return;
          e.preventDefault();
          cancelled.current = e.key === "Escape";
          e.currentTarget.blur();
        }}
      />
    ) : widget?.canEdit ? (
      // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a pointer shortcut; the pencil is the keyboard way
      <span className="wd__title" onClick={startNaming}>
        {shown}
      </span>
    ) : (
      shown
    );
  return (
    <Dialog
      open={widgetId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      // Esc while renaming cancels the name, not the panel.
      onEscapeKeyDown={(e) => {
        if (naming !== null) e.preventDefault();
      }}
      description={
        widget
          ? widget.dashboard.kind === "home" || !widget.dashboard.title
            ? t("widgets.panel.caresFor", { name })
            : t("widgets.panel.caresForOn", { name, board: widget.dashboard.title })
          : undefined
      }
      closeLabel={t("common.close")}
      width={480}
      className="wd"
      actions={
        widget?.canEdit ? (
          <>
            {naming === null && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="edit"
                className="wd__pen"
                aria-label={t("widgets.panel.rename")}
                title={t("widgets.panel.rename")}
                onClick={startNaming}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="refresh"
              aria-label={t("widgets.menu.refresh")}
              title={t("widgets.menu.refresh")}
              disabled={busy}
              onClick={() =>
                refresh.mutate(widget.id, { onError: (e) => toast.show(errorText(t, e, i18n.language), "error") })
              }
            />
          </>
        ) : undefined
      }
    >
      <DialogBody className="wd__body">
        {widget ? (
          <PanelBody orgId={orgId} widget={widget} onClose={onClose} />
        ) : gone ? (
          <p className="wd__none">{t("dashboards.errors.widgetNotFound")}</p>
        ) : (
          <div className="wd__loading">
            <Spinner size={16} />
          </div>
        )}
      </DialogBody>
    </Dialog>
  );
}

function PanelBody({ orgId, widget, onClose }: { orgId: string; widget: WidgetDetail; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const now = useNow(60_000);
  const { name, color } = useWidgetAgent(widget.agentId);
  const refresh = useRefreshWidget(orgId);
  const [removing, setRemoving] = useState(false);
  const say = (e: unknown) => toast.show(errorText(t, e, i18n.language), "error");
  const removeLabel = t(widget.dashboard.kind === "home" ? "widgets.menu.removeHome" : "widgets.menu.removeBoard");
  return (
    <>
      <WidgetCard
        className="wd__big"
        title={widgetTitle(t, widget)}
        spec={widget.spec}
        status={widget.status}
        color={color}
        size={{ w: 2, h: 2 }}
        locale={i18n.language}
        buildingText={t("widgets.status.building", { name })}
        face={<WidgetFace agentId={widget.agentId} name={name} />}
        footer={
          <WidgetFoot
            widget={widget}
            name={name}
            color={color}
            now={now}
            resolving={refresh.isPending && widget.status === "failed"}
            onResolve={widget.canEdit ? () => refresh.mutate(widget.id, { onError: say }) : undefined}
          />
        }
      />
      <HowItUpdates orgId={orgId} widget={widget} name={name} now={now} />
      <section className="wd__sec" aria-label={t("widgets.panel.history")}>
        <h3>{t("widgets.panel.history")}</h3>
        {widget.history.length === 0 ? (
          <p className="wd__none">{t("widgets.panel.noHistory")}</p>
        ) : (
          <ul className="wd__rows wd__hist">
            {widget.history.map((u) => (
              <HistoryRow key={u.id} update={u} name={name} now={now} />
            ))}
          </ul>
        )}
      </section>
      {widget.canEdit && <AskChange orgId={orgId} widget={widget} name={name} />}
      {widget.canEdit && (
        <div className="wd__end">
          <Button variant="ghost" size="sm" icon="trash" className="wd__remove" onClick={() => setRemoving(true)}>
            {removeLabel}
          </Button>
        </div>
      )}
      <RemoveWidgetDialog
        orgId={orgId}
        widget={removing ? widget : null}
        boardKind={widget.dashboard.kind}
        onClose={() => setRemoving(false)}
        onRemoved={onClose}
      />
    </>
  );
}

/** "How it updates": the schedule (changed here), its alert (changed here), what the agent reads. */
function HowItUpdates({
  orgId,
  widget,
  name,
  now,
}: {
  orgId: string;
  widget: WidgetDetail;
  name: string;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const update = useUpdateWidget(orgId);
  const [alerting, setAlerting] = useState(false);
  const say = (e: unknown) => toast.show(errorText(t, e, i18n.language), "error");
  const next = widget.nextRunAt ? upcomingAt(t, i18n.language, widget.nextRunAt, new Date(now)) : null;
  const alert = widget.alert;
  return (
    <section className="wd__sec" aria-label={t("widgets.panel.how")}>
      <h3>{t("widgets.panel.how")}</h3>
      <ul className="wd__rows">
        <PanelRow
          icon="routines"
          title={t(`widgets.schedules.${widget.schedule}`)}
          sub={
            widget.schedule === "manual"
              ? t("widgets.panel.askAnytime")
              : next
                ? t("widgets.panel.next", { name, when: next })
                : t("widgets.panel.noRoutine")
          }
          action={
            widget.canEdit ? (
              <Select<WidgetSchedule>
                size="sm"
                align="end"
                aria-label={t("widgets.menu.schedule")}
                value={widget.schedule}
                disabled={update.isPending}
                options={WIDGET_SCHEDULES.map((s) => ({ value: s, label: t(`widgets.schedulesShort.${s}`) }))}
                onValueChange={(schedule) =>
                  schedule !== widget.schedule && update.mutate({ widgetId: widget.id, schedule }, { onError: say })
                }
              />
            ) : null
          }
        />
        <PanelRow
          icon="bell"
          title={
            alert.enabled
              ? alert.condition
                ? t("widgets.alert.line", { condition: alert.condition })
                : t("widgets.alert.lineAny")
              : t("widgets.alert.none")
          }
          sub={alert.enabled ? t("widgets.alert.where") : null}
          action={
            widget.canEdit && !alerting ? (
              <Button size="sm" variant="ghost" onClick={() => setAlerting(true)}>
                {t("widgets.panel.changeAlert")}
              </Button>
            ) : null
          }
        >
          {alerting && (
            <AlertEdit
              initial={alert}
              saving={update.isPending}
              onCancel={() => setAlerting(false)}
              onSave={(next) =>
                update.mutate(
                  { widgetId: widget.id, alert: next },
                  { onSuccess: () => setAlerting(false), onError: say },
                )
              }
            />
          )}
        </PanelRow>
        {widget.sources.length > 0 && (
          <PanelRow icon="plug" title={widget.sources.join(" · ")} sub={t("widgets.panel.reads", { name })} />
        )}
      </ul>
    </section>
  );
}

function PanelRow({
  icon,
  title,
  sub,
  action,
  children,
}: {
  icon: "routines" | "bell" | "plug";
  title: string;
  sub?: string | null;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li>
      <div className="wd__row">
        <Icon name={icon} size={18} />
        <span className="wd__grow">
          {title}
          {sub && <small>{sub}</small>}
        </span>
        {action}
      </div>
      {children}
    </li>
  );
}

/** The alert switch and its condition ("Alert if … "), saved together. */
function AlertEdit({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial: { enabled: boolean; condition: string };
  saving: boolean;
  onCancel: () => void;
  onSave: (alert: { enabled: boolean; condition: string }) => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [condition, setCondition] = useState(initial.condition);
  const id = useId();
  return (
    <div className="wd__alert">
      <Locked when={saving}>
        <div className="wd__alert-on">
          <Switch id={`${id}-on`} checked={enabled} onCheckedChange={setEnabled} />
          <label htmlFor={`${id}-on`}>{t("widgets.alert.label")}</label>
        </div>
        {enabled && (
          <div className="wd__cond">
            <label htmlFor={`${id}-cond`}>{t("widgets.alert.condition")}</label>
            <Input
              id={`${id}-cond`}
              value={condition}
              maxLength={200}
              placeholder={t("widgets.alert.placeholder")}
              onChange={(e) => setCondition(e.target.value)}
            />
          </div>
        )}
      </Locked>
      <div className="wd__alert-acts">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={saving}
          onClick={() => onSave({ enabled, condition: enabled ? condition.trim() : "" })}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/** One update in the history: when, and what it showed, alerted, changed, or why it failed. */
function HistoryRow({ update, name, now }: { update: WidgetUpdate; name: string; now: number }) {
  const { t, i18n } = useTranslation();
  const failed = update.status === "failed";
  return (
    <li>
      <div className="wd__row">
        <time dateTime={update.at}>{whenAt(t, i18n.language, update.at, new Date(now))}</time>
        <span className="wd__grow" data-tone={failed ? "warn" : undefined}>
          {failed ? historyFailure(t, update, name) : plainInline(update.summary ?? "") || t("widgets.panel.updated")}
          {update.alert && <small>{t("widgets.panel.alerted", { text: update.alert })}</small>}
          {update.change && <small>{t("widgets.panel.changed", { text: update.change })}</small>}
        </span>
      </div>
    </li>
  );
}

const historyFailure = (t: TFunction, u: WidgetUpdate, name: string) =>
  u.failureCode === "agent_reported" && u.summary
    ? plainInline(u.summary)
    : failureText(t, { code: u.failureCode ?? "error", detail: u.summary || null }, name);

/**
 * "Ask for a change": the words go to the agent, who redoes the widget with them. While the workspace is being deleted
 * it says why it takes none (ADR 0088 §7).
 */
function AskChange({ orgId, widget, name }: { orgId: string; widget: WidgetDetail; name: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const deleting = Boolean(useOrg().org.deletion);
  const ask = useAskWidgetChange(orgId);
  const [text, setText] = useState("");
  if (deleting)
    return (
      <section className="wd__sec wd__ask" aria-label={t("widgets.panel.ask")}>
        <h3>{t("widgets.panel.ask")}</h3>
        <p className="wd__readonly ac-iconline" role="status">
          <Icon name="lock" size={16} />
          <span>{t("deleting.composer")}</span>
        </p>
      </section>
    );
  return (
    <section className="wd__sec wd__ask" aria-label={t("widgets.panel.ask")}>
      <h3>{t("widgets.panel.ask")}</h3>
      <Composer
        value={text}
        onChange={setText}
        label={t("widgets.panel.ask")}
        placeholder={t("widgets.panel.askPlaceholder")}
        sendLabel={t("widgets.panel.send")}
        sendBlocked={ask.isPending}
        onSend={(body) => {
          const words = body.trim();
          if (!words) return;
          ask.mutate(
            { widgetId: widget.id, text: words },
            {
              onSuccess: () => {
                setText("");
                toast.show(t("widgets.panel.sent", { name }));
              },
              onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
            },
          );
        }}
        pills={
          <span className="wd__to">
            <AgentAvatar agentId={widget.agentId} name={name} size="xs" />
            {t("widgets.panel.askTo", { name })}
          </span>
        }
      />
    </section>
  );
}
