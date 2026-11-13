import type { Actor } from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { Icon, type SelectOption } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

export const NO_ACTOR = "none";
export const actorKey = (a: Actor | null | undefined) => (a ? `${a.type}:${a.id}` : NO_ACTOR);
export function actorFromKey(key: string): Actor | null {
  const [type, id] = key.split(":");
  return (type === "agent" || type === "person") && id ? { type, id } : null;
}

/** People and agents of the workspace for pickers and labels. */
export function useActors() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const name = (a: Actor) => dir.authorName({ type: a.type, id: a.id } as Parameters<typeof dir.authorName>[0]);
  // Keyed by who it is: a list of faces (`.map(… avatar)`) needs no key of its own.
  const avatar = (a: Actor, size: "xs" | "sm" = "xs") => (
    <ActorAvatar key={actorKey(a)} size={size} actor={a} name={name(a)} />
  );
  // The empty choice leads with a glyph in a face's room (a list gives every lead the faces' column), so every name
  // starts on one edge.
  const none = <Icon name="person" size={18} className="muted" />;
  /**
   * `current` (the value picked now) stays an option even when my lists leave that agent out. Faces are tiles (`sm`),
   * one size in every list, a menu's or a Select's.
   */
  const options = (withNone: boolean, current?: string): SelectOption[] => [
    ...(withNone ? [{ value: NO_ACTOR, label: t("issues.noAssignee"), leading: none }] : []),
    ...dir.members.map((m) => ({
      value: `person:${m.userId}`,
      label: m.name,
      leading: avatar({ type: "person", id: m.userId }, "sm"),
    })),
    ...dir.agents
      .filter((a) => listsAgent(org, a) || `agent:${a.id}` === current)
      .map((a) => ({
        value: `agent:${a.id}`,
        label: a.name,
        description: a.role ? t("issues.agentRole", { role: a.role }) : undefined,
        leading: avatar({ type: "agent", id: a.id }, "sm"),
      })),
  ];
  return { dir, name, options, avatar, meId: me.user.id };
}

/** Avatar + name, inline. */
export function ActorLabel({ actor }: { actor: Actor }) {
  const { name, avatar } = useActors();
  return (
    <span className="actor-label">
      {avatar(actor)}
      <span>{name(actor)}</span>
    </span>
  );
}
