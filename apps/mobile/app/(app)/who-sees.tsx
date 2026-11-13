import { Redirect, useLocalSearchParams } from "expo-router";
import { WhoSeesScreen } from "@/features/shared/WhoSees";
import { wikiSlugOf } from "@/features/wiki/logic";

/** "Quem vê" a task (`?number=`) or a wiki page (`?slug=`). */
export default function WhoSeesRoute() {
  const params = useLocalSearchParams<{ number?: string; slug?: string }>();
  const number = Number(params.number);
  if (Number.isInteger(number) && number > 0) return <WhoSeesScreen number={number} />;
  const page = wikiSlugOf(params.slug);
  if (page === null) return <Redirect href="/issues" />;
  return <WhoSeesScreen slug={page} />;
}
