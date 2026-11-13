import { Redirect, useLocalSearchParams } from "expo-router";
import { wikiSlugOf } from "@/features/wiki/logic";
import { WikiWriteScreen } from "@/features/wiki/WikiWrite";

/** Writing a wiki page: `?slug=` edits one, `?title=&folder=&who=` writes a new one (from "Nova página"), `who` being who sees it. */
export default function WikiWriteRoute() {
  const { slug, title, folder, who } = useLocalSearchParams<{
    slug?: string;
    title?: string;
    folder?: string;
    who?: string;
  }>();
  if (slug !== undefined) {
    const page = wikiSlugOf(slug);
    if (page === null) return <Redirect href="/wiki" />;
    return <WikiWriteScreen key={page} slug={page} />;
  }
  if (!title?.trim()) return <Redirect href="/wiki" />;
  return <WikiWriteScreen title={title.trim()} folder={folder ?? ""} who={who} />;
}
