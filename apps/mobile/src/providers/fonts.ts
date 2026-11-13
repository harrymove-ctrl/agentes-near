import { useFonts } from "expo-font";
import { fonts } from "@/ui/theme";

/**
 * The brand fonts as static files (React Native has no variable axes): Funnel Display Light for large
 * titles and Doto at ROND 100 / weight 600 for every count. Body and UI text use the system font.
 * The family names are the keys of `fonts` in the theme. SIL Open Font License (assets/fonts/OFL-*.txt).
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts({
    [fonts.display]: require("../../assets/fonts/FunnelDisplay-Light.ttf"),
    [fonts.dot]: require("../../assets/fonts/Doto-Rond100-SemiBold.ttf"),
  });
  // A font that fails to load falls back to the system font: never block the app on it.
  return loaded || Boolean(error);
}
