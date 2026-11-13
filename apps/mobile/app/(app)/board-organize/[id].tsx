import { Redirect, useLocalSearchParams } from "expo-router";
import { OrganizeScreen } from "@/features/dashboards/OrganizeScreen";
import { isSafeId } from "@/features/shared/logic";

/** "Organize" a dashboard (`/board-organize/<id>`, `home` for My Home), pushed from its "…". */
export default function BoardOrganizeRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <Redirect href="/dashboards" />;
  return <OrganizeScreen key={id} id={id} />;
}
