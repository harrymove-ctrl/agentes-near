import type { AiStatus, AppNotification, Dashboard } from "@agenteschat/client";
import { cacheNotification, keys, useApi } from "@agenteschat/client";
import {
  homeTarget,
  type OpenTarget,
  opensConnectAi,
  opensOnComputer,
  openTarget,
} from "@agenteschat/client/lib/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useRef } from "react";
import { requestBrowserCard } from "@/components/browser/open";
import { useConnectAi } from "@/components/ConnectAi";
import { useOpenComputer } from "@/components/computer/open";
import { OpenDetailsContext } from "@/components/details-link";
import { deviceTarget } from "@/components/devices/DeviceNotice";
import { LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { fallbackTarget, type PushOpenData, setPushOpenHandler } from "@/lib/push-open";

/**
 * Opening a notification, wherever the click was: the inbox's "Abrir" and a click on a browser notification
 * (ADR 0071) go to the same place, through `openTarget`.
 */

type Navigate = ReturnType<typeof useNavigate>;

/** The router's options for a target, in its workspace (`replace`: instead of the page this tab is on). */
export const targetOptions = (orgId: string, target: OpenTarget, replace = false) =>
  ({
    to: target.to,
    params: { orgId, ...("params" in target ? target.params : {}) },
    search: ("search" in target && target.search) || {},
    replace,
  }) as never;

/** Moves to where a notification opens, in its workspace (`replace`: instead of the page this tab is on). */
export function goToTarget(navigate: Navigate, orgId: string, target: OpenTarget, replace = false) {
  void navigate(targetOptions(orgId, target, replace));
}

/** A device's page (`phones/<id>` or a computer's id), or the Devices list for "". */
const deviceOptions = (orgId: string, path: string, replace = false) =>
  (path.startsWith("phones/")
    ? { to: "/org/$orgId/settings/devices/phones/$phoneId", params: { orgId, phoneId: path.slice(7) }, replace }
    : path
      ? { to: "/org/$orgId/settings/devices/$deviceId", params: { orgId, deviceId: path }, replace }
      : { to: "/org/$orgId/settings/$section", params: { orgId, section: "devices" }, search: {}, replace }) as never;

/** The inbox itself, with nothing to open. */
function goToInbox(navigate: Navigate, orgId: string, replace: boolean) {
  return navigate({ to: "/org/$orgId/notifications", params: { orgId }, search: {}, replace });
}

/** The routine whose details a target opens, when it is one. */
function routineOf(target: OpenTarget): string | null {
  return target.to === "/org/$orgId/routines" && target.search ? target.search.open : null;
}

/** What opening did: moved to a page, opened a dialog over this one, or found nowhere to go. */
export type Opened = "page" | "dialog" | null;

/**
 * Opens a notification in the workspace on screen (`orgId`): "Conectar uma IA" for a ready computer whose agents
 * have no AI (`ai`: the workspace's AI status), else its page, with an agent's help request opening its card.
 * Marking it read is the caller's (the inbox's own action, or the read that fetched it).
 */
export function useNotificationOpener() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const connect = useConnectAi();
  const openDetails = useContext(OpenDetailsContext);
  const openComputer = useOpenComputer();
  return useCallback(
    (n: AppNotification, orgId: string, options: { ai?: AiStatus; replace?: boolean } = {}): Opened => {
      if (connect && opensConnectAi(n, options.ai)) {
        connect.open({ ready: true });
        return "dialog";
      }
      // A help request whose conversation I can't open: the agent's computer, its request and Ajudar in view.
      const computerOf = opensOnComputer(n);
      if (computerOf) {
        openComputer(computerOf);
        return "dialog";
      }
      // An agent skipped several catch-ups as handled: its queue on what it skipped, each with "Responder mesmo assim".
      const agent = n.actors[0];
      if (openDetails && n.kind === "catch_up_closed" && n.count > 1 && agent?.type === "agent") {
        openDetails({ kind: "usage_queue", id: agent.id, tab: "skipped" });
        return "dialog";
      }
      // A device's notice: its page (a phone's, a computer's), or the list where a computer asks to join.
      const device = deviceTarget(n);
      if (device !== null) {
        void navigate(deviceOptions(orgId, device, options.replace ?? false));
        return "page";
      }
      const found = openTarget(n);
      if (!found) return null;
      // A widget of My Home opens on Home (ADR 0135), when this tab knows which board that is.
      const target = homeTarget(found, qc.getQueryData<Dashboard>(keys.dashboardHome(orgId))?.id);
      // A routine's trouble: its details over the page the person is on, its state and fix in view.
      const routineId = routineOf(target);
      if (openDetails && routineId) {
        openDetails({ kind: "routine", id: routineId });
        return "dialog";
      }
      // An agent asked for help in its browser: its card opens there, in control (no page of its own).
      if (n.kind === "browser_handoff" && n.source.handoffId) requestBrowserCard({ handoffId: n.source.handoffId });
      goToTarget(navigate, orgId, target, options.replace ?? false);
      return "page";
    },
    [navigate, qc, connect, openDetails, openComputer],
  );
}

/**
 * The address a notification opens at, for a new tab (Cmd/Ctrl-click, a middle click): its page, or, when it opens
 * a dialog or nothing of its own, the inbox with `?open=`, which opens it there (`OpeningNotification`).
 */
export function useNotificationHref() {
  const router = useRouter();
  return useCallback(
    (n: AppNotification, orgId: string): string => {
      const device = deviceTarget(n);
      if (device !== null) return router.buildLocation(deviceOptions(orgId, device)).href;
      const target = opensOnComputer(n) || n.kind === "computer_ready" ? null : openTarget(n);
      const options = target
        ? targetOptions(orgId, target)
        : ({ to: "/org/$orgId/notifications", params: { orgId }, search: { open: n.id } } as never);
      return router.buildLocation(options).href;
    },
    [router],
  );
}

/**
 * Opens a notification a push named, in the workspace on screen: reads it the way the inbox's "Abrir" marks it
 * (the read answers the whole notification), then goes where the inbox goes. Gone or unreadable: the place the
 * push itself names (`fallbackTarget`), else the inbox.
 */
export function useOpenPushed() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = useNotificationOpener();
  return useCallback(
    async (data: PushOpenData, replace: boolean): Promise<void> => {
      const { orgId, notificationId } = data;
      const n = await api.notifications.read(orgId, notificationId, true).catch(() => null);
      if (n) {
        cacheNotification(qc, orgId, n);
        const ai =
          n.kind === "computer_ready"
            ? await qc
                .fetchQuery({
                  queryKey: keys.aiStatus(orgId),
                  queryFn: () => api.agents.aiStatus(orgId),
                  staleTime: 30_000,
                })
                .catch(() => undefined)
            : undefined;
        // A dialog over the inbox: the inbox first (without `?open`, so a reload doesn't redo it), since any
        // navigation after it would close the dialog (`DetailsHost`).
        const target = openTarget(n);
        const overInbox = replace && ((target && routineOf(target)) || opensOnComputer(n));
        if (overInbox) await goToInbox(navigate, orgId, true);
        const opened = open(n, orgId, { ai, replace });
        if (!overInbox && (opened === null || (opened === "dialog" && replace)))
          void goToInbox(navigate, orgId, replace);
        return;
      }
      const target = fallbackTarget(data);
      if (target) goToTarget(navigate, orgId, target, replace);
      else goToInbox(navigate, orgId, replace);
    },
    [api, qc, navigate, open],
  );
}

/**
 * In the workspace shell: a click on a browser notification while this tab is open (`listenForPushOpens`).
 * One of this workspace opens at once, with no stop at the inbox; one of another workspace goes to that
 * workspace's inbox with `?open=`, which opens it there (`OpeningNotification`).
 */
export function PushOpens() {
  const { org } = useOrg();
  const navigate = useNavigate();
  const openPushed = useOpenPushed();
  useEffect(
    () =>
      setPushOpenHandler((click) => {
        const data = click.data;
        // A push that names no notification: the tab just goes to its address.
        if (!data) return false;
        if (data.orgId !== org.id) {
          void navigate({
            to: "/org/$orgId/notifications",
            params: { orgId: data.orgId },
            search: { open: data.notificationId },
          });
          return true;
        }
        void openPushed(data, false);
        return true;
      }),
    [org.id, navigate, openPushed],
  );
  return null;
}

/**
 * The inbox opened with `?open=<id>` (a click on a browser notification with no tab of the app open, public/sw.js):
 * opens that notification in place of this page, as the inbox would; the page shows loading meanwhile.
 */
export function OpeningNotification({ id }: { id: string }) {
  const { org } = useOrg();
  const openPushed = useOpenPushed();
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (started.current === id) return;
    started.current = id;
    void openPushed({ orgId: org.id, notificationId: id, kind: null }, true);
  }, [id, org.id, openPushed]);
  return <LoadingPage />;
}
