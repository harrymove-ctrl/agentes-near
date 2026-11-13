import type { GifCategory, MessageMedia, StickerMood } from "@agenteschat/client";
import { useGifSearch, useSettings, useSettled } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import {
  GIF_CATEGORY_IDS,
  GIF_SEARCH_DELAY_MS,
  gifLabel,
  gifMedia,
  gifMediaUrl,
  gifsOfPages,
  isGifCategory,
  mediaTabsOf,
  stickerLabel,
  stickerMedia,
  stickerWords,
} from "@agenteschat/client/lib/media";
import {
  GifPicker,
  type GifPickerLabels,
  type PickerAgent,
  type PickerGif,
  type PickerTab,
  StickerPicker,
  type StickerPickerLabels,
} from "@agenteschat/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

/** A sticker's side in the picker (CSS pixels): four to a row. */
const PICKER_STICKER = 72;

/** What the composer needs for its picker with tabs: the tabs, their names and the emoji button's. */
export interface MediaTabs {
  tabs: PickerTab[];
  labels: { dialog: string; tabs: string };
  button: string;
}

/**
 * The composer picker's GIFs and stickers tabs (ADR 0091), each a click that sends (`onSend`) in the conversation
 * the composer writes to. GIFs only where this server has GIF search and the workspace has them on; stickers where
 * the workspace has them on and has agents. Neither: null, and the button is the emoji picker it always was.
 */
export function useMediaTabs(onSend: (media: MessageMedia) => void): MediaTabs | null {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const settings = useSettings(org.id).data;
  const dir = useDirectory(org.id);
  const open = mediaTabsOf(settings, dir.agents.length, Boolean(api.gifs));
  const gifs = open.includes("gifs");
  const stickers = open.includes("stickers");
  return useMemo(() => {
    const tabs: PickerTab[] = [];
    if (gifs) {
      tabs.push({
        id: "gifs",
        label: t("media.picker.gifs"),
        render: ({ close, autoFocus }) => (
          <GifTab
            autoFocus={autoFocus}
            onPick={(media) => {
              onSend(media);
              close();
            }}
          />
        ),
      });
    }
    if (stickers) {
      tabs.push({
        id: "stickers",
        label: t("media.picker.stickers"),
        render: ({ close, autoFocus }) => (
          <StickerTab
            autoFocus={autoFocus}
            onPick={(media) => {
              onSend(media);
              close();
            }}
          />
        ),
      });
    }
    if (tabs.length === 0) return null;
    return {
      tabs,
      labels: { dialog: t("media.picker.button"), tabs: t("media.picker.tabs") },
      button: t("media.picker.button"),
    };
  }, [gifs, stickers, onSend, t]);
}

/** The words of the GIFs tab. */
function useGifLabels(): GifPickerLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      search: t("media.gifs.search"),
      clearSearch: t("media.gifs.clear"),
      categories: t("media.gifs.categoriesLabel"),
      previous: t("media.gifs.previous"),
      next: t("media.gifs.next"),
      trending: t("media.gifs.trending"),
      results: t("media.gifs.results"),
      loading: t("media.gifs.loading"),
      empty: t("media.gifs.empty"),
      error: t("media.gifs.error"),
      retry: t("media.gifs.retry"),
      attribution: t("media.gifs.attribution"),
      hint: t("media.gifs.hint"),
    }),
    [t],
  );
}

/** The GIFs tab: the search through our server, a page at a time, in the person's language. */
function GifTab({ autoFocus, onPick }: { autoFocus: boolean; onPick: (media: MessageMedia) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const labels = useGifLabels();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<GifCategory | null>(null);
  const q = useSettled(query, GIF_SEARCH_DELAY_MS);
  const search = useGifSearch(org.id, { q, category, lang: i18n.language.slice(0, 2) });
  const found = useMemo(() => gifsOfPages(search.data?.pages), [search.data]);
  const gifs: PickerGif[] = useMemo(
    () =>
      found.map((g) => ({
        id: g.id,
        src: gifMediaUrl(org.id, g.id, "preview"),
        width: g.width,
        height: g.height,
        label: gifLabel(t, g.title),
      })),
    [found, org.id, t],
  );
  const categories = useMemo(
    () => GIF_CATEGORY_IDS.map((id) => ({ id, label: t(`media.gifs.categories.${id}`) })),
    [t],
  );
  // Why it failed, in words: GIFs turned off meanwhile, the GIF search not answering, too many searches.
  const why = search.error ? knownErrorText(t, search.error, i18n.language) : null;
  return (
    <GifPicker
      labels={why ? { ...labels, error: why } : labels}
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        if (next.trim()) setCategory(null);
      }}
      categories={categories}
      category={category}
      onCategoryChange={(next) => {
        setCategory(isGifCategory(next) ? next : null);
        setQuery("");
      }}
      gifs={gifs}
      status={search.isPending ? "loading" : search.isError && gifs.length === 0 ? "error" : "ready"}
      stale={search.isPlaceholderData}
      hasMore={Boolean(search.hasNextPage)}
      loadingMore={search.isFetchingNextPage}
      onLoadMore={() => void search.fetchNextPage()}
      onRetry={() => void search.refetch()}
      onPick={(picked) => {
        const gif = found.find((g) => g.id === picked.id);
        if (gif) onPick(gifMedia(gif));
      }}
      autoFocus={autoFocus}
    />
  );
}

/** The words of the stickers tab. */
function useStickerLabels(): StickerPickerLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      search: t("media.stickers.search"),
      clearSearch: t("media.stickers.clear"),
      empty: t("media.stickers.empty"),
      foot: t("media.stickers.foot"),
      ...stickerWords(t),
      sticker: (name: string, mood: StickerMood) => stickerLabel(t, name, mood),
    }),
    [t],
  );
}

/** The stickers tab: every agent of the team the person sees, with its six moods. */
function StickerTab({ autoFocus, onPick }: { autoFocus: boolean; onPick: (media: MessageMedia) => void }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const labels = useStickerLabels();
  const agents: PickerAgent[] = useMemo(
    () =>
      dir.agents.map((a) => ({
        id: a.id,
        name: a.name,
        appearance: lookOf(a),
        avatar: <AgentAvatar agentId={a.id} name={a.name} size="xs" />,
      })),
    [dir.agents],
  );
  return (
    <StickerPicker
      labels={labels}
      agents={agents}
      size={PICKER_STICKER}
      autoFocus={autoFocus}
      onPick={(agent, mood) => onPick(stickerMedia(agent.id, mood))}
    />
  );
}
