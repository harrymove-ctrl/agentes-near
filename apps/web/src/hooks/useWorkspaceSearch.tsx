import type { SearchHit, SearchKind, SearchSort } from "@agenteschat/client";
import { useChannels, useDms, useSearch } from "@agenteschat/client";
import {
  formatSearch,
  hasSearch,
  parseSearch,
  rememberSearch,
  type SearchChip,
  type SearchDirectory,
  type SearchPlace,
  searchFilterInput,
  searchSortFor,
  searchWords,
} from "@agenteschat/client/lib/search-filters";
import { linkOptions } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { STORAGE_KEYS, storage, storedStrings } from "@/lib/storage";

export type SearchFilter = "all" | "message" | "context_item" | "action";
const KINDS: Record<SearchFilter, SearchKind[]> = {
  all: ["action", "message", "context_item"],
  message: ["message"],
  context_item: ["context_item"],
  action: ["action"],
};
/** The team's outside actions (ADR 0064) come first: "has anyone already…?" is what they answer. */
const ORDER: SearchKind[] = ["action", "message", "context_item"];
/** The server's most per filtered search: a full page reads "100+". */
export const SEARCH_PAGE = 100;

/** Hits grouped by kind (the team's actions first), each group in the order the server ranked it. */
export function groupHits(hits: SearchHit[]) {
  const groups = new Map<SearchKind, SearchHit[]>();
  for (const h of hits) groups.set(h.kind, [...(groups.get(h.kind) ?? []), h]);
  const rank = (k: SearchKind) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

/**
 * Where a hit opens, at its message: a reply in its thread, a DM's message in the DM (the channel route only knows
 * channels), the rest in its channel. Null when its place isn't one the person is in.
 */
export function hitLink(
  orgId: string,
  hit: SearchHit,
  channelId?: string,
  dm?: { type: "person" | "agent"; id: string },
) {
  if (!channelId) return null;
  const m = hit.kind === "message" ? (hit.messageId ?? undefined) : undefined;
  const search = m ? { m } : {};
  if (m && hit.threadId && hit.threadId !== m)
    return linkOptions({ to: "/org/$orgId/threads/$threadId", params: { orgId, threadId: hit.threadId }, search });
  if (dm?.type === "agent")
    return linkOptions({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId, agentId: dm.id }, search });
  if (dm) return linkOptions({ to: "/org/$orgId/dm/person/$userId", params: { orgId, userId: dm.id }, search });
  return linkOptions({ to: "/org/$orgId/c/$channelId", params: { orgId, channelId }, search });
}

/**
 * The workspace search (`GET …/search`, ADR 0123): words and filter chips, recent searches, the kind and sort, the
 * search as you type and its hits. The search page and the channel header's field each hold one.
 */
export function useWorkspaceSearch(lazy = false) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const dir = useDirectory(org.id);
  const words = useMemo(() => searchWords(t), [t]);
  const places = useMemo<SearchPlace[]>(
    () => [
      ...(channels.data ?? []).filter((c) => c.isMember).map((c) => ({ id: c.id, name: c.name })),
      ...(dms.data ?? []).map((d) => ({ id: d.channelId, name: d.with.name, dm: true })),
    ],
    [channels.data, dms.data],
  );
  const directory = useMemo<SearchDirectory>(
    () => ({
      actors: [
        ...dir.members.map((m) => ({ type: "person" as const, id: m.userId, name: m.name, handle: m.handle })),
        ...dir.agents.map((a) => ({ type: "agent" as const, id: a.id, name: a.name, handle: a.handle })),
      ],
      places,
    }),
    [dir.members, dir.agents, places],
  );

  const recentKey = `${STORAGE_KEYS.searchRecent}.${me.user.id}.${org.id}`;
  const [recent, setRecent] = useState(() => storedStrings(recentKey));
  const saveRecent = (list: string[]) => {
    setRecent(list);
    if (list.length) storage.set(recentKey, JSON.stringify(list));
    else storage.remove(recentKey);
  };

  const [chips, setChips] = useState<SearchChip[]>([]);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [sort, setSort] = useState<SearchSort | null>(null);
  // Search as you type, a beat after the last key; an operator still being typed isn't searched as words.
  useEffect(() => {
    const timer = setTimeout(() => setQ(parseSearch(input, directory, words).text), 250);
    return () => clearTimeout(timer);
  }, [input, directory, words]);
  const filtered = chips.length > 0;
  const effectiveSort = searchSortFor(sort, q);
  // `lazy` (the header's field, which starts with its channel's chip): filters alone wait for the results to show,
  // so arriving in a channel runs no search.
  const [shown, setShown] = useState(false);
  const held = lazy && !shown && !q.trim();
  const search = useSearch(
    org.id,
    q,
    filtered ? ["message"] : KINDS[filter],
    !held && (filtered || sort) ? searchFilterInput(chips, effectiveSort) : undefined,
  );
  return {
    words,
    places,
    directory,
    recent,
    saveRecent,
    chips,
    setChips,
    input,
    setInput,
    q,
    filter,
    setFilter,
    sort: effectiveSort,
    setSort,
    search,
    hits: search.data ?? [],
    active: hasSearch(chips, q),
    filtered,
    setShown,
    placeOf: (id: string | undefined) => places.find((p) => p.id === id),
    dmWith: (id: string | undefined) => dms.data?.find((d) => d.channelId === id)?.with,
    /** The search as typed, kept with the recent ones. */
    remember: () => {
      const text = formatSearch(chips, parseSearch(input, directory, words).text);
      if (text) saveRecent(rememberSearch(recent, text));
    },
    pickRecent: (text: string) => {
      const parsed = parseSearch(text, directory, words);
      setChips(parsed.chips);
      setInput(parsed.text);
      saveRecent(rememberSearch(recent, text));
    },
    clear: () => {
      setChips([]);
      setInput("");
    },
  };
}

export type WorkspaceSearch = ReturnType<typeof useWorkspaceSearch>;

/** "Ir para" into another conversation: its results stay open there, a reply over them in its thread. */
export interface CarriedSearch {
  channelId: string;
  thread?: string;
}

interface HeaderSearch extends WorkspaceSearch {
  /** "Filtros" in the results: back to the header's field with its menu open (the phone's sheet on a phone). */
  field: { current: { focus: () => void } | null };
  carry: { current: CarriedSearch | null };
}
const HeaderSearchContext = createContext<HeaderSearch | null>(null);

/** The channel header's search, held by the workspace so its query outlives a channel switch ("Ir para"). */
export function HeaderSearchProvider({ children }: { children: ReactNode }) {
  const search = useWorkspaceSearch(true);
  const field = useRef<{ focus: () => void } | null>(null);
  const carry = useRef<CarriedSearch | null>(null);
  return <HeaderSearchContext.Provider value={{ ...search, field, carry }}>{children}</HeaderSearchContext.Provider>;
}

/** Null outside a workspace's pages (the header shows no field there). */
export const useHeaderSearch = () => useContext(HeaderSearchContext);
