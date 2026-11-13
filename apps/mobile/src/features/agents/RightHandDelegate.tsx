import type { CardDelegate } from "@agenteschat/client";
import { useUndoRightHand } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { EventPillAction } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useMeId } from "../shared/hooks";

/**
 * Desfazer on what the right hand approved (ADR 0139 §2), while it lasts: for the person it decided for, and admins.
 * `undo` is null when it can't be undone (any more, or by this person).
 */
function useDelegateUndo(d: CardDelegate | null | undefined) {
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const failed = useFailed();
  const undo = useUndoRightHand(orgId);
  const id = d?.decisionId;
  const open =
    d?.state === "approved" &&
    id &&
    d.undoUntil &&
    Date.parse(d.undoUntil) > Date.now() &&
    (d.forUserId === meId || can(org, "manage_agents"));
  return { undo: open && id ? () => undo.mutate(id, { onError: failed }) : null, pending: undo.isPending };
}

/** "Undo" as an action of the decided request's pill (`AskDone`), or nothing (no empty slot in the pill). */
export function useDelegateUndoAction(d: CardDelegate | null | undefined): ReactNode {
  const { t } = useTranslation();
  const { undo, pending } = useDelegateUndo(d);
  return undo ? <EventPillAction label={t("rightHandApprovals.card.undo")} loading={pending} onPress={undo} /> : null;
}
