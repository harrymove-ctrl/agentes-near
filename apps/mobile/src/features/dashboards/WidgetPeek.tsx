import { useRefreshWidget, useRemoveWidget, type Widget } from "@agenteschat/client";
import { Link } from "expo-router";
import { useTranslation } from "react-i18next";
import { Alert, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { widgetHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { useAgentLook } from "./hooks";
import { shownWidgetTitle } from "./logic";
import { useWidgetSurface, WidgetCard, type WidgetCardData } from "./WidgetView";

/** The long press's preview: the widget drawn big, as tall as this. */
const PREVIEW_HEIGHT = 360;

/**
 * A widget's card on a board or the home's strip that opens its screen, with iOS's own gestures (ADR 0135): a tap
 * zooms the card into its screen (iOS 18+); a long press lifts it into the system's preview with the widget drawn
 * big, and for whoever edits the board the system's menu under it (Update now, Organize, Remove, confirmed).
 * Tapping the preview opens the widget. Elsewhere (Android) the card just opens it.
 * `board`: the board's route id for Organize (`home` for My Home) and whether it is My Home (Remove's words).
 */
export function WidgetPeek({
  widget: w,
  canEdit,
  board,
  compact = false,
}: {
  widget: Widget;
  canEdit: boolean;
  board: { id: string; home: boolean };
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const look = useAgentLook(w.agentId);
  const surface = useWidgetSurface();
  const refresh = useRefreshWidget(orgId);
  const remove = useRemoveWidget(orgId);
  const href = widgetHref(w.id);
  const data: WidgetCardData = {
    title: w.title,
    kind: w.kind,
    spec: w.spec,
    status: w.status,
    agentId: w.agentId,
    refreshedAt: w.refreshedAt,
    schedule: w.schedule,
    w: compact ? 1 : w.layout.w,
    h: compact ? 1 : w.layout.h,
  };
  if (Platform.OS !== "ios") {
    return <WidgetCard widget={data} compact={compact} onPress={() => router.push(href)} />;
  }
  const shown = shownWidgetTitle(w.title, w.kind, (k) => t(k));
  const updateNow = () =>
    refresh.mutate(w.id, {
      onSuccess: () => toast({ title: t("mobile.dashboards.widget.refreshing", { name: look.name }) }),
      onError: failed,
    });
  // The same words as the widget's own screen (ADR 0135): its routine stops and its history goes.
  const confirmRemove = () =>
    Alert.alert(
      t("widgets.removeConfirm.title", { title: shown }),
      w.schedule === "manual"
        ? t("widgets.removeConfirm.textManual")
        : t("widgets.removeConfirm.textRoutine", { name: look.name || t("channel.unknownAgent") }),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("widgets.removeConfirm.confirm"),
          style: "destructive",
          onPress: () =>
            remove.mutate(w.id, {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("mobile.dashboards.widget.removed") });
              },
              onError: failed,
            }),
        },
      ],
    );
  return (
    <Link href={href} asChild>
      <Link.Trigger withAppleZoom>
        <PeekTrigger widget={data} compact={compact} />
      </Link.Trigger>
      <Link.Preview style={{ width: width - 32, height: PREVIEW_HEIGHT }}>
        {/* The card fills the preview; the surface behind it keeps its corners from showing white. */}
        <View style={[styles.preview, surface]}>
          <WidgetCard big widget={{ ...data, w: 2, h: 2 }} />
        </View>
      </Link.Preview>
      {/* Only for whoever edits the board: someone who only sees it gets the preview alone. */}
      {canEdit ? (
        <Link.Menu>
          <Link.MenuAction icon="arrow.clockwise" onPress={updateNow}>
            {t("widgets.menu.refresh")}
          </Link.MenuAction>
          <Link.MenuAction icon="square.grid.2x2" onPress={() => router.push(`/board-organize/${board.id}`)}>
            {t("widgets.organize.start")}
          </Link.MenuAction>
          <Link.MenuAction icon="trash" destructive onPress={confirmRemove}>
            {board.home ? t("widgets.menu.removeHome") : t("widgets.menu.removeBoard")}
          </Link.MenuAction>
        </Link.Menu>
      ) : null}
    </Link>
  );
}

/**
 * What the long press lifts: the card in a clear box. iOS fills the lifted shape (a rectangle) with the touched
 * view's background, so with the card itself there its gray showed square past the rounded corners; a clear box
 * kept as a real view (`collapsable={false}`, never flattened away) lets the card's own corners show. `onPress`
 * comes from the link (`Link.Trigger` passes it on).
 */
function PeekTrigger({ widget, compact, onPress }: { widget: WidgetCardData; compact: boolean; onPress?: () => void }) {
  return (
    <View collapsable={false} style={styles.trigger}>
      <WidgetCard widget={widget} compact={compact} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { flex: 1 },
  trigger: { flexGrow: 1, backgroundColor: "transparent" },
});
