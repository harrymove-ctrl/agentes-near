import { type DeletionProofInput, useAccountDeletionPlan, useApi, useAuthConfig, useMe } from "@agenteschat/client";
import {
  type AccountDeletionLine,
  accountDeletionLines,
  deletableWorkspaces,
  deletionDueFrom,
  workspaceLabel,
  workspaceNotes,
} from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { settingUp } from "@agenteschat/client/lib/guards";
import { Alert, Button, Dialog, DialogBody, DialogFooter, Icon, type IconName, Locked } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DeletionLine, DeletionProofField, ProofButton, useDeletionProof } from "@/components/DeleteWorkspace";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./deletion.css";

const LINE_ICON: Record<AccountDeletionLine["kind"], IconName> = {
  when: "clock",
  closes: "trash",
  leaves: "arrowRight",
  computers: "computer",
  staysBehind: "key",
  plan: "coin",
  messages: "message",
  serverOwner: "settings",
};

/** The link that deletes one workspace, not the account: its Geral, or its onboarding while it's still being set up. */
function DeleteOrgLink({ orgId, name, setup }: { orgId: string; name: string; setup: boolean }) {
  const { t } = useTranslation();
  const label = t("deleteAccount.deleteOrg", { name });
  return setup ? (
    <Link className="ac-link" to="/onboarding" search={{ delete: 1 }}>
      {label}
    </Link>
  ) : (
    <Link
      className="ac-link"
      to="/org/$orgId/settings/$section"
      params={{ orgId, section: "general" }}
      search={{ delete: 1 }}
    >
      {label}
    </Link>
  );
}

/**
 * Deleting my account (Configurações › Sua conta), from its preflight. The title and first line say it's the whole
 * account, not one workspace. A workspace that still needs me as its only owner comes first, as a checklist with its
 * two ways out (one still being set up is finished or deleted in its onboarding). Otherwise each workspace that closes
 * with what it holds, what I leave, the computers removed, what stays behind with where to disconnect it, where plans
 * are billed that mine stop renewing, and that my messages stay, then the way to delete just a workspace, the code
 * emailed to me (or my password, where no email goes) and the button. Done: to the sign-in, which brings it back for 7 days.
 */
export function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const config = useAuthConfig().data;
  const me = useMe().data;
  const plan = useAccountDeletionPlan(open);
  const del = useMutation({
    mutationFn: (proof: DeletionProofInput) => api.account.delete(proof),
    meta: { silent: true },
    onSuccess: async () => {
      qc.clear();
      await navigate({ to: "/login" });
      toast.show(t("deleteAccount.deleted", { date: formatShortDate(i18n.language, deletionDueFrom()) }));
    },
    // A workspace that came to need me since the preflight: it shows as a blocker.
    onError: (error) => {
      if (errorCode(error) === "sole_owner") void plan.refetch();
    },
  });
  const proof = useDeletionProof(open, null, del.error);
  const { reset } = del;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);
  const data = plan.data;
  const blockers = data?.soleOwner ?? [];
  const notes = workspaceNotes(t, i18n.language, me?.organizations ?? []);
  const named = (o: { id: string; name: string }) => workspaceLabel(o.name, notes.get(o.id));
  const lines = data
    ? accountDeletionLines(t, i18n.language, data, {
        cloud: config?.workspaceComputer === true,
        billing: Boolean(config?.billingUrl),
        notes,
      })
    : [];
  const ready = data !== undefined && blockers.length === 0;
  const inSetup = (orgId: string) => me?.organizations.some((o) => o.id === orgId && settingUp(o)) === true;
  const own = deletableWorkspaces(me?.organizations ?? []);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("deleteAccount.title")}
      description={t("deleteAccount.intro")}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && proof.ready && !del.isPending) del.mutate(proof.input);
        }}
      >
        <Locked when={del.isPending}>
          <DialogBody>
            {plan.isError ? (
              <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
            ) : !data ? (
              <LoadingLine width={320} />
            ) : blockers.length > 0 ? (
              <>
                <h3 className="ac-card__title">{t("deleteAccount.blockers")}</h3>
                <ul className="deletion-blockers">
                  {blockers.map((o) =>
                    inSetup(o.id) ? (
                      <DeletionLine key={o.id} icon="stageTodo">
                        {t("deleteAccount.soleOwnerSettingUp", { name: named(o) })}
                        <span className="deletion-acts">
                          <Link className="ac-link" to="/onboarding">
                            {t("deleteAccount.finishSetup")}
                          </Link>
                          <DeleteOrgLink orgId={o.id} name={named(o)} setup />
                        </span>
                      </DeletionLine>
                    ) : (
                      <DeletionLine key={o.id} icon="stageTodo">
                        {t("deleteAccount.soleOwner", { name: named(o) })}
                        <span className="deletion-acts">
                          <Link
                            className="ac-link"
                            to="/org/$orgId/settings/$section"
                            params={{ orgId: o.id, section: "members" }}
                          >
                            {t("deleteAccount.openPeople")}
                          </Link>
                          <DeleteOrgLink orgId={o.id} name={named(o)} setup={false} />
                        </span>
                      </DeletionLine>
                    ),
                  )}
                </ul>
              </>
            ) : (
              <>
                <ul className="deletion-lines">
                  {lines.map((line) => (
                    <DeletionLine key={`${line.kind}:${line.text}`} icon={LINE_ICON[line.kind]}>
                      {line.text}
                      {line.links && (
                        <span className="deletion-acts">
                          {line.links.map((l) => (
                            <Link
                              key={l.label}
                              className="ac-link"
                              to="/org/$orgId/settings/$section"
                              params={{ orgId: l.orgId, section: l.section }}
                            >
                              {l.label}
                            </Link>
                          ))}
                        </span>
                      )}
                    </DeletionLine>
                  ))}
                </ul>
                {own.length > 0 && (
                  <div className="ac-iconline deletion-note">
                    <Icon name="info" size={16} />
                    <span>
                      {t("deleteAccount.oneWorkspace")}
                      <span className="deletion-acts">
                        {own.map((o) => (
                          <DeleteOrgLink key={o.id} orgId={o.id} name={named(o)} setup={settingUp(o)} />
                        ))}
                      </span>
                    </span>
                  </div>
                )}
                <DeletionProofField proof={proof} />
                {proof.alert && errorCode(del.error) !== "sole_owner" && <Alert>{errorText(t, del.error)}</Alert>}
              </>
            )}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {blockers.length > 0 ? t("common.close") : t("common.cancel")}
          </Button>
          {ready && (
            <ProofButton proof={proof} enabled busy={del.isPending}>
              {t("deleteAccount.submit")}
            </ProofButton>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * "Apagar conta" where Sua conta is out of reach (`accountOutOfReach`): a closed workspace's screen and the onboarding,
 * for someone with no workspace that opens. `trigger` draws the button; the dialog is kept in the address
 * (`?account=delete`), so a sign-in again (adding a password may ask for one) comes back to it.
 */
export function DeleteAccountEntry({ trigger }: { trigger: (open: () => void) => ReactNode }) {
  const [account, setAccount] = useOpenParam("account");
  return (
    <>
      {trigger(() => setAccount("delete"))}
      <DeleteAccountDialog open={account === "delete"} onClose={() => setAccount(null)} />
    </>
  );
}
