import { isEveryoneWord } from "@agenteschat/client/lib/everyone";
import { type AgentColor, Mention } from "@agenteschat/ui";
import { type ReactNode, useCallback } from "react";
import { ChannelRef } from "@/chat/ChannelRef";
import { renderIdRef } from "@/chat/IdRef";
import { ChartAccent, ChartMessage } from "@/components/ChartBlock";
import { type ChannelRenderer, Markdown, type WikiLinkRenderer } from "@/lib/markdown";

/**
 * Renders a message body as safe Markdown (bold, italic, `code`, ```blocks```,
 * lists, links, line breaks) with @mentions of the workspace's people (neutral) and agents (in their tone), #channel
 * links and an internal id as the pill of what it names (`IdRef`).
 * React elements only: HTML in a message is shown as text.
 */
export function MessageBody({
  body,
  resolveMention,
  mentionTone,
  renderMention,
  wikiLink,
  channelRefs,
  accent = "sky",
  pinFrom = null,
}: {
  body: string;
  /** A handle's name here; null for a handle of no one in this workspace (an X username), which stays plain text. */
  resolveMention?: (handle: string) => string | null;
  /** The mentioned agent's color: its chip takes that tone. */
  mentionTone?: (handle: string) => AgentColor | undefined;
  /** Replaces the plain chip (e.g. a chip that opens the profile card). */
  renderMention?: (handle: string, key: string) => ReactNode;
  /** `[[Título]]`: wiki link chips (with a preview on hover). */
  wikiLink?: WikiLinkRenderer;
  /** The message's `meta.channelRefs`: the channel each `#name` meant when written (a renamed one still links). */
  channelRefs?: Record<string, string>;
  /** The writing agent's color: its charts take its tones. */
  accent?: AgentColor;
  /** An agent's saved message: its charts can be pinned to a board (ADR 0135). */
  pinFrom?: { messageId: string; agentId: string } | null;
}) {
  const mention = useCallback(
    (handle: string, key: string) => {
      if (renderMention) return renderMention(handle, key);
      const name = resolveMention?.(handle);
      if (resolveMention && !name && !isEveryoneWord(handle)) return `@${handle}`;
      return (
        <Mention key={key} tone={mentionTone?.(handle)}>
          @{name ?? handle}
        </Mention>
      );
    },
    [resolveMention, mentionTone, renderMention],
  );
  const channel = useCallback<ChannelRenderer>(
    (name, text, key) => <ChannelRef key={key} name={name} text={text} refs={channelRefs} />,
    [channelRefs],
  );
  return (
    <ChartAccent.Provider value={accent}>
      <ChartMessage.Provider value={pinFrom}>
        <Markdown
          source={body}
          variant="message"
          mention={mention}
          channel={channel}
          wikiLink={wikiLink}
          idRef={renderIdRef}
        />
      </ChartMessage.Provider>
    </ChartAccent.Provider>
  );
}
