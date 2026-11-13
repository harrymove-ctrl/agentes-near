import { Redirect, useLocalSearchParams } from "expo-router";
import { WikiAgentsScreen } from "@/features/wiki/WikiBulk";

/** Which agents read the pages chosen in the wiki (`?ids=` comma-separated). */
export default function WikiAgentsRoute() {
  const ids = (useLocalSearchParams<{ ids?: string }>().ids ?? "").split(",").filter(Boolean);
  if (ids.length === 0) return <Redirect href="/wiki" />;
  return <WikiAgentsScreen ids={ids} />;
}
