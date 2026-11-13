import {
  type Routine,
  type RoutineTarget,
  useChannels,
  useDms,
  useMailAccounts,
  useRoutineAction,
} from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { relativeTime, toYmd, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type RoutineFix, routineChannelOf, runPixels, type Words } from "@agenteschat/client/lib/routine-view";
import { browserTimezone, onceParts, routineHookUrl, timezoneName } from "@agenteschat/client/lib/routines";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { type IconName, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { routineHref, widgetHref } from "../links/logic";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { type ActionItem, ActionList, copyText, errorHaptic, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { everyMinutes, isInbox, isRunning, nextLine, RUN_SLOTS, routineTitle, runCaption, toastParts } from "./logic";
import { fromApiRule, nextLabel, ruleSentence } from "./rule";

/** Rotinas' words and actions, shared by the list, a routine's screen and the form. */

/** A routine's form to edit it ("Nova rotina"'s screen, with the routine). */
export const editRoutineHref = (id: string) => `/routines/new?edit=${id}`;

/** Says the routine's words (`lib/routine-view`): its key and values, else its fallback key. */
export function useSay() {
  const { t } = useTranslation();
  return useCallback(
    (w: Words) => {
      const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
      return tt(w.key, { ...w.values, ...(w.fallback ? { defaultValue: tt(w.fallback) } : {}) });
    },
    [t],
  );
}

/** My time zone: my profile's in this workspace, else the phone's. */
export function useMyZone(fallback = "UTC"): string {
  const dir = useDirectory();
  const meId = useMeId();
  return (meId ? dir.memberById.get(meId)?.timezone : null) || browserTimezone() || fallback;
}

/** "Quando" in words, in the routine's zone (the zone shows only when it isn't mine). */
export function useWhenText() {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const mailboxes = useMailAccounts(orgId);
  const myZone = useMyZone();
  return useCallback(
    (r: Routine) => {
      if (r.trigger.type === "email") {
        const { accountId, folder } = r.trigger;
        const address = mailboxes.data?.find((a) => a.id === accountId)?.address ?? t("mail.routine.unknownMailbox");
        return folder && !isInbox(folder)
          ? t("mail.routine.whenFolder", { address, folder })
          : t("mail.routine.when", { address });
      }
      if (r.trigger.type === "event") return t(`routines.event.${r.trigger.event}`);
      if (r.trigger.type === "webhook") return t("routines.webhook.when");
      if (r.trigger.type === "connector") {
        const to = r.trigger.filter.to;
        return to ? t("mail.routine.when", { address: to }) : t("mail.routine.whenMillionSend");
      }
      const zone = r.trigger.timezone || "UTC";
      const zoneNote = zone !== myZone ? ` (${timezoneName(zone, i18n.language)})` : "";
      if (r.trigger.type === "once")
        return t("routines.once", { ...onceParts(i18n.language, r.trigger.at, zone), zone: zoneNote });
      const every = everyMinutes(r.trigger.cron);
      const sentence = r.trigger.rule
        ? ruleSentence(t, i18n.language, fromApiRule(r.trigger.rule, toYmd(new Date())), new Date(), false)
        : every
          ? t("recurrence.s.minutely", { count: every })
          : r.trigger.description;
      return `${sentence}${zoneNote}`;
    },
    [t, i18n.language, mailboxes.data, myZone],
  );
}

/** "Próxima em 10 min" (within a day), else "Próxima: sex 16 out, 10:00"; a one-off, an event, a pause. */
export function useNextText() {
  const { t, i18n } = useTranslation();
  return useCallback(
    (r: Routine, now: Date): string => {
      const n = nextLine(r, now);
      switch (n.kind) {
        case "running":
          return t("routines.runningNow");
        case "fired":
          return t("routines.firedAt", { when: whenAt(t, i18n.language, n.at, now) });
        case "canceled":
          return t("routines.canceled");
        case "paused":
          return t("routines.paused");
        case "email":
          return n.week > 0 ? t("mail.routine.thisWeek", { count: n.week }) : t("mail.routine.waiting");
        case "event":
          return n.week > 0 ? t("routines.eventThisWeek", { count: n.week }) : t("routines.waitingEvent");
        case "webhook":
          return n.week > 0 ? t("routines.eventThisWeek", { count: n.week }) : t("routines.webhook.waiting");
        case "none":
          return "";
        case "soon":
          return t("routines.nextSoon");
        case "minutes":
          return t("routines.nextIn", { when: t("format.inMinutes", { count: n.minutes }) });
        case "hours":
          return t("routines.nextIn", {
            when: n.m ? t("routines.hoursMinutes", { h: n.h, m: n.m }) : t("format.inHours", { count: n.h }),
          });
        case "at":
          return t("routines.next", { when: nextLabel(i18n.language, n.iso) });
      }
    },
    [t, i18n.language],
  );
}

/** The runs as words: the strip's caption ("Respondeu há 2 h") and what a screen reader hears for it. */
export function useRunWords() {
  const { t, i18n } = useTranslation();
  return useMemo(
    () => ({
      caption: (r: Routine, now: Date) => {
        const c = runCaption(r);
        switch (c.kind) {
          case "running":
            return t("routines.runningNow");
          case "never":
            return t("routines.neverRan");
          case "silentOf":
            return t("routines.silentOf", { count: c.count, total: c.total });
          case "stopped":
            return t("routines.lastRun.stopped", { when: relativeTime(t, i18n.language, c.at, now) });
          case "last":
            return t(`routines.lastRun.${c.status}`, { when: relativeTime(t, i18n.language, c.at, now) });
        }
      },
      label: (r: Routine) => {
        const runs = runPixels(r.recentRuns).slice(0, RUN_SLOTS);
        if (runs.length === 0) return t("routines.stripNone");
        return t("routines.stripLabel", {
          list: runs
            .map((x) => `${whenAt(t, i18n.language, x.at)}: ${t(`routines.statusWord.${x.status}`)}`)
            .join("; "),
        });
      },
    }),
    [t, i18n.language],
  );
}

/** Where it delivers, short: "#produto", "na DM com a Infra", "no #produto (thread)", "Drive". */
export function useTargetLabel() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  return useCallback(
    (target: RoutineTarget) => {
      if (target.type === "channel") {
        const c = channels.data?.find((x) => x.id === target.channelId);
        return c ? `#${c.name}` : "#";
      }
      // From the chat: "na DM com o Dev", "no #produto (thread)".
      if (target.type === "conversation") {
        const dm = dms.data?.find((d) => d.channelId === target.channelId);
        if (dm) return t("routines.inDm", agentGrammar(dm.with.name));
        const c = channels.data?.find((x) => x.id === target.channelId);
        if (!c) return t("routines.inConversation");
        return target.threadId
          ? t("routines.inThread", { channel: c.name })
          : t("routines.inChannel", { channel: c.name });
      }
      // A widget's own routine (ADR 0135): it redoes its widget, with no message.
      if (target.type === "widget") return t("mobile.dashboards.routineTarget");
      return target.type === "dm" ? t("routines.target.dmShort") : t("routines.target.artifactShort");
    },
    [t, channels.data, dms.data],
  );
}

/**
 * A failed write: "Não deu certo", with the server's reason in the person's words when it is a known one, and the
 * error haptic, so a write that didn't take is felt as well as read.
 */
export function useFailed() {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    (error: unknown) => {
      errorHaptic();
      const known = knownErrorText(t, error);
      toast({ title: t("mobile.app.failed"), ...(known ? { subtitle: known } : {}), icon: "x" });
    },
    [t, toast],
  );
}

/** Pause, resume, run, stop and the one-tap fixes: one place for the toasts they say (as the web's). */
export function useRoutineControls(r: Routine) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useFailed();
  const action = useRoutineAction(orgId);
  const running = isRunning(r);
  const say = (text: string) => toast({ ...toastParts(text), agentId: r.agentId });
  return {
    action,
    /** `onError`: the switch goes back to what it showed. */
    setActive: (active: boolean, onError?: () => void) =>
      action.mutate(
        { type: "active", id: r.id, active },
        {
          onSuccess: () =>
            say(t(active ? "routines.resumedToast" : running ? "routines.pausedRunningToast" : "routines.pausedToast")),
          onError: (error) => {
            onError?.();
            failed(error);
          },
        },
      ),
    run: () => action.mutate({ type: "run", id: r.id }, { onSuccess: successHaptic, onError: failed }),
    stop: () =>
      action.mutate(
        { type: "stop", id: r.id },
        {
          onSuccess: () =>
            say(t(r.state === "usage_paused" ? "routines.usagePause.canceledToast" : "routines.stoppedToast")),
          onError: failed,
        },
      ),
    continueUsage: () =>
      action.mutate(
        { type: "continueUsage", id: r.id },
        {
          onSuccess: (saved) =>
            (saved as Routine).state !== "usage_paused" && say(t("routines.usagePause.continuedToast")),
          onError: failed,
        },
      ),
    fix: (fix: RoutineFix) => {
      const channelId = routineChannelOf(r.target);
      if (fix === "add_agent" && channelId)
        action.mutate(
          { type: "addAgent", id: r.id, agentId: r.agentId, channelId },
          {
            onSuccess: () => say(t("routines.fix.addedToast", { name: dir.nameOf({ type: "agent", id: r.agentId }) })),
            onError: failed,
          },
        );
      else if (fix === "take_over")
        action.mutate(
          { type: "takeOver", id: r.id },
          { onSuccess: () => say(t("routines.fix.takenToast")), onError: failed },
        );
      else
        action.mutate(
          { type: "active", id: r.id, active: true },
          { onSuccess: () => say(t("routines.resumedToast")), onError: failed },
        );
    },
  };
}

interface MenuItem {
  key: string;
  icon: IconName;
  label: string;
  danger?: boolean;
  run: () => void;
}

/**
 * The routine's "…": Editar, Ver execuções (from the list), Duplicar, Copiar URL do webhook and Apagar (with a
 * confirmation), only what the viewer may do. iOS shows the system's action sheet; Android's alert takes three
 * buttons at most, so there it is the app's own list in a sheet (the screen hosts it: `SheetHostProvider`).
 * `onDeleted`: after Apagar worked (a routine's screen goes back).
 */
export function useRoutineMenu(r: Routine, from: "list" | "screen", onDeleted?: () => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const failed = useFailed();
  const sheet = useSheet();
  const action = useRoutineAction(useOrgId());
  const title = routineTitle(r);
  const remove = () =>
    Alert.alert(
      t("routines.deleteTitle", { name: title }),
      t("common.joinSentences", {
        a: isRunning(r) ? t("routines.deleteBodyRunning") : t("routines.deleteBody"),
        b: t("common.cantUndo"),
      }),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("routines.deleteConfirm"),
          style: "destructive",
          onPress: () =>
            action.mutate(
              { type: "delete", id: r.id },
              {
                onSuccess: () => {
                  successHaptic();
                  toast({ title: t("routines.deleted") });
                  onDeleted?.();
                },
                onError: failed,
              },
            ),
        },
      ],
    );
  const duplicate = () =>
    action.mutate(
      { type: "duplicate", id: r.id, name: t("routines.copyName", { name: r.name }) },
      {
        onSuccess: (copy) => {
          const name = (copy as Routine | undefined)?.name ?? r.name;
          toast({ ...toastParts(t("routines.duplicated", { name })), agentId: r.agentId });
        },
        onError: failed,
      },
    );
  const hookUrl = routineHookUrl(r);
  const copyWebhook = async () => {
    const ok = await copyText(hookUrl ?? "");
    toast(ok ? { title: t("routines.webhookCopied") } : { title: t("mobile.app.failed"), icon: "x" });
  };
  const items: MenuItem[] = [];
  // A widget's routine is changed from its widget (ADR 0135): "Open widget" stands for Edit, and it isn't duplicated.
  const widget = r.target.type === "widget" ? r.target : null;
  if (widget)
    items.push({
      key: "widget",
      icon: "chart",
      label: t("widgets.notice.openWidget"),
      run: () => router.push(widgetHref(widget.widgetId, widget.dashboardId)),
    });
  else if (r.canManage)
    items.push({
      key: "edit",
      icon: "pen",
      label: t("routines.edit"),
      run: () => router.push(editRoutineHref(r.id)),
    });
  // Everyone sees the runs ("Ver execuções" opens the routine's screen).
  if (from === "list")
    items.push({
      key: "runs",
      icon: "list",
      label: t("routines.runs"),
      run: () => router.push(routineHref(r.id)),
    });
  if (r.canManage && !widget)
    items.push({ key: "duplicate", icon: "copy", label: t("routines.duplicate"), run: duplicate });
  if (r.canManage && hookUrl)
    items.push({
      key: "webhook",
      icon: "share",
      label: t("routines.copyWebhook"),
      run: () => void copyWebhook(),
    });
  if (r.canManage) items.push({ key: "delete", icon: "x", label: t("routines.delete"), danger: true, run: remove });
  const open = () => {
    if (items.length === 0) return;
    if (Platform.OS === "ios") {
      const danger = items.findIndex((i) => i.danger);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title,
          options: [...items.map((i) => i.label), t("mobile.common.cancel")],
          cancelButtonIndex: items.length,
          ...(danger >= 0 ? { destructiveButtonIndex: danger } : {}),
        },
        (i) => items[i]?.run(),
      );
      return;
    }
    const list: ActionItem[] = items.map((i) => ({
      key: i.key,
      icon: i.icon,
      label: i.label,
      ...(i.danger ? { danger: true } : {}),
      onPress: () => {
        sheet.close();
        i.run();
      },
    }));
    sheet.open(<ActionList items={list} />);
  };
  return { open, any: items.length > 0, label: t("routines.more", { name: title }) };
}
