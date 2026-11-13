import { useMe } from "@agenteschat/client";
import { Button, EmptyState } from "@agenteschat/ui";
import { createRootRouteWithContext, Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { RouterContext } from "@/app/router-context";
import { ContextMenuHost } from "@/components/DesktopMenus";
import { DesktopDragStrip } from "@/components/DesktopTitleBar";
import { ErrorScreen } from "@/components/ErrorScreen";
import { AccountDeletingScreen } from "@/components/Standing";
import { askForPhone, asksForPhone, inDesktopApp, pageReadyAfterPaint, routeNewWindowLinks } from "@/lib/desktop";
import { dispatchPushOpen } from "@/lib/push-open";
import { listenForPushOpens } from "@/lib/web-push";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: ErrorScreen,
});

function Root() {
  // agentes for Mac: the workspace has its title bar (org.$orgId.tsx); every other page drags from the top.
  const inWorkspace = useRouterState({ select: (s) => s.location.pathname.startsWith("/org/") });
  const router = useRouter();
  const deletion = useMe().data?.user.deletion;
  // In the app: once this first screen is on the glass, the app's cover over the window goes.
  useEffect(pageReadyAfterPaint, []);
  // In the app: a link to another site opens in the browser, one to this server in the window (main_window.rs).
  useEffect(() => {
    const root = document.getElementById("root");
    if (!inDesktopApp() || !root) return;
    return routeNewWindowLinks(root);
  }, []);
  // The app opens a page of the site that is already open (the tray, a notification, ⌘-click) without
  // loading it again: the route moves (main_window.rs). Downloads and the API go as a plain load.
  useEffect(() => {
    if (!inDesktopApp()) return;
    const w = window as { __agentesNavigate?: (path: string) => void };
    w.__agentesNavigate = (path) => {
      if (!path.startsWith("/") || path.startsWith("//")) return;
      // "Show QR code" in the app: the dialog over the page the person is on.
      if (asksForPhone(new URL(path, window.location.origin).search)) askForPhone();
      else if (path.startsWith("/api/")) window.location.assign(path);
      else router.history.push(path);
    };
    return () => {
      delete w.__agentesNavigate;
    };
  }, [router]);
  // A click on a browser notification while the app is open in a tab (ADR 0071): the open workspace opens it
  // where its inbox would (`PushOpens`); on any other page the tab moves to its address.
  useEffect(
    () => listenForPushOpens((click) => dispatchPushOpen(click, (path) => router.history.push(path))),
    [router],
  );
  return (
    <>
      {inDesktopApp() && !inWorkspace && <DesktopDragStrip />}
      <ContextMenuHost />
      {deletion ? <AccountDeletingScreen dueAt={deletion.dueAt} /> : <Outlet />}
    </>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="page page--mid">
      <header className="page__header">
        <h1 className="page-title">{t("empty.notFoundTitle")}</h1>
      </header>
      <EmptyState
        icon="search"
        actions={
          <Button asChild>
            <Link to="/">{t("empty.goHome")}</Link>
          </Button>
        }
      >
        {t("empty.notFoundText")}
      </EmptyState>
    </div>
  );
}
