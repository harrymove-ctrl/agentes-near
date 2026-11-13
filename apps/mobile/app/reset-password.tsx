import { useLocalSearchParams } from "expo-router";
import { ResetPasswordScreen } from "@/features/auth/ResetPasswordScreen";

/** `https://app.agentes.chat/reset-password?token=` opened in the app: a new password. */
export default function ResetPasswordRoute() {
  const { token, error } = useLocalSearchParams<{ token?: string; error?: string }>();
  return <ResetPasswordScreen token={!error && typeof token === "string" && token ? token : null} />;
}
