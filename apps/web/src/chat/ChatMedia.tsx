import type { MessageMedia } from "@agenteschat/client";
import { gifLabel, gifMediaUrl, stickerLabel } from "@agenteschat/client/lib/media";
import { AgentSticker, ChatGif } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

/** A sticker's side in a message (CSS pixels): bigger than an emoji, smaller than a GIF. */
export const MESSAGE_STICKER = 120;

/**
 * A message's GIF or sticker (ADR 0091). A GIF's file comes from our server (never the provider's address), at its
 * own proportions up to 300px, still with reduced motion until hovered or focused; once the server stops serving it
 * (GIFs turned off) its title stands in its place. A sticker is drawn from its agent's look, a former agent's too.
 */
export function ChatMedia({ media }: { media: MessageMedia }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (media.kind === "gif") {
    return (
      <ChatGif
        src={gifMediaUrl(org.id, media.id, "full")}
        still={gifMediaUrl(org.id, media.id, "still")}
        width={media.width}
        height={media.height}
        label={gifLabel(t, media.title)}
        title={media.title}
        mark={t("media.gifMark")}
        source={t("media.giphy")}
      />
    );
  }
  const agent = dir.anyAgent(media.agentId);
  return (
    <AgentSticker
      appearance={lookOf(agent)}
      mood={media.mood}
      size={MESSAGE_STICKER}
      seed={media.agentId}
      label={stickerLabel(t, agent?.name ?? t("channel.unknownAgent"), media.mood)}
      className="ac-msg-media"
    />
  );
}
