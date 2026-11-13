import { useWikiBulk, useWikiTrash, type WikiBulkTarget } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, Card, EmptyState, Icon, Locked, Row, SCREEN_X, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { ActionList, PushedHeader, successHaptic, Tile } from "../shared/parts";

/** The wiki's Lixeira on the phone. */
export const openWikiTrash = () => router.push("/wiki-trash");
/** Which agents read the chosen pages. */
export const openWikiAgents = (ids: string[]) =>
  router.push({ pathname: "/wiki-agents", params: { ids: ids.join(",") } });

/**
 * "Apagar" for many pages (a folder, an import or a selection): an alert that says how many and where they go, then
 * one call. `title` is the alert's question, already with the count.
 */
export function useWikiBulkDelete() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const bulk = useWikiBulk(orgId);
  const ask = (target: WikiBulkTarget, count: number, title: string, onDone?: () => void) =>
    Alert.alert(title, t("wiki.bulk.deleteText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("wiki.bulk.deleteGo", { count }),
        style: "destructive",
        onPress: () =>
          bulk.mutate(
            { type: "delete", target },
            {
              onSuccess: (r) => {
                successHaptic();
                toast({
                  title: [
                    t("wiki.bulk.deleted", { count: r.count }),
                    r.kept ? t("wiki.bulk.kept", { count: r.kept }) : "",
                  ]
                    .filter(Boolean)
                    .join(" "),
                });
                onDone?.();
              },
              onError: failed,
            },
          ),
      },
    ]);
  return { ask, pending: bulk.isPending };
}

/**
 * The Lixeira: pages deleted in the last 30 days. A tap chooses a page; the bar restores the chosen ones or deletes
 * them for good, and "Esvaziar" empties it, each after an alert that says how many.
 */
export function WikiTrashScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { orgId, org } = useOrg();
  const toast = useToast();
  const failed = useFailed();
  const trash = useWikiTrash(orgId);
  const bulk = useWikiBulk(orgId);
  const writes = can(org, "edit_wiki");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const pages = trash.data ?? [];
  const busy = bulk.isPending;
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const restore = () =>
    bulk.mutate(
      { type: "restore", ids: [...picked] },
      {
        onSuccess: (r) => {
          setPicked(new Set());
          successHaptic();
          const why = r.failed[0]?.code === "wiki.restore_slug_taken" ? t("errors.wiki.restoreSlugTaken") : "";
          toast({
            title: r.count ? t("wiki.trash.restored", { count: r.count }) : why,
            ...(r.failed.length ? { icon: "x" as const, subtitle: why } : {}),
          });
        },
        onError: failed,
      },
    );
  const purge = (ids?: string[]) =>
    Alert.alert(t("wiki.trash.emptyTitle", { count: ids ? ids.length : pages.length }), t("wiki.trash.emptyText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: ids ? t("wiki.trash.purge") : t("wiki.trash.empty"),
        style: "destructive",
        onPress: () =>
          bulk.mutate(
            { type: "purge", ids },
            {
              onSuccess: (r) => {
                setPicked(new Set());
                toast({ title: t("wiki.trash.purged", { count: r.count }) });
              },
              onError: failed,
            },
          ),
      },
    ]);
  return (
    <View style={styles.fill}>
      <PushedLargeTitle title={t("wiki.trash.title")} bottomInset={picked.size ? 110 : 24}>
        <Text variant="subhead" tone="muted" style={styles.lead}>
          {t("wiki.trash.text")}
        </Text>
        {trash.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
        {trash.isError && !trash.data ? (
          <View style={styles.center}>
            <Text tone="muted">{t("common.loadFailed")}</Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.common.retry")}
              onPress={() => void trash.refetch()}
            />
          </View>
        ) : null}
        {trash.isSuccess && pages.length === 0 ? <EmptyState icon="trash" title={t("wiki.trash.none")} /> : null}
        {pages.length > 0 ? (
          <Locked when={busy}>
            <Card>
              {pages.map((p, i) => {
                const on = picked.has(p.id);
                return (
                  <Row
                    key={p.id}
                    divider={i > 0}
                    leading={<Tile icon="file" />}
                    title={p.title}
                    subtitle={[
                      p.folder || t("wiki.root"),
                      p.deletedAt
                        ? t("wiki.trash.deletedWhen", { when: relativeTime(t, i18n.language, p.deletedAt) })
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {...(writes
                      ? {
                          meta: <Icon name={on ? "checkc" : "circle"} size={20} color={on ? c.ink : c.faint} />,
                          onPress: () => toggle(p.id),
                        }
                      : {})}
                  />
                );
              })}
            </Card>
            {writes ? (
              <View style={styles.empty}>
                <Button variant="secondary" size="sm" label={t("wiki.trash.empty")} onPress={() => purge()} />
              </View>
            ) : null}
          </Locked>
        ) : null}
      </PushedLargeTitle>
      {picked.size > 0 ? (
        <View style={[styles.bar, { paddingBottom: insets.bottom + 12, backgroundColor: c.bg, borderColor: c.line }]}>
          <Button
            variant="secondary"
            label={t("wiki.trash.purge")}
            disabled={busy}
            onPress={() => purge([...picked])}
          />
          <View style={styles.grow}>
            <Button
              variant="primary"
              wide
              label={t("wiki.trash.restoreMany", { count: picked.size })}
              loading={busy}
              disabled={busy}
              onPress={restore}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Which agents read the chosen pages: every agent, or the ones ticked (none is a choice too). People's access stays. */
export function WikiAgentsScreen({ ids }: { ids: string[] }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useFailed();
  const bulk = useWikiBulk(orgId);
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const save = () =>
    bulk.mutate(
      { type: "agents", ids, agentIds: all ? null : [...picked] },
      {
        onSuccess: (r) => {
          successHaptic();
          toast({ title: t("wiki.bulk.agentsSaved", { count: r.count }) });
          router.back();
        },
        onError: failed,
      },
    );
  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("wiki.bulk.agentsTitle", { count: ids.length })}
        solid={false}
        action={{ label: t("common.save"), onPress: save, disabled: bulk.isPending }}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <Locked when={bulk.isPending}>
          <Text variant="footnote" tone="faint" style={styles.lead}>
            {t("wiki.bulk.agentsText")}
          </Text>
          <ActionList
            items={[{ key: "all", label: t("wiki.audienceAgentsAll"), checked: all, onPress: () => setAll(!all) }]}
          />
          {!all ? (
            <Card>
              {dir.agents.map((a, i) => {
                const on = picked.has(a.id);
                return (
                  <Row
                    key={a.id}
                    divider={i > 0}
                    leading={<Face who={{ type: "agent", id: a.id }} size={30} live={false} />}
                    title={a.name}
                    meta={<Icon name={on ? "checkc" : "circle"} size={20} color={on ? c.ink : c.faint} />}
                    onPress={() => {
                      const next = new Set(picked);
                      if (on) next.delete(a.id);
                      else next.add(a.id);
                      setPicked(next);
                    }}
                  />
                );
              })}
            </Card>
          ) : null}
        </Locked>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  lead: { paddingHorizontal: SCREEN_X, paddingBottom: 8 },
  loading: { marginVertical: 24 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  content: { paddingTop: 8, paddingBottom: 40, gap: 12 },
  empty: { alignItems: "center", paddingTop: 16 },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
