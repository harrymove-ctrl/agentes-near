import {
  type Dashboard,
  dashboardAccessOf,
  useDashboard,
  useMembers,
  useRoles,
  useShareDashboard,
} from "@agenteschat/client";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedHeader, GroupedList, GroupedRow, Locked, Text, useTheme, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { Face } from "../shared/Face";
import { useMeId, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import {
  type AudienceDraft,
  accessPerson,
  audienceChanged,
  audienceDraftOf,
  audienceReady,
  roleNamesOf,
  shareInputOf,
} from "./logic";
import { AudienceFields } from "./parts";

/**
 * Share a dashboard, pushed (ADR 0135): who sees it (the whole workspace, some roles, only you), who edits it (whoever
 * sees it, only you and admins, or some roles), what showing it exposes, and who has access with these choices,
 * person by person. "Save" in the bar.
 */
export function ShareScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const q = useDashboard(useOrgId(), id);
  if (!q.data) {
    return (
      <View style={[styles.screen, { backgroundColor: c.grouped }]}>
        <PushedHeader title={t("dashboards.share.action")} solid={false} grouped />
        <View style={styles.center}>
          {q.isLoading ? (
            <ActivityIndicator color={c.muted} />
          ) : (
            <Text tone="muted" style={styles.centerText}>
              {t("dashboards.errors.notFound")}
            </Text>
          )}
        </View>
      </View>
    );
  }
  return (
    <SheetHostProvider>
      <Form key={q.data.id} board={q.data} />
    </SheetHostProvider>
  );
}

function Form({ board }: { board: Dashboard }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const meId = useMeId();
  const toast = useToast();
  const failed = useFailed();
  const members = useMembers(orgId);
  const roles = useRoles(orgId);
  const share = useShareDashboard(orgId);
  const [draft, setDraft] = useState<AudienceDraft>(() => audienceDraftOf(board));
  const roleList = roles.data?.roles ?? [];
  const people = useMemo(() => {
    const list = [...(members.data ?? [])].sort(
      (a, b) => Number(b.userId === meId) - Number(a.userId === meId) || a.name.localeCompare(b.name),
    );
    return list.map((m) => ({
      member: m,
      access: dashboardAccessOf(accessPerson(m, roleList), {
        kind: board.kind,
        audience: draft.audience,
        roleIds: draft.roleIds,
        editPolicy: draft.editPolicy,
        editRoleIds: draft.editRoleIds,
        ownerUserId: board.ownerUserId,
      }),
    }));
  }, [members.data, meId, roleList, board.kind, board.ownerUserId, draft]);
  const ready = audienceReady(draft) && !share.isPending && board.kind === "board";
  const save = () => {
    if (!ready) return;
    if (!audienceChanged(board, draft)) {
      goBack();
      return;
    }
    share.mutate(
      { dashboardId: board.id, ...shareInputOf(draft) },
      {
        onSuccess: () => {
          successHaptic();
          const title = board.title;
          toast({
            title:
              draft.audience === "workspace"
                ? t("dashboards.share.nowWorkspace", { title })
                : draft.audience === "private"
                  ? t("dashboards.share.nowPrivate", { title })
                  : t("dashboards.share.nowRoles", { title, roles: roleNamesOf(draft.roleIds, roleList).join(", ") }),
          });
          goBack();
        },
        onError: failed,
      },
    );
  };
  const accessWord = (access: "edits" | "sees" | "none") =>
    access === "edits"
      ? t("dashboards.share.edits")
      : access === "sees"
        ? t("dashboards.share.sees")
        : t("dashboards.share.none");
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("dashboards.share.action")}
        subtitle={board.title}
        solid={false}
        grouped
        action={{ label: t("dashboards.share.save"), disabled: !ready, onPress: save }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        {board.kind === "home" ? (
          <Text variant="footnote" tone="muted" style={styles.note}>
            {t("dashboards.errors.homeFixed")}
          </Text>
        ) : (
          <>
            <Locked when={share.isPending}>
              <AudienceFields draft={draft} onChange={setDraft} members={members.data?.length ?? 0} />
            </Locked>
            <GroupedHeader>{t("dashboards.share.access")}</GroupedHeader>
            <GroupedList>
              {people.map(({ member: m, access }) => (
                <GroupedRow
                  key={m.userId}
                  leading={<Face who={{ type: "person", id: m.userId }} size={28} live={false} />}
                  label={m.userId === meId ? t("dashboards.share.you", { name: m.name }) : m.name}
                  {...(m.role === "owner" ? { sub: t("dashboards.share.owner") } : {})}
                  value={accessWord(access)}
                  faint={access === "none"}
                />
              ))}
            </GroupedList>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  centerText: { textAlign: "center" },
  note: { paddingHorizontal: 16, paddingTop: 16 },
});
