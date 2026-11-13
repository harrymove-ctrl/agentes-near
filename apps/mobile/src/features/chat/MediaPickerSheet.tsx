import type { Agent, Gif, GifCategory, MessageMedia, StickerMood } from "@agenteschat/client";
import { useGifSearch, useRoster, useSettled } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import {
  GIF_CATEGORY_IDS,
  GIF_SEARCH_DELAY_MS,
  gifLabel,
  gifMedia,
  gifsOfPages,
  isGifCategory,
  type MediaTab,
  stickerLabel,
  stickerMedia,
  stickerWords,
} from "@agenteschat/client/lib/media";
import { stickerMoodsFor } from "@agenteschat/ui/media-grid";
import { Image } from "expo-image";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Keyboard,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { StickerCanvas, StickerStageContext, useStickerLive } from "@/agent/StickerCanvas";
import { createStickerStage } from "@/agent/sticker-stage";
import { Button, Filters, PressScale, SearchField, Segmented, Text } from "@/ui";
import { useReducedMotion } from "@/ui/theme";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { gifImageSource } from "./ChatMedia";
import {
  type GifPlace,
  masonryPlaces,
  nearEnd,
  nearView,
  PICKER_STICKER,
  pickerHeight,
  pickerLiveIds,
  sectionsInView,
  stickerAgentsFor,
  stickerCellId,
} from "./media";

/** The first chip's key: what is trending, with an empty box and no category. */
const TRENDING = "trending";
/** Which GIFs are mounted changes in steps of this much scroll (points), not on every scroll event. */
const SCROLL_STEP = 80;

/** The room the keyboard takes now, heard from the system (the picker is in the sheet's modal). */
function useKeyboardRoom() {
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) =>
      setRoom(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setRoom(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return room;
}

/**
 * The composer's GIFs and stickers (ADR 0091), a short sheet: two tabs (emojis stay on the system keyboard), each only
 * where it can work (`tabs`, `mediaTabsOf`). One tap sends, as a message of its own, and the screen closes the sheet.
 * `dmAgentId` and `isDm` say whose stickers come first.
 */
export function MediaPickerSheet({
  tabs,
  channelId,
  isDm,
  dmAgentId,
  onSend,
}: {
  tabs: readonly MediaTab[];
  channelId: string;
  isDm: boolean;
  dmAgentId: string | null;
  onSend: (media: MessageMedia) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<MediaTab>(tabs[0] ?? "gifs");
  const { height: windowHeight } = useWindowDimensions();
  const keyboard = useKeyboardRoom();
  return (
    <View style={[styles.picker, { height: pickerHeight(windowHeight, keyboard) }]}>
      {tabs.length > 1 ? (
        <View style={styles.tabs} accessibilityLabel={t("media.picker.tabs")}>
          <Segmented
            items={tabs.map((key) => ({
              key,
              label: t(key === "gifs" ? "media.picker.gifs" : "media.picker.stickers"),
            }))}
            value={tab}
            onChange={(key) => setTab(key === "stickers" ? "stickers" : "gifs")}
          />
        </View>
      ) : null}
      {tab === "gifs" ? (
        <GifTab onSend={onSend} />
      ) : (
        <StickerTab channelId={channelId} isDm={isDm} dmAgentId={dmAgentId} onSend={onSend} />
      )}
    </View>
  );
}

/**
 * The GIFs tab: the box, the category chips ("Em alta" first), the results in two columns of their own proportions
 * through our server, a page at a time, and the provider's credit under them, as its terms ask. Only the GIFs near what
 * shows are mounted: each is a playing image, and a long scroll must not keep them all.
 */
function GifTab({ onSend }: { onSend: (media: MessageMedia) => void }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<GifCategory | null>(null);
  const q = useSettled(query, GIF_SEARCH_DELAY_MS);
  const search = useGifSearch(orgId, { q, category, lang: i18n.language.slice(0, 2) });
  const gifs = useMemo(() => gifsOfPages(search.data?.pages), [search.data]);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const [top, setTop] = useState(0);
  const { places, height } = useMemo(() => masonryPlaces(gifs, room.width), [gifs, room.width]);
  const list = useRef<ScrollViewInstance>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search starts at the top
  useEffect(() => {
    list.current?.scrollTo({ y: 0, animated: false });
    setTop(0);
  }, [q, category]);

  const onLayout = (e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    setTop(Math.round(contentOffset.y / SCROLL_STEP) * SCROLL_STEP);
    const more = search.hasNextPage && !search.isFetchingNextPage;
    if (more && nearEnd(contentOffset.y, layoutMeasurement.height, contentSize.height)) void search.fetchNextPage();
  };
  const pick = useCallback((gif: Gif) => onSend(gifMedia(gif)), [onSend]);

  const chips = [
    { key: TRENDING, label: t("media.gifs.trending") },
    ...GIF_CATEGORY_IDS.map((id) => ({ key: id, label: t(`media.gifs.categories.${id}`) })),
  ];
  const chip = query.trim() ? "" : (category ?? TRENDING);
  // Why it failed, in words: GIFs turned off meanwhile, the GIF search not answering, too many searches.
  const why = search.error ? knownErrorText(t, search.error, i18n.language) : null;
  const failed = search.isError && gifs.length === 0;
  return (
    <>
      <SearchField
        value={query}
        onChangeText={(next) => {
          setQuery(next);
          if (next.trim()) setCategory(null);
        }}
        placeholder={t("media.gifs.search")}
        accessibilityLabel={t("media.gifs.search")}
        autoCorrect={false}
        returnKeyType="search"
      />
      <View style={styles.chips}>
        <Filters
          items={chips}
          value={chip}
          onChange={(key) => {
            setQuery("");
            setCategory(isGifCategory(key) && key !== category ? key : null);
          }}
        />
      </View>
      <ScrollView
        ref={list}
        style={styles.grow}
        onLayout={onLayout}
        onScroll={onScroll}
        scrollEventThrottle={64}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {search.isPending ? (
          <View style={styles.state}>
            <ActivityIndicator color={c.muted} accessibilityLabel={t("media.gifs.loading")} />
          </View>
        ) : failed ? (
          <View style={styles.state}>
            <Text variant="small" tone="muted" style={styles.centered} accessibilityLiveRegion="polite">
              {why ?? t("media.gifs.error")}
            </Text>
            <Button size="sm" variant="secondary" label={t("media.gifs.retry")} onPress={() => void search.refetch()} />
          </View>
        ) : gifs.length === 0 ? (
          <View style={styles.state}>
            <Text variant="small" tone="muted" style={styles.centered} accessibilityLiveRegion="polite">
              {t("media.gifs.empty")}
            </Text>
          </View>
        ) : (
          <View
            style={[{ height }, search.isPlaceholderData && styles.stale]}
            accessibilityLabel={t("media.gifs.results")}
          >
            {places
              .filter((place) => nearView(place, top, room.height))
              .map((place) => (
                <GifCell key={place.item.id} place={place} onPick={pick} />
              ))}
          </View>
        )}
        {search.isFetchingNextPage ? <ActivityIndicator color={c.muted} style={styles.more} /> : null}
      </ScrollView>
      <Text variant="caption" tone="faint" style={[styles.centered, styles.bold]}>
        {t("media.gifs.attribution")}
      </Text>
    </>
  );
}

/** One GIF at its place: the small file through our server; with reduced motion, its still frame. */
const GifCell = memo(function GifCell({ place, onPick }: { place: GifPlace<Gif>; onPick: (gif: Gif) => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const reduced = useReducedMotion();
  const { item: gif, x, y, width, height } = place;
  const size = reduced ? "still" : "preview";
  const source = useMemo(() => gifImageSource(orgId, gif.id, size), [orgId, gif.id, size]);
  return (
    <PressScale
      to={0.96}
      onPress={() => onPick(gif)}
      accessibilityRole="button"
      accessibilityLabel={gifLabel(t, gif.title)}
      style={[styles.gif, { left: x, top: y, width, height, backgroundColor: c.sunken }]}
    >
      <Image
        source={source}
        recyclingKey={source.cacheKey}
        contentFit="cover"
        autoplay={!reduced}
        transition={120}
        style={StyleSheet.absoluteFill}
        accessible={false}
      />
    </PressScale>
  );
});

/**
 * The stickers tab: the conversation's agents, each with its six moods, found by a box as on the web. A few in view
 * play at a time (`pickerLiveIds`): the sections measure where they are, and a stage of its own tells each sticker.
 */
function StickerTab({
  channelId,
  isDm,
  dmAgentId,
  onSend,
}: {
  channelId: string;
  isDm: boolean;
  dmAgentId: string | null;
  onSend: (media: MessageMedia) => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const roster = useRoster(orgId, channelId, !isDm);
  const [query, setQuery] = useState("");
  const [stage] = useState(createStickerStage);
  const sections = useMemo(() => {
    const words = stickerWords(t);
    const rosterIds = (roster.data ?? []).filter((r) => r.type === "agent").map((r) => r.id);
    const here = isDm ? (dmAgentId ? [dmAgentId] : []) : rosterIds;
    return stickerAgentsFor(dir.agents, here)
      .map((agent) => ({ agent, moods: stickerMoodsFor(query, agent.name, words) }))
      .filter((s) => s.moods.length > 0);
  }, [dir.agents, roster.data, isDm, dmAgentId, query, t]);

  const places = useRef(new Map<string, { y: number; height: number }>());
  const view = useRef({ top: 0, height: 0 });
  const refresh = () => {
    const shown = sections.flatMap((s) => {
      const place = places.current.get(s.agent.id);
      return place ? [{ id: s.agent.id, ...place }] : [];
    });
    const moods = (id: string) => sections.find((s) => s.agent.id === id)?.moods ?? [];
    stage.setOnScreen(pickerLiveIds(sectionsInView(shown, view.current.top, view.current.height), moods));
  };
  // A search that keeps a section where it was changes what it holds, and no layout says so.
  useEffect(refresh);
  const pick = useCallback((agentId: string, mood: StickerMood) => onSend(stickerMedia(agentId, mood)), [onSend]);

  return (
    <>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t("media.stickers.search")}
        accessibilityLabel={t("media.stickers.search")}
        autoCorrect={false}
        returnKeyType="search"
      />
      <StickerStageContext.Provider value={stage}>
        <ScrollView
          style={styles.grow}
          onLayout={(e) => {
            view.current.height = e.nativeEvent.layout.height;
            refresh();
          }}
          onScroll={(e) => {
            view.current.top = e.nativeEvent.contentOffset.y;
            refresh();
          }}
          scrollEventThrottle={100}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          {sections.length === 0 ? (
            <View style={styles.state}>
              <Text variant="small" tone="muted" style={styles.centered} accessibilityLiveRegion="polite">
                {t("media.stickers.empty")}
              </Text>
            </View>
          ) : null}
          {sections.map(({ agent, moods }) => (
            <View
              key={agent.id}
              style={styles.section}
              onLayout={(e) => {
                const { y, height } = e.nativeEvent.layout;
                places.current.set(agent.id, { y, height });
                refresh();
              }}
            >
              <View style={styles.agent}>
                <AgentFace agentId={agent.id} size={22} live={false} />
                <Text variant="footnote" tone="muted" numberOfLines={1} style={[styles.bold, styles.shrink]}>
                  {agent.name}
                </Text>
              </View>
              <View style={styles.stickers}>
                {moods.map((mood) => (
                  <StickerCell key={mood} agent={agent} mood={mood} onPick={pick} />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      </StickerStageContext.Provider>
      <Text variant="caption" tone="faint" style={styles.centered}>
        {t("media.stickers.foot")}
      </Text>
    </>
  );
}

/** One sticker to tap, by the same drawing a message shows. */
function StickerCell({
  agent,
  mood,
  onPick,
}: {
  agent: Agent;
  mood: StickerMood;
  onPick: (agentId: string, mood: StickerMood) => void;
}) {
  const { t } = useTranslation();
  const live = useStickerLive(stickerCellId(agent.id, mood));
  return (
    <PressScale
      to={0.92}
      onPress={() => onPick(agent.id, mood)}
      accessibilityRole="button"
      accessibilityLabel={stickerLabel(t, agent.name, mood)}
      style={styles.sticker}
    >
      <View style={styles.stickerIn}>
        <StickerCanvas look={agentLook(agent)} mood={mood} size={PICKER_STICKER} seed={agent.id} live={live} />
      </View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  picker: { gap: 10 },
  tabs: { alignItems: "center" },
  // Runs past the sheet's padding, so a long last chip scrolls instead of being cut at it.
  chips: { marginHorizontal: -16 },
  grow: { flex: 1 },
  state: { alignItems: "center", gap: 10, paddingVertical: 32, paddingHorizontal: 12 },
  centered: { textAlign: "center" },
  bold: { fontWeight: "600" },
  stale: { opacity: 0.5 },
  more: { paddingVertical: 12 },
  gif: { position: "absolute", borderRadius: 10, overflow: "hidden" },
  section: { gap: 6, paddingBottom: 10 },
  agent: { flexDirection: "row", alignItems: "center", gap: 8 },
  stickers: { flexDirection: "row", flexWrap: "wrap" },
  sticker: { width: "25%", height: PICKER_STICKER + 8 },
  stickerIn: { flex: 1, alignItems: "center", justifyContent: "center" },
});
