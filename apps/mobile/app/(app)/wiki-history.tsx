import { Redirect, useLocalSearchParams } from "expo-router";
import { wikiSlugOf } from "@/features/wiki/logic";
import { WikiHistoryScreen } from "@/features/wiki/WikiScreen";

/** A wiki page's history (`?slug=`), from its ⋯ menu or the row under the page. */
export default function WikiHistoryRoute() {
  const page = wikiSlugOf(useLocalSearchParams<{ slug?: string }>().slug);
  if (page === null) return <Redirect href="/wiki" />;
  return <WikiHistoryScreen slug={page} />;
}
