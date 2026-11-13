import type { ReactNode } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SheetSurface } from "./SheetSurface";

export interface SheetScreenProps {
  children?: ReactNode;
  /** For a sheet presented with `"fitToContents"`: no scroll view, the sheet takes the content's own height. */
  fit?: boolean;
}

/**
 * The content of a route presented as a native form sheet (`useFormSheetOptions`): the system draws the
 * sheet, the drag to dismiss and the dimmed, scaled screen behind (the grabber too on iOS; `SheetSurface`
 * draws it on Android, with the sheet's colors). This is only the scrolling body (the first scroll view, so
 * dragging at its top edge moves the sheet), keyboard-aware. With `fit` it is a plain column the sheet
 * measures, so a short sheet ends where its content does on every screen size, with no empty band under it.
 */
export function SheetScreen({ children, fit }: SheetScreenProps) {
  const insets = useSafeAreaInsets();
  if (fit) {
    // iOS already adds the bottom inset to a sheet that fits its content; Android doesn't.
    const bottom = Platform.OS === "ios" ? 12 : 24 + insets.bottom;
    return (
      <SheetSurface>
        <View style={[styles.in, { paddingBottom: bottom }]}>{children}</View>
      </SheetSurface>
    );
  }
  return (
    <SheetSurface>
      <ScrollView
        style={styles.fill}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        {children}
      </ScrollView>
    </SheetSurface>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  in: { paddingHorizontal: 18, paddingTop: 24, gap: 12 },
});
