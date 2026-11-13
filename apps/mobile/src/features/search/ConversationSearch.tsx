import type { SearchHit } from "@agenteschat/client";
import {
  dedupe,
  formatSearch,
  parseSearch,
  rememberSearch,
  type SearchChip,
  type SearchPlace,
  type SearchSort,
  searchChipKey,
  searchSortFor,
  searchWords,
  typingOperator,
} from "@agenteschat/client/lib/search-filters";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, type TextInputInstance, View } from "react-native";
import { STORED } from "@/lib/storage";
import { SearchField } from "@/ui";
import { useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useRecentSearches, useSearchDirectory } from "./hooks";
import { conversationScope, idleIn, typeSearch } from "./logic";
import { FilterChips, FilteredResults, OperatorPicker, SearchOptions } from "./SearchFilters";

/**
 * "Buscar nesta conversa", the sheet the conversation's search button opens: the web's header search on the phone
 * (ADR 0123). The field focused, the filters offered here (a DM none of who or where), the recent searches of this
 * conversation on this phone; the results as the search tab's, a tap goes to the message (`onPick`).
 */
export function ConversationSearch({ place, onPick }: { place: SearchPlace; onPick: (hit: SearchHit) => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const words = useMemo(() => searchWords(t), [t]);
  const all = useSearchDirectory();
  // The conversation is always a place its `in:` chip (and a recent search's) can name.
  const directory = useMemo(
    () => (all.places.some((p) => p.id === place.id) ? all : { ...all, places: [...all.places, place] }),
    [all, place],
  );
  const [q, setQ] = useState("");
  const [chips, setChips] = useState<SearchChip[]>([{ op: "in", place }]);
  const [sort, setSort] = useState<SearchSort | null>(null);
  const field = useRef<TextInputInstance>(null);
  const [recent, saveRecent] = useRecentSearches(STORED.conversationSearchRecent, `${orgId}:${place.id}`);
  const scope = conversationScope(place, chips);
  const text = parseSearch(q, directory, words).text;
  const typing = typingOperator(q, words);

  const remember = () => {
    const s = formatSearch(scope.shown, text);
    if (s) saveRecent(rememberSearch(recent, s));
  };
  const pickRecent = (s: string) => {
    const parsed = parseSearch(s, directory, words);
    setChips(parsed.chips);
    setQ(parsed.text);
    saveRecent(rememberSearch(recent, s));
  };
  const change = (value: string) => {
    const next = typeSearch(value, chips, directory, words, scope.ops);
    setChips(next.chips);
    setQ(next.q);
  };

  return (
    <>
      <SheetTitle title={t("searchPage.searchHere")} />
      <SearchField
        ref={field}
        value={q}
        onChangeText={change}
        onSubmitEditing={remember}
        placeholder={t("searchPage.searchHere")}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      {/* Edge to edge as in the search tab: these pad themselves, the sheet's own padding (18) is undone. */}
      <View style={styles.bleed}>
        {scope.shown.length > 0 ? (
          <FilterChips
            chips={scope.shown}
            onRemove={(c) => setChips(chips.filter((x) => searchChipKey(x) !== searchChipKey(c)))}
          />
        ) : null}
        {typing && scope.ops.includes(typing.op) ? (
          <OperatorPicker
            text={q}
            directory={directory}
            words={words}
            onPick={(chip, rest) => {
              setChips(dedupe([...chips, chip]));
              setQ(rest);
            }}
          />
        ) : idleIn(place, scope.searched, text) ? (
          <SearchOptions
            words={words}
            ops={scope.ops}
            onInsert={(word) => {
              setQ(word);
              field.current?.focus();
            }}
            recent={recent}
            onPickRecent={pickRecent}
            onClearRecent={() => saveRecent([])}
          />
        ) : (
          <FilteredResults
            chips={scope.searched}
            text={text}
            directory={directory}
            sort={searchSortFor(sort, text)}
            onSort={setSort}
            {...(place.dm ? {} : { onClear: () => setChips([]) })}
            onOpen={remember}
            onPick={onPick}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  bleed: { marginHorizontal: -18, marginTop: 10 },
});
