import type { AgentAction, AgentActionKind, AgentActionTarget } from "@agenteschat/client";
import type { IconName } from "@/ui";
import { type AppHref, chatHref, routineHref } from "../links/logic";
import { isSafeId } from "../shared/logic";

/**
 * The receipts under an agent's reply (ADR 0037 round 2), laid out for the phone: one change shows as one sunken row,
 * two or more as a group with "N mudanças · há X".
 */

export type ReceiptLayout = "none" | "one" | "group";

export const receiptLayout = (list: readonly AgentAction[] | undefined): ReceiptLayout =>
  !list || list.length === 0 ? "none" : list.length === 1 ? "one" : "group";

/** The icon tile per kind (issue dot, flag for a changed issue, brain for memory…). */
export const RECEIPT_ICONS: Record<AgentActionKind, IconName> = {
  "issue.created": "issue",
  "issue.updated": "flag",
  "issue.assigned": "agent",
  "memory.saved": "brain",
  "memory.updated": "brain",
  "memory.forgotten": "brain",
  "routine.created": "clock",
  "routine.updated": "clock",
  "routine.deleted": "clock",
  "channel.agent_added": "hash",
  "channel.created": "hash",
  "wiki.page_created": "doc",
  "wiki.page_edited": "doc",
  "thread.renamed": "chat",
  "thread.closed": "chat",
  "skill.created": "brain",
  "skill.updated": "brain",
  "agent.settings_changed": "agent",
  "pr.merged": "code",
  "workspace.changed": "shield",
};

/** A kind a newer server sends that this build doesn't know yet gets the plain check. */
export const receiptIcon = (kind: AgentActionKind): IconName => RECEIPT_ICONS[kind] ?? "checkc";

/**
 * Where tapping the target goes, the thing itself, where it is fixed or removed: the issue, the routine, the channel,
 * the thread, the memory or the skill (the phone has no wiki screens yet: null, the text is not a link).
 */
export function targetHref(target: AgentActionTarget, channelId: string): AppHref | null {
  switch (target.type) {
    case "issue":
      return typeof target.number === "number" ? `/issues/${target.number}` : null;
    case "routine":
      return isSafeId(target.id) ? routineHref(target.id) : null;
    case "channel":
      return target.id ? chatHref(target.id) : null;
    case "thread":
      return target.id ? chatHref(channelId, target.id) : null;
    case "memory":
      return isSafeId(target.id) ? `/memory/${target.id}` : null;
    case "skill":
      return isSafeId(target.id) ? `/settings/skills/${target.id}` : null;
    default:
      return null;
  }
}

/** "há X" of the group: from its first change. */
export function groupStart(list: readonly AgentAction[]): string | null {
  let first: string | null = null;
  for (const a of list) if (!first || a.createdAt < first) first = a.createdAt;
  return first;
}

export { boldRuns } from "@agenteschat/client/lib/actions";
