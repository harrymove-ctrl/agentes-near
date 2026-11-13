import { ApiError, type OrgSummary, useApi, useAuthConfig, useDeleteWorkspace, useMe } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { deletionDueFrom, deletionProof, proofToSend } from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate, formatTime } from "@agenteschat/client/lib/format";
import { sendsEmail, typedCode } from "@agenteschat/client/lib/join-requests";
import { matchesName } from "@agenteschat/client/lib/text";
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  type IconName,
  InfoHint,
  Input,
  Locked,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AddPasswordDialog } from "@/components/AddPassword";
import { useNow } from "@/hooks/useNow";
import { saveExport } from "@/lib/workspace-export";
import "./deletion.css";

/**
 * Deleting a workspace (owners): what goes, until when any owner can restore it, its export, its name typed to
 * confirm, then the code emailed to them (or their password, where no email goes). It turns read-only for everyone at
 * once and goes for good 7 days later; `onDeleted` follows (the line on top of the workspace shows by itself).
 */
export function DeleteWorkspaceDialog({
  org,
  open,
  onClose,
  onDeleted = onClose,
}: {
  org: Pick<OrgSummary, "id" | "name">;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const config = useAuthConfig().data;
  const del = useDeleteWorkspace(org.id);
  const proof = useDeletionProof(open, org.id, del.error);
  const [name, setName] = useState("");
  const { reset } = del;
  useEffect(() => {
    if (!open) return;
    setName("");
    reset();
  }, [open, reset]);
  const edition = computerEdition(undefined, config?.workspaceComputer);
  const due = deletionDueFrom();
  const named = matchesName(name, org.name);
  const submit = () => del.mutate(proof.input, { onSuccess: onDeleted });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("deleteOrg.title", { name: org.name })}
      description={t("deleteOrg.undo", {
        date: formatShortDate(i18n.language, due),
        time: formatTime(i18n.language, due),
      })}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (named && proof.ready && !del.isPending) submit();
        }}
      >
        <Locked when={del.isPending}>
          <DialogBody>
            <ul className="deletion-lines">
              <DeletionLine icon="message">{t("deleteOrg.goes.content")}</DeletionLine>
              <DeletionLine icon="members">
                {t(sendsEmail(config) ? "deleteOrg.goes.people" : "deleteOrg.goes.peopleQuiet")}
              </DeletionLine>
              {edition && (
                <DeletionLine icon="computer">
                  {t(edition === "cloud" ? "deleteOrg.goes.computer" : "deleteOrg.goes.computers")}
                </DeletionLine>
              )}
              <DeletionLine icon="plug">
                <span className="ac-hintline">
                  {t("deleteOrg.goes.connectors")}
                  <InfoHint name={t("common.about", { label: t("deleteOrg.goes.connectors") })}>
                    {t("common.joinSentences", { a: t("deleteOrg.bucket"), b: t("deleteOrg.github") })}
                  </InfoHint>
                </span>
              </DeletionLine>
              {config?.billingUrl && <DeletionLine icon="coin">{t("deleteOrg.plan")}</DeletionLine>}
            </ul>
            <p className="small muted deletion-export">
              <Trans
                i18nKey="deleteOrg.export"
                components={{
                  export: (
                    <button type="button" className="ac-link ac-link--muted" onClick={() => saveExport(api, org.id)} />
                  ),
                }}
              />
            </p>
            <Field label={t("deleteOrg.type", { name: org.name })}>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <DeletionProofField proof={proof} />
            {proof.alert && <Alert>{errorText(t, del.error)}</Alert>}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <ProofButton proof={proof} enabled={named} busy={del.isPending}>
            {t("deleteOrg.submit")}
          </ProofButton>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** A line of what deleting does, its icon on the text's first line. */
export function DeletionLine({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li className="ac-iconline">
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </li>
  );
}

/** Codes of a refusal the proof's own field says (the rest show as an alert). */
const PROOF_REFUSALS = new Set([
  "reauth.code",
  "reauth.code_wrong",
  "reauth.code_expired",
  "reauth.code_tries",
  "reauth.password",
]);

/**
 * The proof a deletion takes, while its dialog is `open` (ADR 0088 §2): the code emailed to the person, for deleting
 * the workspace `orgId` (their account when null), or where the server sends no email their password, which an
 * account without one adds first. `refused`: the deletion's error. `input` is what the deletion sends, once `ready`.
 */
export function useDeletionProof(open: boolean, orgId: string | null, refused: unknown) {
  const api = useApi();
  const config = useAuthConfig().data;
  const me = useMe().data;
  const kind = deletionProof(config, me?.user.hasPassword);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const codeOut = (email: string, resendIn: number) => setSent({ email, resendAt: Date.now() + resendIn * 1000 });
  const send = useMutation({
    mutationFn: () => (orgId ? api.orgs.deletionCode(orgId) : api.account.deletionCode()),
    meta: { silent: true },
    onSuccess: (r) => {
      codeOut(r.email, r.resendIn);
      setCode("");
    },
    // A code went out a moment ago (a reload, another tab): that one is still good.
    onError: (e) => {
      const retryIn = e instanceof ApiError && e.code === "reauth.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) codeOut(me?.user.email ?? "", retryIn);
    },
  });
  const { reset } = send;
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setCode("");
    setSent(null);
    reset();
  }, [open, reset]);
  const why = errorCode(refused);
  // Each refusal of a code empties the field for the next try.
  useEffect(() => {
    if (errorCode(refused)?.startsWith("reauth.code")) setCode("");
  }, [refused]);
  return {
    kind,
    email: me?.user.email ?? "",
    ...proofToSend(kind, { sent: sent !== null, code, password }),
    sent,
    send,
    code: { value: code, onChange: (value: string) => setCode(typedCode(value)) },
    password: { value: password, onChange: setPassword },
    adding: { open: adding, set: setAdding },
    // A code still good from a moment ago only waits: the countdown says it.
    refused:
      why && PROOF_REFUSALS.has(why) ? refused : errorCode(send.error) === "reauth.code_wait" ? null : send.error,
    alert: why !== undefined && !PROOF_REFUSALS.has(why),
  };
}

type DeletionProofState = ReturnType<typeof useDeletionProof>;

/**
 * The proof's field: before a code goes out, where it will go; then the code, with another to ask for after its wait;
 * the password; or why a password is needed first, with its dialog.
 */
export function DeletionProofField({ proof }: { proof: DeletionProofState }) {
  const { t } = useTranslation();
  const left = proof.sent ? Math.max(0, proof.sent.resendAt - Date.now()) : 0;
  // A repaint every second while the countdown runs; the time itself is read just above.
  useNow(left > 0 ? 1000 : false);
  const said = proof.refused ? errorText(t, proof.refused) : undefined;
  if (proof.kind === "addPassword")
    return (
      <>
        <p className="ac-iconline deletion-note">
          <Icon name="lock" size={16} />
          <span>{t("proof.addPassword")}</span>
        </p>
        <AddPasswordDialog open={proof.adding.open} onClose={() => proof.adding.set(false)} />
      </>
    );
  if (proof.kind === "password")
    return (
      <Field label={t("proof.password")} error={said}>
        <Input
          type="password"
          autoComplete="current-password"
          value={proof.password.value}
          onChange={(e) => proof.password.onChange(e.target.value)}
        />
      </Field>
    );
  if (!proof.sent)
    return (
      <>
        <p className="ac-iconline deletion-note">
          <Icon name="mail" size={16} />
          <span>{t("proof.willSend", { email: proof.email })}</span>
        </p>
        {said && <Alert>{said}</Alert>}
      </>
    );
  return (
    <Field
      label={t("proof.code")}
      example={t("proof.sent", { email: proof.sent.email })}
      error={said}
      labelAside={
        <button
          type="button"
          className="ac-link ac-link--muted small"
          disabled={left > 0 || proof.send.isPending}
          onClick={() => proof.send.mutate()}
        >
          {left > 0 ? t("proof.resendIn", { time: formatTimeLeft(left) }) : t("proof.resend")}
        </button>
      }
    >
      <Input
        className="ac-input--code"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={proof.code.value}
        onChange={(e) => proof.code.onChange(e.target.value)}
      />
    </Field>
  );
}

/**
 * The dialog's button: "Send code" until one went out, "Add a password" where one is needed first, then the deletion
 * itself (`children`), once `enabled` (the dialog's own check) and the proof is ready.
 */
export function ProofButton({
  proof,
  enabled,
  busy,
  children,
}: {
  proof: DeletionProofState;
  enabled: boolean;
  busy: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (proof.kind === "addPassword")
    return (
      <Button type="button" variant="primary" onClick={() => proof.adding.set(true)}>
        {t("shell.addPassword")}
      </Button>
    );
  if (proof.kind === "code" && !proof.sent)
    return (
      <Button
        type="button"
        variant="primary"
        disabled={!enabled}
        loading={proof.send.isPending}
        onClick={() => proof.send.mutate()}
      >
        {t("proof.send")}
      </Button>
    );
  return (
    <Button type="submit" variant="danger" disabled={!enabled || !proof.ready || busy} loading={busy}>
      {children}
    </Button>
  );
}
