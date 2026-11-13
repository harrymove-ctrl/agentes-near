import { type ErrorBoundaryProps, useLocalSearchParams } from "expo-router";
import { ChatScreen } from "@/features/chat/ChatScreen";
import { chatHref } from "@/features/links/logic";
import { useRememberPlace } from "@/features/me/useStart";
import { isSafeId } from "@/features/shared/logic";
import { FocusLive } from "@/features/shared/parts";
import { ScreenError } from "@/features/shared/ScreenError";

/** A conversation that breaks while drawing shows what happened in its own screen; back still goes back. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ScreenError {...props} />;
}

/**
 * A conversation (deep link `agenteschat://chat/<channelId>?thread=<rootId>`). `handoff=<id>`: an agent's
 * request for help in its browser, whose card opens in place, in control. `m=<id>`: open at that message.
 */
export default function ChatRoute() {
  const { channelId, thread, handoff, m } = useLocalSearchParams<{
    channelId: string;
    thread?: string;
    handoff?: string;
    m?: string;
  }>();
  const threadId = isSafeId(thread) ? thread : null;
  // Where "Onde você parou" opens the next time the app starts (ADR 0108).
  useRememberPlace(chatHref(channelId, threadId));
  return (
    <FocusLive>
      <ChatScreen
        key={`${channelId}:${thread ?? ""}`}
        channelId={channelId}
        threadId={threadId}
        handoffId={isSafeId(handoff) ? handoff : null}
        focusId={isSafeId(m) ? m : null}
      />
    </FocusLive>
  );
}
