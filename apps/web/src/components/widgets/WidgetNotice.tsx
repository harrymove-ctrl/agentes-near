import type { AppNotification } from "@agenteschat/client";
import { useDecideDashboardProposal, useRefreshWidget } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { namesText } from "@agenteschat/client/lib/format";
import { widgetNoticeOf } from "@agenteschat/client/lib/notifications";
import { Button } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { Dir } from "@/components/NotificationParts";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { failureText } from "./parts";
import "./widgets.css";

/**
 * The line under a board's notice (ADR 0135): what the agent saw (an alert), why the widget stopped (a failure), or
 * whom the agent wants to show the board to (a request to publish). Null for any other notice.
 */
export function widgetNoticeLine(t: TFunction, n: AppNotification, dir: Dir): string | null {
  const notice = widgetNoticeOf(n);
  if (!notice) return null;
  const name = notice.agentId ? (dir.anyAgent(notice.agentId)?.name ?? t("channel.unknownAgent")) : "";
  if (notice.kind === "alert") return notice.text || null;
  if (notice.kind === "failed") return failureText(t, { code: notice.reason, detail: notice.text }, name);
  return notice.audience === "roles"
    ? t("widgets.notice.proposalRoles", { title: notice.title, roles: namesText(t, notice.roles) })
    : t("widgets.notice.proposalWorkspace", { title: notice.title });
}

/**
 * What a board's notice lets the person do where it shows (Home, the inbox): open the widget, Resolve a failure
 * (run it again), or decide a request to publish (Publish, Keep only for me). `onOpen` opens it as the inbox would.
 */
export function WidgetNoticeActions({
  n,
  onOpen,
  open = true,
  quiet = false,
}: {
  n: AppNotification;
  onOpen: () => void;
  /** Also "Open widget" / "View dashboard" (where the row doesn't already have Open). */
  open?: boolean;
  /** Resolve as the row's one quiet button at its end (Home), not the primary one. */
  quiet?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const refresh = useRefreshWidget(org.id);
  const decide = useDecideDashboardProposal(org.id);
  const notice = widgetNoticeOf(n);
  if (!notice) return null;
  const say = (e: unknown) => toast.show(errorText(t, e, i18n.language), "error");
  const stop = (run: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    run();
  };
  if (notice.kind === "proposal") {
    const dashboardId = notice.dashboardId;
    const pick = (decision: "publish" | "keep") =>
      dashboardId &&
      decide.mutate(
        { dashboardId, decision },
        {
          onSuccess: () =>
            toast.show(
              t(decision === "publish" ? "dashboards.proposal.published" : "dashboards.proposal.kept", {
                title: notice.title,
              }),
            ),
          onError: say,
        },
      );
    return (
      <span className="wn-acts">
        <Button
          size="sm"
          variant="primary"
          loading={decide.isPending && decide.variables?.decision === "publish"}
          disabled={!dashboardId || decide.isPending}
          onClick={stop(() => pick("publish"))}
        >
          {notice.audience === "roles"
            ? t("dashboards.proposal.publishRoles", { roles: namesText(t, notice.roles) })
            : t("dashboards.proposal.publishWorkspace")}
        </Button>
        <Button
          size="sm"
          loading={decide.isPending && decide.variables?.decision === "keep"}
          disabled={!dashboardId || decide.isPending}
          onClick={stop(() => pick("keep"))}
        >
          {t("dashboards.proposal.keep")}
        </Button>
        {open && (
          <Button size="sm" variant="ghost" onClick={stop(onOpen)}>
            {t("widgets.notice.openBoard")}
          </Button>
        )}
      </span>
    );
  }
  const widgetId = notice.widgetId;
  return (
    <span className="wn-acts">
      {notice.kind === "failed" && widgetId && (
        <Button
          size="sm"
          variant={quiet ? undefined : "primary"}
          icon={quiet ? undefined : "refresh"}
          loading={refresh.isPending}
          onClick={stop(() =>
            refresh.mutate(widgetId, {
              onSuccess: () => toast.show(t("widgets.notice.resolving", { title: notice.title })),
              onError: say,
            }),
          )}
        >
          {t("widgets.failure.resolve")}
        </Button>
      )}
      {open && (
        <Button size="sm" variant={notice.kind === "alert" ? "primary" : "ghost"} onClick={stop(onOpen)}>
          {widgetId ? t("widgets.notice.openWidget") : t("widgets.notice.openBoard")}
        </Button>
      )}
    </span>
  );
}
