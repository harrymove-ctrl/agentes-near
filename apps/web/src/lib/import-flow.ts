import type { ImportCard } from "@agenteschat/client/lib/import/flow";
import type { PickedFile } from "@/lib/import";
import { filesFromDrop } from "@/lib/obsidian";

export * from "@agenteschat/client/lib/import/flow";

/**
 * Each card's tile: the app's official mark (apps/web/public/brands/README.md), and the maker's own dark
 * coloring where the mark would vanish on a dark theme.
 */
export const CARD_MARK: Record<Exclude<ImportCard, "other">, { icon: string; dark?: string }> = {
  "grok-bot": { icon: "/brands/grok-bot.svg", dark: "/brands/grok-bot-dark.svg" },
  "chatgpt-dots": { icon: "/brands/chatgpt-dots.svg" },
  openbotrun: { icon: "/brands/openbotrun.svg" },
  openmausbot: { icon: "/brands/openmausbot.svg" },
  hermes: { icon: "/brands/hermes.svg", dark: "/brands/hermes-dark.svg" },
  openclaw: { icon: "/brands/openclaw.svg" },
  paperclip: { icon: "/brands/paperclip.svg", dark: "/brands/paperclip-dark.svg" },
  agenteschat: { icon: "/favicon.svg" },
};

/** A drop as the import reads it: the files, or every file in the dropped folders, with its path. */
export async function droppedFiles(dt: DataTransfer): Promise<PickedFile[]> {
  // The entries are only readable during the drop event: both reads below start before any await.
  const folders = Array.from(dt.items ?? []).some((i) => i.webkitGetAsEntry?.()?.isDirectory);
  if (!folders) return Array.from(dt.files);
  const files = await filesFromDrop(dt);
  return Promise.all(files.map(async (f) => ({ path: f.path, file: await f.blob() })));
}
