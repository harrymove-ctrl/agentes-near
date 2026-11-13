import { type DashboardSummary, dashboardGroups, useDashboards } from "@agenteschat/client";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, EmptyState, GroupedHeader, GroupedList, IconButton, SkeletonList, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { boardHref } from "../links/logic";
import { useOpenDm } from "../new/useOpenDm";
import { useEmptyLook } from "../shared/FirstUse";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { HOME } from "./logic";
import { BoardRow, useBoardByline } from "./parts";

/** Opens "New dashboard". */
export const openNewBoard = () => router.push("/board-new");

/**
 * Dashboards, pushed from "See all" over the home's widgets (ADR 0135; the tab bar stays as it is): My Home on top (the
 * person's own widgets), then the boards of the whole workspace, of the person's roles and only theirs, each with a
 * thumbnail of its widgets (the one on Início says "On Home"). A row pushes the board; "+" in the bar makes a new one.
 * With only My Home, the right hand under it says what a dashboard is, with Novo painel and an ask to it, as the
 * web's: the bar's "+" steps aside, one way in.
 */
export function DashboardsScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const list = useDashboards(orgId);
  const pull = usePullRefresh(list.refetch);
  const byline = useBoardByline();
  const groups = dashboardGroups(list.data?.dashboards ?? []);
  // The board on Início ("Use on Home", ADR 0135 §18) says so first on its line.
  const onHome = list.data?.homeDashboardId ?? null;
  const any = groups.workspace.length + groups.roles.length + groups.mine.length > 0;
  const first = list.data !== undefined && !any;
  const look = useEmptyLook();
  const lodi = rightHandOf(useDirectory().agents);
  const { org } = useOrg();
  const openDm = useOpenDm();
  const row = (board: DashboardSummary) => (
    <BoardRow
      key={board.id}
      board={board}
      title={board.title}
      sub={board.id === onHome ? [t("dashboards.onHome"), byline(board)].filter(Boolean).join(" · ") : byline(board)}
      locked={board.audience !== "workspace"}
      onPress={() => router.push(boardHref(board.id))}
    />
  );
  const group = (title: string, boards: DashboardSummary[]) =>
    boards.length > 0 ? (
      <View key={title}>
        <GroupedHeader>{title}</GroupedHeader>
        <GroupedList>{boards.map(row)}</GroupedList>
      </View>
    ) : null;
  return (
    <PushedLargeTitle
      title={t("dashboards.title")}
      right={first ? undefined : <IconButton icon="plus" label={t("dashboards.new")} onPress={openNewBoard} />}
      grouped
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <View style={styles.in}>
        <GroupedList>
          <BoardRow
            board={{ thumbs: list.data?.home?.thumbs ?? [] }}
            title={t("dashboards.home")}
            sub={t("mobile.dashboards.homeRow")}
            locked={false}
            onPress={() => router.push(boardHref(HOME))}
          />
        </GroupedList>
        {list.isLoading ? (
          // Loading: the rows' own shape, never a spinner.
          <SkeletonList rows={4} />
        ) : list.isError && !list.data ? (
          <View style={styles.center}>
            <Text tone="muted" style={styles.centerText}>
              {t("mobile.dashboards.loadFailed")}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.common.retry")}
              onPress={() => void list.refetch()}
            />
          </View>
        ) : any ? (
          <>
            {group(t("dashboards.groups.workspace"), groups.workspace)}
            {group(t("dashboards.groups.roles"), groups.roles)}
            {group(t("dashboards.groups.mine"), groups.mine)}
          </>
        ) : first ? (
          <EmptyState
            size="page"
            agent={look}
            title={t("dashboards.first.title")}
            subtitle={t("dashboards.first.text")}
            action={
              <View style={styles.firstActs}>
                <Button variant="primary" size="md" label={t("dashboards.new")} onPress={openNewBoard} />
                {lodi && mayAsk(org, lodi) ? (
                  <Button
                    variant="secondary"
                    size="md"
                    label={t("common.askAgent", agentGrammar(lodi.name))}
                    onPress={() => openDm({ agentId: lodi.id }, { compose: true, text: t("dashboards.first.ask") })}
                  />
                ) : null}
              </View>
            }
          />
        ) : null}
      </View>
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  in: { paddingHorizontal: 16, paddingTop: 4 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  // Two buttons that wrap to a second line before they leave the screen.
  firstActs: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, flexShrink: 1 },
});
