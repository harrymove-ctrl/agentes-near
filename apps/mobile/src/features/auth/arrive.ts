import type { ApiClient } from "@agenteschat/client";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";

/**
 * After an invitation or an approved request lets someone in: the workspace opens on its #general, where the
 * newcomer's welcome card greets them with who works there (ADR 0090, as on the web), instead of an empty Conversas.
 * The tabs come first (`/`), then #general pushed over them, so back is Conversas. A workspace without a #general
 * (renamed, archived) just opens.
 */
export async function arriveIn(api: ApiClient, orgId: string): Promise<void> {
  router.replace("/");
  const channels = await api.chat.channels(orgId).catch(() => []);
  const general = channels.find((c) => c.name === "general");
  if (general) router.push(chatHref(general.id));
}
