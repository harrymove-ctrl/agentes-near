import {
  type Dashboard,
  useDashboards,
  useDeleteDashboard,
  useSetHomeDashboard,
  useUpdateDashboard,
} from "@agenteschat/client";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { type IconName, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { type ActionItem, ActionList, goBack, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { type BoardMenuKey, boardMenuKeys, HOME } from "./logic";

interface MenuItem {
  key: BoardMenuKey;
  icon: IconName;
  label: string;
  danger?: boolean;
  run: () => void;
}

/**
 * A board's "…" (ADR 0135): Use on Home or Remove from Home (§18), Organize, Share, Rename, Pin to the top or Unpin,
 * and Delete (with a confirmation), only what the viewer may do. As the routines' menu: the system's action sheet on
 * iOS, the app's own list in a sheet on Android (the screen hosts it: `SheetHostProvider`). Called before the board
 * loads: it offers nothing until then.
 */
export function useBoardMenu(board: Dashboard | undefined) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const sheet = useSheet();
  const update = useUpdateDashboard(orgId);
  const remove = useDeleteDashboard(orgId);
  const list = useDashboards(orgId);
  const setHome = useSetHomeDashboard(orgId);
  if (!board) return { any: false, open: () => {}, label: t("widgets.menu.label") };
  const home = board.kind === "home";
  const chosen = list.data?.homeDashboardId ?? null;
  const onHome = home ? !chosen : chosen === board.id;
  const showOnHome = (id: string | null) =>
    setHome.mutate(id, {
      onSuccess: () => {
        successHaptic();
        if (id) toast({ title: t("dashboards.onHomeDone") });
      },
      onError: failed,
    });
  const title = home ? t("dashboards.home") : board.title;
  const setPinned = (pinned: boolean) =>
    update.mutate(
      { dashboardId: board.id, pinned },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: pinned ? t("mobile.dashboards.pinned") : t("mobile.dashboards.unpinned") });
        },
        onError: failed,
      },
    );
  const confirmDelete = () =>
    Alert.alert(
      t("dashboards.delete.title", { title }),
      t("common.joinSentences", { a: t("dashboards.delete.text"), b: t("common.cantUndo") }),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("dashboards.delete.confirm"),
          style: "destructive",
          onPress: () =>
            remove.mutate(board.id, {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("dashboards.delete.done", { title }) });
                goBack();
              },
              onError: failed,
            }),
        },
      ],
    );
  const all: Record<BoardMenuKey, Omit<MenuItem, "key">> = {
    home: { icon: "home", label: t("dashboards.useOnHome"), run: () => showOnHome(home ? null : board.id) },
    unhome: { icon: "home", label: t("dashboards.stopOnHome"), run: () => showOnHome(null) },
    organize: {
      icon: "list",
      label: t("widgets.organize.start"),
      run: () => router.push(`/board-organize/${home ? HOME : board.id}`),
    },
    share: { icon: "share", label: t("dashboards.share.action"), run: () => router.push(`/board-share/${board.id}`) },
    edit: { icon: "pen", label: t("dashboards.rename"), run: () => router.push(`/board-edit/${board.id}`) },
    pin: { icon: "pin", label: t("dashboards.pinTop"), run: () => setPinned(true) },
    unpin: { icon: "pin", label: t("dashboards.unpin"), run: () => setPinned(false) },
    delete: { icon: "trash", label: t("dashboards.delete.action"), danger: true, run: confirmDelete },
  };
  const items: MenuItem[] = boardMenuKeys(board, onHome).map((key) => ({ key, ...all[key] }));
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
  return { any: items.length > 0, open, label: t("widgets.menu.label") };
}

/** One choice of a pick menu: its word, a second line (an agent's role), and what goes before it on Android. */
export interface PickItem<K extends string> {
  key: K;
  label: string;
  hint?: string | null;
  leading?: ReactNode;
}

/**
 * A pick list from a form row ("Who looks after it", "Format"), in the app's picker on both systems: each choice with
 * what goes before it (a kind's glyph, a face), its second line, and the check on the current one.
 */
export function usePickMenu() {
  return function open<K extends string>(
    title: string,
    items: readonly PickItem<K>[],
    value: K | null,
    onPick: (key: K) => void,
  ) {
    if (items.length === 0) return;
    void pickOne({
      title,
      value,
      options: items.map((i) => ({
        key: i.key,
        label: i.label,
        ...(i.hint ? { sub: i.hint } : {}),
        ...(i.leading ? { leading: { kind: "node" as const, node: i.leading } } : {}),
      })),
    }).then((key) => {
      const item = items.find((i) => i.key === key);
      if (item) onPick(item.key);
    });
  };
}
