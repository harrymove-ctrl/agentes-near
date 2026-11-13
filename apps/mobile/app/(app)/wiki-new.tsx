import { useLocalSearchParams } from "expo-router";
import { WikiNewSheet } from "@/features/wiki/WikiWrite";

/** "Nova página" (a form sheet, presentation set in `_layout`): `?title=` from a link, `?folder=` from a folder. */
export default function WikiNewRoute() {
  const { title, folder } = useLocalSearchParams<{ title?: string; folder?: string }>();
  return <WikiNewSheet title={title ?? ""} folder={folder ?? ""} />;
}
