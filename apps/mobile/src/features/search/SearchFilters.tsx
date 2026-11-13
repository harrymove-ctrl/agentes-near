import { type SearchHit, useSearch } from "@agenteschat/client";
import { hitText } from "@agenteschat/client/lib/media";
import {
  groupHitsByPlace,
  SEARCH_HAS,
  SEARCH_OPS,
  SEARCH_SORTS,
  type SearchChip,
  type SearchDirectory,
  type SearchOp,
  type SearchSort,
  type SearchWords,
  searchChipKey,
  searchChipLabel,
  searchFilterInput,
  searchTerms,
  suggestActors,
  suggestPlaces,
  typingOperator,
} from "@agenteschat/client/lib/search-filters";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import {
  Button,
  EmptyState,
  Filters,
  Icon,
  PressScale,
  SCREEN_X,
  SectionHeader,
  SkeletonList,
  Text,
  TOOL_H,
  useReducedMotion,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { Face } from "../shared/Face";
import { useColors, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { ActionList, Tile } from "../shared/parts";
import { hitHref } from "./logic";

/** One size for every result's face or tile, in the search tab and in a conversation's search. */
export const RESULT_LEAD = 32;

const CHIP_IN = FadeIn.duration(160);
const CHIP_OUT = FadeOut.duration(120);

/** The filters on the box (ADR 0123): each a pill with its ×. */
export function FilterChips({ chips, onRemove }: { chips: SearchChip[]; onRemove: (chip: SearchChip) => void }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  // A filter added or taken off while the box shows fades and the others slide; those there when it mounts just show.
  const motion = reduced ? {} : { entering: CHIP_IN, exiting: CHIP_OUT, layout: LinearTransition };
  return (
    <LayoutAnimationConfig skipEntering skipExiting>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.chips}
      >
        {chips.map((chip) => {
          const label = searchChipLabel(t, i18n.language, chip);
          return (
            <Animated.View key={searchChipKey(chip)} {...motion}>
              <PressScale
                onPress={() => onRemove(chip)}
                accessibilityRole="button"
                accessibilityLabel={t("searchPage.removeFilter", { filter: label })}
                // A 32-point pill: the slop makes its target 44 without spacing the row out.
                hitSlop={{ top: 6, bottom: 6 }}
                fill={false}
                contentStyle={[styles.chip, { backgroundColor: c.sunken }]}
              >
                <Text variant="subhead">{label}</Text>
                <Icon name="x" size={15} color={c.muted} />
              </PressScale>
            </Animated.View>
          );
        })}
      </ScrollView>
    </LayoutAnimationConfig>
  );
}

/** With nothing typed: the recent searches first (what was looked for last is what is looked for again). */
export function RecentSearches({
  recent,
  onPick,
  onClear,
}: {
  recent: string[];
  onPick: (search: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  if (recent.length === 0) return null;
  return (
    <View>
      <SectionHeader
        title={t("mobile.find.recent")}
        action={{ label: t("searchPage.clearRecent"), onPress: onClear, chevron: false }}
      />
      <View style={styles.list}>
        <ActionList
          items={recent.map((r) => ({ key: r, icon: "clock", label: r, oneLine: true, onPress: () => onPick(r) }))}
        />
      </View>
    </View>
  );
}

/**
 * The filters in words over the search (ADR 0123 operators, said plainly): De, Em, Com arquivo, Data. Each starts
 * its operator in the field; the picker under the field takes it from there. "Data" starts `before:` (the picker says
 * how a date is written).
 */
const FILTER_WORDS: { key: "from" | "in" | "has" | "date"; op: SearchOp }[] = [
  { key: "from", op: "from" },
  { key: "in", op: "in" },
  { key: "has", op: "has" },
  { key: "date", op: "before" },
];

export function FilterWords({ onPick }: { onPick: (op: SearchOp) => void }) {
  const { t } = useTranslation();
  return (
    <View>
      <SectionHeader title={t("mobile.find.filters")} />
      <Filters
        items={FILTER_WORDS.map((f) => ({ key: f.key, label: t(`mobile.find.filterWord.${f.key}`) }))}
        value=""
        onChange={(key) => {
          const f = FILTER_WORDS.find((x) => x.key === key);
          if (f) onPick(f.op);
        }}
      />
    </View>
  );
}

/**
 * With nothing typed inside one conversation's search: the operators to start a filter with (`from:`, `in:`…; `ops`,
 * all by default), and the recent searches.
 */
export function SearchOptions({
  words,
  ops = SEARCH_OPS,
  onInsert,
  recent,
  onPickRecent,
  onClearRecent,
}: {
  words: SearchWords;
  ops?: readonly SearchOp[];
  onInsert: (word: string) => void;
  recent: string[];
  onPickRecent: (search: string) => void;
  onClearRecent: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View>
      <RecentSearches recent={recent} onPick={onPickRecent} onClear={onClearRecent} />
      <SectionHeader title={t("searchPage.options")} />
      <Filters
        items={ops.map((op) => ({ key: op, label: `${words.ops[op]}:` }))}
        value=""
        onChange={(op) => onInsert(`${words.ops[op as keyof SearchWords["ops"]]}:`)}
      />
    </View>
  );
}

/** The picker of the operator being typed: people and agents with their faces, channels and DMs, kinds. */
export function OperatorPicker({
  text,
  directory,
  words,
  onPick,
}: {
  text: string;
  directory: SearchDirectory;
  words: SearchWords;
  /** The chip, and the box's text without the operator. */
  onPick: (chip: SearchChip, rest: string) => void;
}) {
  const { t } = useTranslation();
  const typing = typingOperator(text, words);
  if (!typing) return null;
  const rest = text.slice(0, typing.start);
  const op = typing.op;
  const items =
    op === "from" || op === "mentions"
      ? suggestActors(typing.value, directory.actors).map((a) => ({
          key: `${a.type}:${a.id}`,
          leading: <Face who={a} size={30} live={false} />,
          label: a.name,
          ...(a.handle ? { hint: `@${a.handle}` } : {}),
          oneLine: true,
          onPress: () => onPick({ op, actor: a }, rest),
        }))
      : op === "in"
        ? suggestPlaces(typing.value, directory.places).map((p) => ({
            key: p.id,
            leading: <Tile icon={p.dm ? "chat" : "hash"} size={30} />,
            label: p.dm ? t("searchPage.dm", { name: p.name }) : p.name,
            oneLine: true,
            onPress: () => onPick({ op, place: p }, rest),
          }))
        : op === "has"
          ? SEARCH_HAS.map((h) => ({
              key: h,
              label: t(`searchPage.hasLabel.${h}`),
              onPress: () => onPick({ op, value: h }, rest),
            }))
          : op === "author"
            ? (["person", "agent"] as const).map((a) => ({
                key: a,
                label: t(`searchPage.authorLabel.${a}`),
                onPress: () => onPick({ op, value: a }, rest),
              }))
            : op === "pinned"
              ? [
                  {
                    key: "pinned",
                    icon: "pin" as const,
                    label: t("searchPage.pinnedChip"),
                    onPress: () => onPick({ op }, rest),
                  },
                ]
              : // Dates are typed (`before:2026-10-01`), the format is the hint.
                [];
  return (
    <View>
      <SectionHeader title={t(`searchPage.option.${op}`)} />
      {items.length > 0 ? (
        <View style={styles.list}>
          <ActionList items={items} />
        </View>
      ) : (
        <Text tone="faint" style={styles.hint}>
          {op === "in"
            ? t("searchPage.noPlace")
            : op === "from" || op === "mentions"
              ? t("searchPage.noMatch")
              : t("searchPage.dateHint")}
        </Text>
      )}
    </View>
  );
}

/**
 * Messages that pass the filters (ADR 0123), by where they were said (a thread's replies under the thread), the
 * search's words lit, with the sort; a tap opens the conversation at the message (a reply in its thread), or
 * `onPick` takes it.
 */
export function FilteredResults({
  chips,
  text,
  directory,
  sort,
  onSort,
  onClear,
  onOpen,
  onPick,
}: {
  chips: SearchChip[];
  text: string;
  directory: SearchDirectory;
  sort: SearchSort;
  onSort: (sort: SearchSort) => void;
  /** Removes every chip; without it, no way to (a DM's search holds to it). */
  onClear?: () => void;
  onOpen: () => void;
  onPick?: (hit: SearchHit) => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const when = useWhen();
  const hits = useSearch(useOrgId(), text, ["message"], searchFilterInput(chips, sort));
  const list = hits.data ?? [];
  const place = (id: string) => directory.places.find((p) => p.id === id);
  const placeName = (id: string) => {
    const p = place(id);
    return p ? (p.dm ? t("searchPage.dm", { name: p.name }) : `#${p.name}`) : "";
  };
  // A thread's group: its title, and in a channel "thread in #channel" (a DM's needs no where).
  const threadName = (title: string, channelId: string) => {
    const p = place(channelId);
    return [title, p && !p.dm ? t("searchPage.panel.threadIn", { channel: p.name }) : null].filter(Boolean).join(" · ");
  };
  const terms = searchTerms(text);
  return (
    <View>
      <Filters
        items={SEARCH_SORTS.map((s) => ({ key: s, label: t(`searchPage.sort.${s}`) }))}
        value={sort}
        onChange={(s) => onSort(s as SearchSort)}
      />
      <View style={styles.res}>
        <View style={styles.bar}>
          <Text tone="faint" accessibilityRole="text">
            {list.length >= 100
              ? t("searchPage.countMore", { count: 100 })
              : list.length > 0
                ? t("searchPage.count", { count: list.length })
                : ""}
          </Text>
          {onClear && chips.length > 0 ? (
            <Pressable
              onPress={onClear}
              accessibilityRole="button"
              hitSlop={11}
              style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
            >
              <Text tone="faint">{t("searchPage.filtersApplied", { count: chips.length })}</Text>
              <Icon name="x" size={17} color={c.muted} />
            </Pressable>
          ) : null}
        </View>
        {/* The results' own shape while they come, never a spinner. */}
        {hits.isLoading ? <SkeletonList rows={3} /> : null}
        {hits.isError && !hits.data ? (
          <View style={[styles.list, styles.failed]}>
            <Note icon="x">{t("common.loadFailed")}</Note>
            <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void hits.refetch()} />
          </View>
        ) : null}
        {groupHitsByPlace(list).map((g) => (
          <View key={g.key}>
            <SectionHeader title={g.thread ? threadName(g.thread.title, g.channelId) : placeName(g.channelId)} />
            <View style={styles.list}>
              <ActionList
                items={g.hits.map((h) => ({
                  key: h.sourceId,
                  leading: h.author ? (
                    <Face who={h.author} size={RESULT_LEAD} live={false} />
                  ) : (
                    <Tile icon="chat" size={RESULT_LEAD} />
                  ),
                  label: previewOf(hitText(t, h)),
                  marks: terms,
                  hint: [h.author?.name, when.short(h.createdAt)].filter(Boolean).join(" · "),
                  onPress: () => {
                    onOpen();
                    if (onPick) onPick(h);
                    else router.push(hitHref(h));
                  },
                }))}
              />
            </View>
          </View>
        ))}
        {hits.isSuccess && list.length === 0 ? (
          <EmptyState
            size="inline"
            title={t("mobile.find.nothing", {
              q: text.trim() || chips.map((c) => searchChipLabel(t, i18n.language, c)).join(" "),
            })}
            {...(onClear && chips.length > 0
              ? { action: <Button variant="secondary" size="sm" label={t("filters.clearAll")} onPress={onClear} /> }
              : {})}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { gap: 8, paddingHorizontal: SCREEN_X, paddingBottom: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: TOOL_H,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  // The operator's empty state, at the headers' text column.
  hint: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 6 },
  res: { paddingTop: 2 },
  list: { paddingHorizontal: 16 },
  failed: { marginTop: 14, gap: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: SCREEN_X,
    paddingTop: 8,
  },
  clear: { flexDirection: "row", alignItems: "center", gap: 4 },
  pressed: { opacity: 0.6 },
});
