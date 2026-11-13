import { INVITATION_MAIL_PARAM, invitationMailProof } from "@agenteschat/client/lib/guards";
import { useLocalSearchParams } from "expo-router";
import { InviteScreen } from "@/features/auth/InviteScreen";
import { isInviteToken } from "@/features/auth/links";
import { ResetPasswordScreen } from "@/features/auth/ResetPasswordScreen";

/** `https://app.agentes.chat/invite/{token}` opened in the app, signed in or not. */
export default function InviteRoute() {
  const params = useLocalSearchParams<{ token?: string; [INVITATION_MAIL_PARAM]?: string }>();
  const { token } = params;
  // A malformed link reads like an expired one (the screen offers the way back).
  return isInviteToken(token) ? (
    <InviteScreen token={token} mail={invitationMailProof(params[INVITATION_MAIL_PARAM])} />
  ) : (
    <ResetPasswordScreen token={null} />
  );
}
