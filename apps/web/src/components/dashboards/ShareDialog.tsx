import type { DashboardSummary } from "@agenteschat/client";
import { dashboardAccessOf, editorsInput, useMembers, useShareDashboard } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Dialog, DialogBody, DialogFooter, Locked } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { copyText } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { AudienceFields, adminOf, audienceReady, type BoardAudience, roleNames, useCustomRoles } from "./parts";
import "@/pages/dashboards.css";

/** A board's own address, for "Copy link". */
export const dashboardUrl = (orgId: string, dashboardId: string) =>
  `${window.location.origin}/org/${orgId}/dashboards/${dashboardId}`;

/**
 * Share (ADR 0135 §8, §12): who sees the board and who edits it (anyone who sees it, only you and admins, or some
 * roles), as in New dashboard, then who has access with the choice on screen (each member: edits, sees, or doesn't
 * see, by the server's own rule), Copy link and Save. Only the board's owner and admins open it (`canManage`).
 */
export function ShareDashboardDialog({
  board,
  open,
  onClose,
}: {
  board: DashboardSummary;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("dashboards.share.title", { title: board.title })}
      closeLabel={t("common.close")}
      width={620}
      className="db-dialog"
    >
      {open && <ShareBody board={board} onClose={onClose} />}
    </Dialog>
  );
}

function ShareBody({ board, onClose }: { board: DashboardSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const roles = useCustomRoles(org.id);
  const members = useMembers(org.id);
  const share = useShareDashboard(org.id);
  const [draft, setDraft] = useState<BoardAudience>({
    audience: board.audience,
    roleIds: board.roleIds,
    editPolicy: board.editPolicy,
    editRoleIds: board.editRoleIds ?? [],
  });
  const people = [...(members.data ?? [])].sort(
    (a, b) => Number(b.userId === me.user.id) - Number(a.userId === me.user.id) || a.name.localeCompare(b.name),
  );
  const save = () =>
    share.mutate(
      {
        dashboardId: board.id,
        audience: draft.audience,
        roleIds: draft.audience === "roles" ? draft.roleIds : [],
        ...editorsInput(draft),
      },
      {
        onSuccess: (saved) => {
          toast.show(
            saved.audience === "workspace"
              ? t("dashboards.share.nowWorkspace", { title: saved.title })
              : saved.audience === "private"
                ? t("dashboards.share.nowPrivate", { title: saved.title })
                : t("dashboards.share.nowRoles", { title: saved.title, roles: roleNames(roles, saved.roleIds) }),
          );
          onClose();
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  return (
    <>
      <Locked when={share.isPending}>
        <DialogBody className="db-dialog__body">
          <AudienceFields value={draft} onChange={setDraft} saved={board.audience} />
          <div className="db-f">
            <span className="db-lbl" id={`share-access-${board.id}`}>
              {t("dashboards.share.access")}
            </span>
            <ul className="db-people" aria-labelledby={`share-access-${board.id}`}>
              {people.map((m) => {
                const access = dashboardAccessOf(
                  { userId: m.userId, roleIds: m.roleIds ?? [], admin: adminOf(m, roles) },
                  { kind: board.kind, ...draft, ownerUserId: board.ownerUserId },
                );
                const line = m.role === "owner" ? t("dashboards.share.owner") : roleNames(roles, m.roleIds ?? []);
                return (
                  <li key={m.userId} className="ac-mediarow ac-mediarow--row" data-on={access !== "none"}>
                    <span className="ac-mediarow__face">
                      <PersonAvatar id={m.userId} name={m.name} size="sm" />
                    </span>
                    <span className="ac-mediarow__head">
                      <b>{m.userId === me.user.id ? t("dashboards.share.you", { name: m.name }) : m.name}</b>
                      {line && <span className="ac-mediarow__meta">{line}</span>}
                    </span>
                    <span className="ac-mediarow__end db-people__can">{t(`dashboards.share.${access}`)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button
          variant="ghost"
          icon="link"
          onClick={() => void copyText(dashboardUrl(org.id, board.id), () => toast.show(t("dashboards.share.copied")))}
        >
          {t("dashboards.share.copyLink")}
        </Button>
        <span className="db-grow" />
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={share.isPending} disabled={!audienceReady(draft)} onClick={save}>
          {t("dashboards.share.save")}
        </Button>
      </DialogFooter>
    </>
  );
}
