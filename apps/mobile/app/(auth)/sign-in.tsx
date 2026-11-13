import { useLocalSearchParams } from "expo-router";
import { AuthFlow } from "@/features/auth/AuthFlow";

/** Entrar: the e-mail first, then the one step the server says it needs. */
export default function SignIn() {
  // From an invitation's link ("Já tem conta? Entrar", a request that ended): its e-mail, straight to the password.
  const params = useLocalSearchParams<{ email?: string }>();
  return <AuthFlow start="in" email={typeof params.email === "string" ? params.email : undefined} />;
}
