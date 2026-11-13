import { type ApiClient, ApiProvider as SharedApiProvider } from "@agenteschat/client";
import { playAgentReaction } from "@agenteschat/ui";
import type { ReactNode } from "react";

export { useApi } from "@agenteschat/client";

/** The shared provider with the web's effects (an agent's face on 👍/👎). */
export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return (
    <SharedApiProvider client={client} onAgentReaction={playAgentReaction}>
      {children}
    </SharedApiProvider>
  );
}
