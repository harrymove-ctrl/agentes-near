import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Redirect, useLocalSearchParams } from "expo-router";
import { ConversationListScreen } from "@/features/chats/ConversationListScreen";
import { categoryOfListKind, isListKind } from "@/features/chats/logic";
import { ThreadsScreen } from "@/features/chats/ThreadsScreen";
import { useOrg } from "@/providers/org";

/**
 * A section's "Ver todos" from Conversas: all agents, channels or people, or one channel category's channels
 * (`category-<id>`, ADR 0080). Threads and missions are a tab; a personal workspace has no Threads tab (ADR 0159), so
 * its row in You › Work pushes them here.
 */
export default function ConversationListRoute() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const personal = isPersonal(useOrg().org);
  if (isListKind(kind)) return <ConversationListScreen kind={kind} />;
  const categoryId = categoryOfListKind(kind ?? "");
  if (categoryId) return <ConversationListScreen kind="channels" categoryId={categoryId} />;
  if (kind === "threads" && personal) return <ThreadsScreen pushed />;
  return <Redirect href={kind === "threads" ? "/threads" : "/"} />;
}
