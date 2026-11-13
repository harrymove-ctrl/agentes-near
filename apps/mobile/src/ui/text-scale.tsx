import { createContext, type ReactNode, useContext } from "react";
import { useWindowDimensions } from "react-native";
import { APP_TEXT_SCALE, type AppTextSize } from "./type-scale";

/**
 * The person's text size for the whole app (`APP_TEXT_SCALE`): `Text` grows its variant by it, and whatever lines an
 * icon up with a text line (`textLineOf`) reads `useFontScale`, so both move together. 1 outside the provider.
 */
const TextScaleContext = createContext(1);

export function TextScaleProvider({ size, children }: { size: AppTextSize; children: ReactNode }) {
  return <TextScaleContext.Provider value={APP_TEXT_SCALE[size] ?? 1}>{children}</TextScaleContext.Provider>;
}

/** The app's own text multiplier (1 at the default size). */
export const useTextScale = () => useContext(TextScaleContext);

/** The system's text size times the app's: what a line of `Text` grows by, for `textLineOf`. */
export function useFontScale(): number {
  return useWindowDimensions().fontScale * useTextScale();
}
