import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { StickerMood } from "../agent/stickers";
import { cx } from "../cx";
import { masonryColumns, stickerMoodsFor } from "../media-grid";
import type { AgentAppearance } from "./AgentLook";
import { AgentSticker } from "./AgentSticker";
import { Button } from "./Button";
import { Carousel } from "./Carousel";
import { Skeleton, SkeletonGroup, Spinner } from "./Skeleton";
import { FilterToggle, SearchField } from "./Toolbar";

export { masonryColumns, stickerMoodsFor };

/*
 * The composer picker's GIFs and stickers tabs (ADR 0091). Both only draw what the app gives them: the app searches
 * (through its server), sends what is picked and closes the picker.
 */

/** Columns of the GIF results. */
const GIF_COLUMNS = 2;
/** Load the next page this far before the end of the list (px). */
const MORE_AHEAD = 240;
/** Stickers per row. */
const STICKER_COLUMNS = 4;
/** The loading GIFs' heights, a column each (the first page's place, before it comes). */
const GHOSTS_LEFT = [96, 132, 84, 118];
const GHOSTS_RIGHT = [120, 88, 140, 92];

/** A GIF in the picker: its small file (our server's media route) and its size, which holds its place as it loads. */
export interface PickerGif {
  id: string;
  /** The preview file's address (`size=preview`). */
  src: string;
  width: number;
  height: number;
  /** Its accessible name ("GIF: gato dançando"). */
  label: string;
}

export interface GifPickerLabels {
  /** The search box's name and placeholder ("Buscar GIFs"). */
  search: string;
  clearSearch: string;
  /** The chips' group ("Categorias") and its arrows. */
  categories: string;
  previous: string;
  next: string;
  /** The first chip: what is trending, with an empty box ("Em alta"). */
  trending: string;
  /** The results' group ("GIFs"). */
  results: string;
  loading: string;
  /** Nothing found ("Nenhum GIF encontrado. Tente outra palavra."). */
  empty: string;
  /** The search failed ("Não deu para buscar GIFs agora."), with `retry`. */
  error: string;
  retry: string;
  /** The provider's credit, under the results ("GIFs do GIPHY"). */
  attribution: string;
  /** Beside it, what a click does ("Um clique envia"). */
  hint?: string;
}

/**
 * Arrow keys between the cells (`data-col`, `data-row`) of the grids (`data-grid`, its column count) inside the
 * element that has the handler: down and up go on to the next or previous grid, up from the first row of the first
 * grid goes back to `back` (the search box).
 */
function moveInGrids(e: KeyboardEvent<HTMLElement>, back?: HTMLElement | null) {
  const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
  const grid = cell?.closest<HTMLElement>("[data-grid]");
  if (!cell || !grid) return;
  const grids = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-grid]")];
  const at = grids.indexOf(grid);
  const col = Number(cell.dataset.col);
  const row = Number(cell.dataset.row);
  const rowsIn = (g: HTMLElement, c: number) => g.querySelectorAll(`[data-col="${c}"]`).length;
  const cellOf = (g: HTMLElement | undefined, c: number, r: number) => {
    if (!g) return null;
    const column = Math.min(c, Number(g.dataset.grid) - 1);
    const last = rowsIn(g, column) - 1;
    return g.querySelector<HTMLElement>(`[data-col="${column}"][data-row="${Math.max(0, Math.min(r, last))}"]`);
  };
  let target: HTMLElement | null | undefined = null;
  if (e.key === "ArrowRight") target = cellOf(grid, col + 1, row);
  else if (e.key === "ArrowLeft") target = col > 0 ? cellOf(grid, col - 1, row) : null;
  else if (e.key === "ArrowDown") {
    target = row + 1 < rowsIn(grid, col) ? cellOf(grid, col, row + 1) : cellOf(grids[at + 1], col, 0);
  } else if (e.key === "ArrowUp") {
    if (row > 0) target = cellOf(grid, col, row - 1);
    else if (at > 0) target = cellOf(grids[at - 1], col, Number.MAX_SAFE_INTEGER);
    else target = back;
  } else return;
  e.preventDefault();
  target?.focus();
}

/**
 * The GIFs tab: a search box, the category chips ("Em alta" first) sliding sideways, the results in two columns
 * of their own proportions (each holds its place before its file loads) that load the next page near the end, and
 * the provider's credit under them. One click picks. Arrows move between the GIFs; ArrowDown from the box enters.
 */
export function GifPicker({
  labels,
  query,
  onQueryChange,
  categories,
  category,
  onCategoryChange,
  gifs,
  status,
  stale = false,
  hasMore,
  loadingMore,
  onLoadMore,
  onRetry,
  onPick,
  autoFocus = false,
  className,
}: {
  labels: GifPickerLabels;
  query: string;
  onQueryChange: (query: string) => void;
  categories: { id: string; label: string }[];
  /** The chosen category; null with an empty box is "Em alta". */
  category: string | null;
  onCategoryChange: (category: string | null) => void;
  gifs: PickerGif[];
  /** `loading`: the first page is on its way; `error`: it could not come. */
  status: "loading" | "error" | "ready";
  /** What shows is the last search's while this one loads. */
  stale?: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onPick: (gif: PickerGif) => void;
  /** The picker just opened on this tab: the box takes the focus. */
  autoFocus?: boolean;
  className?: string;
}) {
  const search = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const columns = useMemo(() => masonryColumns(gifs, GIF_COLUMNS), [gifs]);
  const typed = query.trim() !== "";
  // Read by the observer and the scroll: the latest, without observing again on each render.
  const more = useRef({ hasMore, loadingMore, onLoadMore });
  more.current = { hasMore, loadingMore, onLoadMore };
  const loadMore = () => {
    const m = more.current;
    if (m.hasMore && !m.loadingMore) m.onLoadMore();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: watch again when a page arrives (the sentinel moved)
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root: scroll.current, rootMargin: `0px 0px ${MORE_AHEAD}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [gifs.length, hasMore]);

  let results: ReactNode;
  if (status === "loading" && gifs.length === 0) {
    results = (
      <SkeletonGroup label={labels.loading} className="ac-gifs__grid">
        {[GHOSTS_LEFT, GHOSTS_RIGHT].map((column) => (
          <span key={column[0]} className="ac-gifs__col">
            {column.map((h) => (
              <Skeleton key={h} shape="block" height={h} className="ac-gifs__ghost" />
            ))}
          </span>
        ))}
      </SkeletonGroup>
    );
  } else if (status === "error" && gifs.length === 0) {
    results = (
      <div className="ac-media__empty" role="status">
        <span>{labels.error}</span>
        <Button size="sm" onClick={onRetry}>
          {labels.retry}
        </Button>
      </div>
    );
  } else if (gifs.length === 0) {
    results = (
      <p className="ac-media__empty" role="status">
        {labels.empty}
      </p>
    );
  } else {
    results = (
      // biome-ignore lint/a11y/useSemanticElements: a named grid of buttons; a fieldset would need a legend and its box
      <div
        className="ac-gifs__grid"
        role="group"
        aria-label={labels.results}
        aria-busy={stale || undefined}
        data-grid={GIF_COLUMNS}
        data-stale={stale || undefined}
      >
        {columns.map((column, c) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the columns are places, not items
          <div key={c} className="ac-gifs__col">
            {column.map((gif, r) => {
              const w = gif.width > 0 ? gif.width : 1;
              const h = gif.height > 0 ? gif.height : 1;
              return (
                <button
                  key={gif.id}
                  type="button"
                  className="ac-gifs__cell"
                  data-col={c}
                  data-row={r}
                  aria-label={gif.label}
                  style={{ aspectRatio: `${w} / ${h}` }}
                  onClick={() => onPick(gif)}
                >
                  <img src={gif.src} alt="" width={w} height={h} loading="lazy" decoding="async" />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cx("ac-media", className)}>
      <SearchField
        ref={search}
        size="sm"
        aria-label={labels.search}
        placeholder={labels.search}
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => onQueryChange(e.target.value)}
        onClear={() => {
          onQueryChange("");
          search.current?.focus();
        }}
        clearLabel={labels.clearSearch}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          const first = scroll.current?.querySelector<HTMLElement>("[data-col]");
          if (!first) return;
          e.preventDefault();
          first.focus();
        }}
      />
      <Carousel
        label={labels.categories}
        previousLabel={labels.previous}
        nextLabel={labels.next}
        className="ac-media__chips"
      >
        <FilterToggle pressed={!typed && category === null} icon="bolt" onPressedChange={() => onCategoryChange(null)}>
          {labels.trending}
        </FilterToggle>
        {categories.map((c) => (
          <FilterToggle
            key={c.id}
            pressed={!typed && category === c.id}
            onPressedChange={(on) => onCategoryChange(on ? c.id : null)}
          >
            {c.label}
          </FilterToggle>
        ))}
      </Carousel>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the GIF buttons of both columns */}
      <div
        ref={scroll}
        className="ac-media__scroll"
        onKeyDown={(e) => moveInGrids(e, search.current)}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - MORE_AHEAD) loadMore();
        }}
      >
        {results}
        {hasMore && gifs.length > 0 && (
          <div ref={sentinel} className="ac-media__more">
            {loadingMore && <Spinner size={16} />}
          </div>
        )}
      </div>
      <p className="ac-media__foot">
        <b>{labels.attribution}</b>
        {labels.hint && <span>{labels.hint}</span>}
      </p>
    </div>
  );
}

/** An agent in the stickers tab. */
export interface PickerAgent {
  id: string;
  name: string;
  appearance?: AgentAppearance;
  /** Before its name: the app's own avatar of it. */
  avatar?: ReactNode;
}

export interface StickerPickerLabels {
  /** The search box's name and placeholder ("Buscar figurinhas"). */
  search: string;
  clearSearch: string;
  /** Nothing found. */
  empty: string;
  /** Under the stickers ("Feitas do visual de cada agente"). */
  foot?: string;
  /** Each mood's name ("Comemorando"). */
  moods: Record<StickerMood, string>;
  /** Other words each mood is found by ("festa parabéns" for celebrate). */
  moodWords?: Partial<Record<StickerMood, string>>;
  /** A sticker's accessible name ("Figurinha do Dev: comemorando"). */
  sticker: (agentName: string, mood: StickerMood) => string;
}

/**
 * The stickers tab: a section per agent (its avatar and name), with its six moods, each alive while on screen. A
 * search finds agents by name and moods by their words. One click picks; arrows move between the stickers.
 */
export function StickerPicker({
  labels,
  agents,
  onPick,
  size = 72,
  autoFocus = false,
  className,
}: {
  labels: StickerPickerLabels;
  agents: PickerAgent[];
  onPick: (agent: PickerAgent, mood: StickerMood) => void;
  /** Each sticker's side (CSS pixels). */
  size?: number;
  /** The picker just opened on this tab: the box takes the focus. */
  autoFocus?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const sections = agents
    .map((agent) => ({ agent, moods: stickerMoodsFor(query, agent.name, labels) }))
    .filter((s) => s.moods.length > 0);
  return (
    <div className={cx("ac-media", className)}>
      <SearchField
        ref={search}
        size="sm"
        aria-label={labels.search}
        placeholder={labels.search}
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => {
          setQuery("");
          search.current?.focus();
        }}
        clearLabel={labels.clearSearch}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          const first = scroll.current?.querySelector<HTMLElement>("[data-col]");
          if (!first) return;
          e.preventDefault();
          first.focus();
        }}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the sticker buttons of every agent */}
      <div ref={scroll} className="ac-media__scroll" onKeyDown={(e) => moveInGrids(e, search.current)}>
        {sections.length === 0 && (
          <p className="ac-media__empty" role="status">
            {labels.empty}
          </p>
        )}
        {sections.map(({ agent, moods }) => (
          <section key={agent.id} className="ac-stickers" aria-label={agent.name}>
            <h3 className="ac-stickers__heading">
              {agent.avatar}
              <span>{agent.name}</span>
            </h3>
            <div className="ac-stickers__grid" data-grid={STICKER_COLUMNS}>
              {moods.map((mood, i) => (
                <button
                  key={mood}
                  type="button"
                  className="ac-stickers__cell"
                  data-col={i % STICKER_COLUMNS}
                  data-row={Math.floor(i / STICKER_COLUMNS)}
                  aria-label={labels.sticker(agent.name, mood)}
                  onClick={() => onPick(agent, mood)}
                >
                  <AgentSticker appearance={agent.appearance} mood={mood} size={size} seed={agent.id} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      {labels.foot && (
        <p className="ac-media__foot">
          <span>{labels.foot}</span>
        </p>
      )}
    </div>
  );
}
