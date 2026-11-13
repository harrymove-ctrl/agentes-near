import { useMembers, useRoles } from "@agenteschat/client";
import { isSolo, keeperKey, keeperName, othersHere } from "@agenteschat/client/lib/personal-view";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/**
 * What a personal workspace's view reads (ADR 0159): `personal`; `others`, how many other people are members
 * (undefined while that loads); `solo`, the viewer alone in a personal workspace, which a control may leave the screen
 * for only while it holds its default (`isSolo`). Only the view: nothing here changes who may do what.
 */
export function usePersonalView() {
  const { org, me } = useOrg();
  const members = useMembers(org.id);
  const personal = isPersonal(org);
  const others = members.data ? othersHere(members.data, me.user.id) : undefined;
  return { personal, others, solo: isSolo(org, others) };
}

/**
 * Who runs a personal workspace besides the viewer, by first name (`keeperName`), for the notes a family member meets;
 * null in a team's workspace, while loading, or when it isn't one person.
 */
export function useKeeperName(): string | null {
  const { org, me } = useOrg();
  const members = useMembers(org.id);
  const roles = useRoles(org.id);
  if (!isPersonal(org) || !members.data) return null;
  return keeperName(members.data, me.user.id, roles.data?.roles ?? []);
}

/** "Only admins change this", in a personal workspace naming who runs it (`keeperKey`, ADR 0159). */
export function useAdminsLock(): string {
  const { t } = useTranslation();
  const { org } = useOrg();
  const keeper = useKeeperName();
  return t(keeperKey(org, keeper, "agentPage.lock.admins"), { keeper });
}
