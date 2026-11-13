import { Redirect, useLocalSearchParams } from "expo-router";
import { wikiSlugOf } from "@/features/wiki/logic";
import { WikiMoveScreen } from "@/features/wiki/WikiScreen";

/** "Renomear ou mover" a wiki page (`?slug=`), from its ⋯ menu. */
export default function WikiMoveRoute() {
  const page = wikiSlugOf(useLocalSearchParams<{ slug?: string }>().slug);
  if (page === null) return <Redirect href="/wiki" />;
  return <WikiMoveScreen slug={page} />;
}
