import type { Widget, WidgetFailure, WidgetKind } from "@agenteschat/client";
import { widgetFailureKey } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { type AgentColor, Icon, PixelSpinner } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";

/** The widget's agent as a board shows it: its name and its color (sky when it is gone). */
export function useWidgetAgent(agentId: string) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.anyAgent(agentId);
  return { agent, name: agent?.name ?? t("channel.unknownAgent"), color: colorOf(agent) };
}

/** The face of the agent who looks after a widget, at the start of its card's title (`WidgetCard`'s `face`). */
export function WidgetFace({ agentId, name }: { agentId: string; name: string }) {
  return <AgentAvatar agentId={agentId} name={name} size="xs" />;
}

/** What a widget is called until its agent names it: its kind ("Number", "Bars"…), or "New widget" (ADR 0135). */
export function neutralWidgetTitle(t: TFunction, kind: WidgetKind | null): string {
  return kind ? t(`widgets.kinds.${kind}`) : t("widgets.untitled");
}

/**
 * A widget's title as boards and its panel show it. The agent names it on its first build; until then (or when an
 * older widget still holds the start of what was asked) the neutral name, never the raw ask (ADR 0135).
 */
export function widgetTitle(t: TFunction, w: Pick<Widget, "title" | "prompt" | "spec" | "kind" | "format">): string {
  const title = w.title.trim();
  const ask = w.prompt.trim();
  if (title && (w.spec || !ask || !ask.startsWith(title))) return w.title;
  return neutralWidgetTitle(t, w.kind ?? (w.format === "auto" ? null : w.format));
}

/** Why a widget stopped updating, in the reader's words (the agent's own when it said why). */
export function failureText(t: TFunction, failure: WidgetFailure | null, name: string): string {
  if (!failure) return t("widgets.failure.error");
  if (failure.code === "agent_reported" && failure.detail) return failure.detail;
  const key = widgetFailureKey(failure.code === "agent_reported" ? "error" : failure.code);
  return t(key, { name, detail: failure.detail ?? "" });
}

/**
 * A widget's footer on a board (ADR 0135): who looks after it, when it last updated and how often; while it is built
 * or updated, the agent at it; failed, why, with Resolve (an update asked now).
 */
export function WidgetFoot({
  widget,
  name,
  color,
  now,
  onResolve,
  resolving = false,
}: {
  widget: Widget;
  name: string;
  color: AgentColor;
  now: number;
  /** Resolve: run it again (only for whoever may). */
  onResolve?: () => void;
  resolving?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const schedule = t(`widgets.schedulesInline.${widget.schedule}`);
  if (widget.status === "building")
    return (
      <>
        <PixelSpinner size={14} color={color} />
        <span className="wg__when">
          {name} <span className="wg__dot">·</span> {schedule}
        </span>
      </>
    );
  if (widget.status === "updating" || resolving)
    return (
      <>
        <PixelSpinner size={14} color={color} />
        <span className="wg__when">{t("widgets.status.updating", { name })}</span>
      </>
    );
  if (widget.status === "failed")
    return (
      <span className="wg__warn ac-iconline" role="status">
        <Icon name="alert" size={14} />
        <span>
          {failureText(t, widget.failure, name)}{" "}
          {onResolve && (
            <button
              type="button"
              className="wg__resolve"
              onClick={(e) => {
                e.stopPropagation();
                onResolve();
              }}
            >
              {t("widgets.failure.resolve")}
            </button>
          )}
        </span>
      </span>
    );
  // The agent's face leads the card's title (`WidgetCard`'s `face`): the footer only says who and when.
  return (
    <span className="wg__when">
      <b>{name}</b>
      {widget.refreshedAt && (
        <>
          {" "}
          <span className="wg__dot">·</span> {relativeTime(t, i18n.language, widget.refreshedAt, new Date(now))}
        </>
      )}{" "}
      <span className="wg__dot">·</span> {schedule}
    </span>
  );
}

/**
 * A board's head controls as one pill (ADR 0135): "Organize" (pressed while organizing, then "Done") and "+ Widget"
 * side by side, a hairline between them. Home's mural and a board's page use it.
 */
export function BoardActionsPill({
  label,
  arranging,
  onArrange,
  onAdd,
}: {
  /** The group's name ("My Home", the board's title). */
  label: string;
  arranging: boolean;
  /** Absent: no Organize (an empty board has nothing to move). */
  onArrange?: () => void;
  /** Absent: no "+" (Home showing a board the person only sees). */
  onAdd?: () => void;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: two buttons that read as one control, not a fieldset
    <span className="wb-pill" role="group" aria-label={label}>
      {onArrange && (
        <button type="button" aria-pressed={arranging} onClick={onArrange}>
          <Icon name={arranging ? "check" : "grid"} size={16} />
          {arranging ? t("widgets.organize.done") : t("widgets.organize.start")}
        </button>
      )}
      {onAdd && (
        <button type="button" aria-label={t("widgets.add.label")} title={t("widgets.add.label")} onClick={onAdd}>
          <Icon name="plus" size={16} />
          {t("widgets.add.short")}
        </button>
      )}
    </span>
  );
}
