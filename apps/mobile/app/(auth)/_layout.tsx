import { Stack } from "expo-router";
import { useTheme } from "@/ui/theme";

/** Sign in and sign up (forgot password in place), your server and the QR scanner: the platform's push between them. */
export default function AuthLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
