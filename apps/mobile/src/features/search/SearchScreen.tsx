import {
  dedupe,
  formatSearch,
  parseSearch,
  rememberSearch,
  type SearchChip,
  type SearchOp,
  type SearchSort,
  searchChipKey,
  searchSortFor,
  searchWords,
  typingOperator,
} from "@agenteschat/client/lib/search-filters";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Keyboard, StyleSheet, type TextInputInstance, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { STORED } from "@/lib/storage";
import { LargeTitleScreen, SearchField, SectionHeader, useReducedMotion } from "@/ui";
import { ConversationRowView } from "../chats/ConversationRowView";
import { kindOf } from "../chats/logic";
import { useOrgId } from "../shared/hooks";
import { useConversations } from "../shared/queries";
import { useRecentSearches, useSearchDirectory } from "./hooks";
import { typeSearch } from "./logic";
import { FilterChips, FilteredResults, FilterWords, OperatorPicker, RecentSearches } from "./SearchFilters";
import { SearchResults } from "./SearchResults";

/** Conversations the empty search lists ("Recentes"). */
const RECENT = 6;
/** After the tab's switch, so the keyboard rises once the screen shows. */
const FOCUS_DELAY_MS = 350;

/**
 * Buscar, its own tab (on iOS 26 the round button apart in the tab bar,
 * like Music's): the large title with the search field under it; when the field takes the focus the title folds
 * away and the field rises into the navigation with "Cancelar", as the system's search bar does. Empty: the recent
 * searches first, then the filters in words (De, Em, Com arquivo, Data: each starts its operator, ADR 0123), then
 * the recent conversations. With words: the results in place, grouped with their counts. Typed operators become
 * chips under the field, with a picker while one is typed; with chips it finds messages only, by channel, with a
 * sort. Recent searches are kept per workspace on this phone.
 */
export function SearchScreen() {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const reduced = useReducedMotion();
  const list = useConversations();
  const [q, setQ] = useState("");
  const [chips, setChips] = useState<SearchChip[]>([]);
  const [searching, setSearching] = useState(false);
  // Null until picked: by relevance with words, newest first without (as on the web).
  const [sort, setSort] = useState<SearchSort | null>(null);
  const field = useRef<TextInputInstance>(null);
  const orgId = useOrgId();
  const directory = useSearchDirectory();
  const searchingWords = useMemo(() => searchWords(t), [t]);
  const text = parseSearch(q, directory, searchingWords).text;
  const words = q.trim().length > 0 || chips.length > 0;

  // Recent searches: this phone's, per workspace.
  const [recent, saveRecent] = useRecentSearches(STORED.searchRecent, orgId);
  const remember = () => {
    const s = formatSearch(chips, text);
    if (s) saveRecent(rememberSearch(recent, s));
  };
  const pickRecent = (s: string) => {
    const parsed = parseSearch(s, directory, searchingWords);
    setChips(parsed.chips);
    setQ(parsed.text);
    saveRecent(rememberSearch(recent, s));
  };
  const change = (value: string) => {
    const next = typeSearch(value, chips, directory, searchingWords);
    setChips(next.chips);
    setQ(next.q);
  };
  // A filter word starts its operator in the field ("de:"), and the picker under it takes over.
  const startOp = (op: SearchOp) => {
    setQ(`${searchingWords.ops[op]}:`);
    field.current?.focus();
  };

  // Selecting the tab puts the cursor in the (empty) field, like the system's search tab; Cancelar doesn't.
  const typed = useRef(q);
  typed.current = q;
  useEffect(() => {
    if (!focused || typed.current) return;
    const timer = setTimeout(() => field.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [focused]);

  const cancel = () => {
    setQ("");
    setChips([]);
    setSearching(false);
    field.current?.blur();
    Keyboard.dismiss();
  };

  // Android's back clears the words first (like Cancelar), not the app.
  useEffect(() => {
    if (!(words || searching) || !focused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      cancel();
      return true;
    });
    return () => sub.remove();
  });

  // The field and what follows slide up as the title folds away (and back down when it returns).
  const layout = reduced ? undefined : LinearTransition.duration(220);
  const collapsed = searching || words;
  return (
    <LargeTitleScreen title={t("mobile.find.title")} collapsed={collapsed}>
      <Animated.View layout={layout}>
        <View style={styles.search}>
          <SearchField
            ref={field}
            value={q}
            onChangeText={change}
            onSubmitEditing={remember}
            placeholder={t("mobile.find.placeholder")}
            onFocus={() => setSearching(true)}
            onCancel={cancel}
            showCancel={collapsed}
            autoCapitalize="none"
          />
        </View>
        {chips.length > 0 ? (
          <FilterChips
            chips={chips}
            onRemove={(c) => setChips(chips.filter((x) => searchChipKey(x) !== searchChipKey(c)))}
          />
        ) : null}
        {typingOperator(q, searchingWords) ? (
          <OperatorPicker
            text={q}
            directory={directory}
            words={searchingWords}
            onPick={(chip, rest) => {
              setChips(dedupe([...chips, chip]));
              setQ(rest);
            }}
          />
        ) : chips.length > 0 ? (
          <FilteredResults
            chips={chips}
            text={text}
            directory={directory}
            sort={searchSortFor(sort, text)}
            onSort={setSort}
            onClear={() => setChips([])}
            onOpen={remember}
          />
        ) : words ? (
          <SearchResults q={text} />
        ) : (
          <View>
            <RecentSearches recent={recent} onPick={pickRecent} onClear={() => saveRecent([])} />
            <FilterWords onPick={startOp} />
            {list.rows.length > 0 ? (
              <View>
                <SectionHeader title={t("mobile.find.conversations")} />
                {list.rows
                  .filter((r) => kindOf(r) !== "threads")
                  .slice(0, RECENT)
                  .map((r, i) => (
                    <ConversationRowView key={r.key} row={r} divider={i > 0} live={false} />
                  ))}
              </View>
            ) : null}
          </View>
        )}
      </Animated.View>
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 8 },
});
