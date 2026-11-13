import { type ArtifactFilters, useArtifacts } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  IconButton,
  SearchField,
  SectionHeader,
  SkeletonList,
  Text,
  useReducedMotion,
} from "@/ui";
import { FirstUse } from "../shared/FirstUse";
import { useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { DriveCard } from "./DriveCard";
import { DRIVE_TYPES, type DriveDaySection, type DriveType, driveSections, gridRows, matchesType } from "./logic";
import { useDriveUpload } from "./useDriveUpload";

/** Cards shown at first and added by "Mostrar mais" (each card loads its own preview). */
const PAGE = 24;

/**
 * Drive, pushed from Você: the search, the type chips (Tudo,
 * Documentos, Imagens, Tabelas, Diffs), and everything the person can see grouped by day (Hoje, Esta semana,
 * then by month) in a two-column grid of real previews, and a file sent from the phone. A card opens the file viewer. `highlightId`: the
 * item "Ver no Drive" came from, outlined.
 */
export function DriveScreen({ highlightId = null }: { highlightId?: string | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const when = useWhen();
  const [q, setQ] = useState("");
  const [type, setType] = useState<DriveType>("all");
  const [shown, setShown] = useState(PAGE);
  const search = useDeferredValue(q.trim());
  const filters = useMemo<ArtifactFilters>(() => (search ? { q: search } : {}), [search]);
  const list = useArtifacts(orgId, filters);
  const pull = usePullRefresh(list.refetch);
  const all = useMemo(() => (list.artifacts ?? []).filter((a) => matchesType(a, type)), [list.artifacts, type]);
  // Newest first; the highlighted item is always among those shown.
  const sections = useMemo(() => {
    const sorted = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const at = highlightId ? sorted.findIndex((a) => a.id === highlightId) : -1;
    return driveSections(sorted.slice(0, Math.max(shown, at + 1)));
  }, [all, shown, highlightId]);
  const label = (s: DriveDaySection) =>
    s.label.kind === "month"
      ? new Intl.DateTimeFormat(when.locale, {
          month: "long",
          ...(s.label.year !== new Date().getFullYear() ? { year: "numeric" as const } : {}),
        })
          .format(new Date(s.label.year, s.label.month, 1))
          .replace(/^./, (x) => x.toLocaleUpperCase())
      : t(`mobile.drive.section.${s.label.kind}`);
  const total = all.length;
  const mayUpload = can(useOrg().org, "upload_files");
  const uploader = useDriveUpload(list.refetch);
  const clear = () => {
    setQ("");
    setType("all");
  };
  const visible = sections.reduce((n, s) => n + s.items.length, 0);
  // Past what loaded, "Mostrar mais" brings the server's next page of files.
  const more = () => {
    setShown((n) => n + PAGE);
    if (visible + PAGE > total && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  };
  // The grid fades in over the spinner, and a day that comes or goes with a filter or "Show more" fades while the rest
  // slide into place; what shows when the screen opens doesn't fade card by card.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  return (
    <PushedLargeTitle
      title={t("mobile.drive.title")}
      {...(mayUpload
        ? {
            right: (
              <IconButton icon="plus" label={t("files.upload")} disabled={uploader.busy} onPress={uploader.pick} />
            ),
          }
        : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.drive.search")}
          accessibilityLabel={t("mobile.drive.search")}
          returnKeyType="search"
        />
      </View>
      <Filters
        items={DRIVE_TYPES.map((k) => ({ key: k, label: t(`mobile.drive.type.${k}`) }))}
        value={type}
        onChange={(k) => {
          setType(k as DriveType);
          setShown(PAGE);
        }}
      />
      {list.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : list.isError && !list.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.drive.loadFailed")}
          </Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void list.refetch()} />
        </View>
      ) : total === 0 && !list.hasNextPage ? (
        search || type !== "all" ? (
          <EmptyState
            size="inline"
            title={t("mobile.drive.noResults")}
            action={<Button variant="secondary" size="sm" label={t("filters.clearAll")} onPress={clear} />}
          />
        ) : (
          <FirstUse
            place="drive"
            acts={mayUpload}
            label={t("files.upload")}
            busy={uploader.busy}
            onPress={uploader.pick}
          />
        )
      ) : (
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            {sections.map((s) => (
              <Animated.View key={s.key} {...fade} layout={layout}>
                <SectionHeader title={label(s)} count={s.items.length} />
                <View style={styles.grid}>
                  {gridRows(s.items).map((row) => (
                    <View key={row.map((a) => a.id).join(":")} style={styles.row}>
                      {row.map((a) => (
                        <DriveCard key={a.id} artifact={a} highlighted={a.id === highlightId} />
                      ))}
                      {row.length === 1 ? <View style={styles.spacer} /> : null}
                    </View>
                  ))}
                </View>
              </Animated.View>
            ))}
            {visible < total || list.hasNextPage ? (
              <Animated.View {...fade} layout={layout} style={styles.more}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={t("mobile.drive.more")}
                  loading={list.isFetchingNextPage}
                  onPress={more}
                />
              </Animated.View>
            ) : null}
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 10 },
  grid: { paddingHorizontal: 16, gap: 16 },
  row: { flexDirection: "row", gap: 12 },
  spacer: { flex: 1 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  more: { alignItems: "center", paddingTop: 20 },
});
