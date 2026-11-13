import { Redirect, useLocalSearchParams } from "expo-router";
import { EditCategoryScreen } from "@/features/categories/CategoryScreens";

/** One channel category (`?id=`): rename, move in the order, delete (admins). */
export default function EditChannelCategoryRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!id) return <Redirect href="/channel-categories" />;
  return <EditCategoryScreen categoryId={id} />;
}
