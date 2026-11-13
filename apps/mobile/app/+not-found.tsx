import { Redirect } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useSession } from "@/providers/session";
import { Button, EmptyState, useTheme } from "@/ui";
import { router } from "@/ui/navigation";

/**
 * A link to something the app doesn't have (or no longer has). Signed out, it goes to the sign-in, as the
 * app's own screens do (`app/_layout.tsx`).
 * Like a native empty state: the sky, the two lines and the way back, centered on the screen.
 */
export default function NotFound() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const session = useSession();
  if (session.pending) return <View style={[styles.screen, { backgroundColor: colors.bg }]} />;
  if (!session.signedIn) return <Redirect href="/sign-in" />;
  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <EmptyState
        title={t("mobile.notFound.title")}
        subtitle={t("mobile.notFound.subtitle")}
        sky
        action={<Button variant="primary" label={t("mobile.notFound.home")} onPress={() => router.replace("/")} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", padding: 24 },
});
