import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import type { StickerLook, StickerMood } from "@agenteschat/ui/agent/stickers";
import { useTranslation } from "react-i18next";
import { useOrgMaybe } from "@/providers/org";
import { Button, EmptyState, type EmptyStateProps, type IconName } from "@/ui";
import { type EmptyPlace, firstUseCopy } from "./first-use";
import { useDirectory } from "./hooks";
import { agentLook } from "./logic";

/** Who stands over an empty place when it has no agent of its own: the right hand, else the default look. */
export function useEmptyLook(): StickerLook | true {
  const lodi = rightHandOf(useDirectory().agents);
  return lodi ? agentLook(lodi) : true;
}

/** A list that didn't load is not an empty one: what happened, and the way to ask again. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      size="inline"
      title={t("common.loadFailed")}
      action={<Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={onRetry} />}
    />
  );
}

/**
 * A place with nothing in it yet: the agent, its words, and the first step. With `acts` false the button is gone
 * (the server would refuse it) and the words say who does it.
 */
export function FirstUse({
  place,
  acts,
  label,
  onPress,
  icon,
  busy = false,
  size = "page",
  look,
  mood,
}: {
  place: EmptyPlace;
  acts: boolean;
  label?: string | undefined;
  onPress?: (() => void) | undefined;
  /** The button's words stand alone (no icon by default): the button ruler's one primary, at its full 48 height. */
  icon?: IconName;
  busy?: boolean;
  size?: EmptyStateProps["size"];
  look?: StickerLook;
  mood?: StickerMood;
}) {
  const { t } = useTranslation();
  const fallback = useEmptyLook();
  // A personal workspace's places speak to one person (ADR 0159).
  const copy = firstUseCopy(place, acts, isPersonal(useOrgMaybe()?.org));
  return (
    <EmptyState
      size={size}
      agent={look ?? fallback}
      {...(mood ? { mood } : {})}
      title={t(copy.title)}
      subtitle={t(copy.text)}
      {...(acts && label && onPress
        ? {
            action: (
              <Button
                variant="primary"
                size="md"
                {...(icon ? { icon } : {})}
                label={label}
                loading={busy}
                onPress={onPress}
              />
            ),
          }
        : {})}
    />
  );
}
