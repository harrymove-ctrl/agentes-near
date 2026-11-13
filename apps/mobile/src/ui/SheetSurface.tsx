import { type ReactNode, useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { sheetColors } from "./palette";
import { ThemeColorsOverride, useTheme } from "./theme";

/**
 * What a native form sheet's content sits in (`useFormSheetOptions`): the sheet's colors (in dark, a step above
 * the screen behind it and its cards one more, `sheetColors`) and, on Android, the grabber the system only
 * draws on iOS. Wraps the route's whole content; the grabber lies over its top edge and takes no touches (the
 * sheet itself is what drags).
 */
export function SheetSurface({ children }: { children: ReactNode }) {
  const { colors, scheme } = useTheme();
  const inside = useMemo(() => sheetColors(colors, scheme), [colors, scheme]);
  return (
    <ThemeColorsOverride colors={inside}>
      {children}
      {Platform.OS === "android" ? (
        <View pointerEvents="none" style={styles.grabberRow}>
          <View style={[styles.grabber, { backgroundColor: colors.grabber }]} />
        </View>
      ) : null}
    </ThemeColorsOverride>
  );
}

const styles = StyleSheet.create({
  // Where iOS draws its own: centered near the top edge, 36 × 5.
  grabberRow: { position: "absolute", top: 6, left: 0, right: 0, alignItems: "center" },
  grabber: { width: 36, height: 5, borderRadius: 2.5 },
});
