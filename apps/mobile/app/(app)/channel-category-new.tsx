import { useLocalSearchParams } from "expo-router";
import { NewCategoryScreen } from "@/features/categories/CategoryScreens";

/** "Nova categoria" (admins), taking `?channelId=` along when it comes from a channel's "Categoria". */
export default function NewChannelCategoryRoute() {
  const { channelId } = useLocalSearchParams<{ channelId?: string }>();
  return <NewCategoryScreen {...(channelId ? { channelId } : {})} />;
}
