import { earlyAccessToken } from "@agenteschat/client/lib/guards";
import { useLocalSearchParams } from "expo-router";
import { AuthFlow } from "@/features/auth/AuthFlow";

/** Criar conta: the same flow as Entrar, with a welcome for new people. `access`: an early-access link's token. */
export default function SignUp() {
  const params = useLocalSearchParams<{ email?: string; access?: string }>();
  return (
    <AuthFlow
      start="up"
      email={typeof params.email === "string" ? params.email : undefined}
      access={earlyAccessToken(params.access)}
    />
  );
}
