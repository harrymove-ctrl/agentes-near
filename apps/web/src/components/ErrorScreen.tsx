import { noAnswer } from "@agenteschat/client/lib/errors";
import { Button, EmptyState } from "@agenteschat/ui";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserOffline } from "@/chat/offline";
import { DesktopDragStrip } from "@/components/DesktopTitleBar";
import { BootSplash } from "@/components/Sky";
import { useServerBack } from "@/hooks/useServerBack";
import { onVersionReload, reloadIfStale, reloadingForNewVersion } from "@/lib/app-version";
import { inDesktopApp, pageReadyAfterPaint } from "@/lib/desktop";
import { onReportTaken, reportError, reportTaken, shortErrorId } from "@/lib/error-reports";

/**
 * A page that broke, in place of the router's own screen: a short message, a reload, and the code of its report
 * (ADR 0104) for whoever asks for help, once the report is on its way. Without reports there is no code to give. It
 * stands in for the root's own component, so in the desktop app it brings the strip the window drags by and lifts
 * the app's cover. Two failures are no crash, so no report and no code: a request that got no answer, or only the
 * proxy's (the server restarting, the network gone), which opens again by itself once the server answers, and a
 * page's file from before a deploy, the boot sky while the new version loads. A crash in a tab a deploy left behind
 * reloads into the new version too.
 */
export function ErrorScreen({ error }: ErrorComponentProps) {
  const { t } = useTranslation();
  const [id] = useState(() => reportError(error));
  const sent = useSyncExternalStore(onReportTaken, () => reportTaken(id));
  const unreachable = noAnswer(error);
  const offline = useBrowserOffline();
  useServerBack(unreachable);
  // The sky only while the reload is on its way: a person who stayed (a page asked before leaving) gets the crash back.
  const reloading = useSyncExternalStore(onVersionReload, reloadingForNewVersion);
  useEffect(pageReadyAfterPaint, []);
  useEffect(() => {
    if (!unreachable) void reloadIfStale();
  }, [unreachable]);
  if (reloading) return <BootSplash />;
  const reload = () => window.location.reload();
  return (
    <div className="page page--mid">
      {inDesktopApp() && <DesktopDragStrip />}
      <header className="page__header">
        <h1 className="page-title">
          {unreachable ? t(offline ? "empty.offlineTitle" : "empty.unreachableTitle") : t("empty.crashTitle")}
        </h1>
      </header>
      {unreachable ? (
        <EmptyState
          icon="plug"
          actions={
            <Button variant="primary" icon="refresh" onClick={reload}>
              {t("common.retry")}
            </Button>
          }
        >
          {t(offline ? "empty.offlineText" : "empty.unreachableText")}
        </EmptyState>
      ) : (
        <EmptyState
          icon="alert"
          actions={
            <Button variant="primary" icon="refresh" onClick={reload}>
              {t("common.reload")}
            </Button>
          }
        >
          {t("empty.crashText")}
          {id && sent && ` ${t("empty.crashCode", { id: shortErrorId(id) })}`}
        </EmptyState>
      )}
    </div>
  );
}
