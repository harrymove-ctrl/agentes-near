import { LEVELS, type Level } from "@agenteschat/client/lib/access-levels";
import type { TFunction } from "i18next";
import type { IconName } from "@/ui";
import { pickOne } from "../shared/PickerSheet";

/** Each level's mark in the picker: nothing, reading, writing. */
const LEVEL_ICON: Record<Level, IconName> = { none: "eyeoff", read: "eye", write: "pen" };

/**
 * An agent's level on a service or a mailbox, in the app's picker: the three levels in the web's words, each with its
 * mark, the one in use checked. Resolves with the level, or null when cancelled.
 */
export async function pickLevel(t: TFunction, title: string, current: string | null): Promise<Level | null> {
  const key = await pickOne({
    title,
    value: current,
    options: LEVELS.map((l) => ({
      key: l,
      label: t(`access.level.${l}`),
      leading: { kind: "icon" as const, name: LEVEL_ICON[l] },
    })),
  });
  return LEVELS.find((l) => l === key) ?? null;
}
