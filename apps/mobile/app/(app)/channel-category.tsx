import { Redirect, useLocalSearchParams } from "expo-router";
import { PickCategoryScreen } from "@/features/categories/CategoryScreens";

/** "Categoria" of a channel (`?channelId=`), from its ⋯ sheet or a long press on the home (ADR 0080). */
export default function ChannelCategoryRoute() {
  const { channelId } = useLocalSearchParams<{ channelId?: string }>();
  if (!channelId) return <Redirect href="/" />;
  return <PickCategoryScreen channelId={channelId} />;
}
