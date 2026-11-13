import { ConnectorOAuthReturn } from "@/features/connectors/OAuthReturn";

/** `agenteschat://connectors/oauth?state=…&code=…`: a sign-in that came back to the app by its link. */
export default function ConnectorOAuthRoute() {
  return <ConnectorOAuthReturn />;
}
