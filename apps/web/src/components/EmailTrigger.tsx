import type { MailAccount, MailFolder, Routine, RoutineEmailFilter } from "@agenteschat/client";
import { useAgentMail, useMailAccounts, useMailFolders } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { mailboxReader, triggerChoices } from "@agenteschat/client/lib/routines";
import { Field, Icon, Input, Select } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * "Quando chegar um email" (ADR 0038): which mailbox, which folder (the inbox
 * by default) and optional filters (de, assunto contém, texto contém).
 */
export interface EmailTriggerDraft {
  accountId: string;
  folder: string;
  filter: RoutineEmailFilter;
}

export const INBOX = "INBOX";

/** The inbox among a mailbox's folders (by role, then by name), or the IMAP name. */
export const inboxOf = (folders: MailFolder[] | undefined) =>
  folders?.find((f) => f.role === "inbox")?.id ?? folders?.find((f) => f.id.toUpperCase() === INBOX)?.id ?? INBOX;

export const isInbox = (folder: string) => folder.toUpperCase() === INBOX;

/** Only the filters that say something (empty ones are left out of the trigger). */
export function cleanFilter(filter: RoutineEmailFilter): RoutineEmailFilter {
  return {
    ...(filter.from && filter.from.length > 0 ? { from: filter.from } : {}),
    ...(filter.subject?.trim() ? { subject: filter.subject.trim() } : {}),
    ...(filter.text?.trim() ? { text: filter.text.trim() } : {}),
  };
}

export function EmailTriggerFields({
  value,
  onChange,
  agentId,
}: {
  value: EmailTriggerDraft;
  onChange: (value: EmailTriggerDraft) => void;
  /** The routine's agent: only the mailboxes it reads are offered (the server refuses the others). */
  agentId: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const accounts = useMailAccounts(org.id);
  const list = accounts.data ?? [];
  const reads = useAgentMail(org.id, agentId, Boolean(agentId) && list.length > 0);
  const { options, cantRead } = triggerChoices(
    list,
    agentId && reads.data ? mailboxReader(reads.data) : undefined,
    value.accountId,
  );
  const waiting = Boolean(agentId) && list.length > 0 && reads.isPending;
  const folders = useMailFolders(org.id, value.accountId || null);
  // The first mailbox the agent reads, and its inbox, until the person picks. The selects show them from the first
  // render, before these effects write them, so neither is ever an empty box.
  const first = waiting ? undefined : options[0];
  useEffect(() => {
    if (!value.accountId && first) onChange({ ...value, accountId: first.id, folder: "" });
  }, [value, first, onChange]);
  useEffect(() => {
    if (value.accountId && !value.folder && (folders.data || folders.isError))
      onChange({ ...value, folder: inboxOf(folders.data) });
  }, [value, folders.data, folders.isError, onChange]);
  if (accounts.isSuccess && list.length === 0) {
    return (
      <p className="newag__note ac-iconline">
        <Icon name="mail" size={16} />
        <span>
          {t("mail.routine.noMailbox")}{" "}
          <Link
            className="ac-link"
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "connectors" }}
          >
            {t("mail.routine.openConnectors")}
          </Link>
        </span>
      </p>
    );
  }
  const folderOptions = folders.data?.length
    ? folders.data.map((f) => ({
        value: f.id,
        label: isInbox(f.id) || f.role === "inbox" ? t("mail.routine.inbox") : f.name,
      }))
    : [
        {
          value: value.folder || INBOX,
          label: isInbox(value.folder || INBOX) ? t("mail.routine.inbox") : value.folder,
        },
      ];
  const setFilter = (filter: RoutineEmailFilter) => onChange({ ...value, filter });
  const access = cantRead && agentId && (
    <AgentAccessNote
      agentId={agentId}
      words={options.length === 0 ? "mail.routine.readsNone" : "mail.routine.cantRead"}
    />
  );
  if (options.length === 0 && access) return access;
  return (
    <div className="routine-email">
      <div className="grid-fields">
        <Field label={t("mail.routine.mailbox")} id="nr-mailbox">
          <Select
            value={value.accountId || first?.id}
            onValueChange={(accountId) => onChange({ ...value, accountId, folder: "" })}
            options={options.map((a) => ({ value: a.id, label: a.address }))}
            placeholder={waiting ? t("common.loading") : undefined}
            disabled={waiting}
          />
        </Field>
        <Field label={t("mail.routine.folder")} id="nr-folder">
          <Select
            value={value.folder || inboxOf(folders.data)}
            onValueChange={(folder) => onChange({ ...value, folder })}
            options={folderOptions}
          />
        </Field>
      </div>
      {access}
      <span className="ac-eyebrow">{t("mail.routine.filters")}</span>
      <AddressList
        id="nr-mail-from"
        label={t("mail.routine.from")}
        example={t("mail.routine.fromHelp")}
        values={value.filter.from ?? []}
        onChange={(from) => setFilter({ ...value.filter, from })}
      />
      <div className="grid-fields">
        <Field label={t("mail.routine.subject")} id="nr-mail-subject">
          <Input
            value={value.filter.subject ?? ""}
            onChange={(e) => setFilter({ ...value.filter, subject: e.target.value })}
          />
        </Field>
        <Field label={t("mail.routine.text")} id="nr-mail-text">
          <Input
            value={value.filter.text ?? ""}
            onChange={(e) => setFilter({ ...value.filter, text: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * The routine's agent can't read what its trigger needs (none of the mailboxes, the picked one, a connection): the
 * cause, and its access, where who connected it gives the agent access.
 */
export function AgentAccessNote({
  agentId,
  words,
  values,
}: {
  agentId: string;
  words:
    | "mail.routine.readsNone"
    | "mail.routine.cantRead"
    | "mail.routine.connectorReadsNone"
    | "mail.routine.connectorCantRead";
  values?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const name = useDirectory(org.id).agentById.get(agentId)?.name ?? "";
  return (
    <p className="newag__note ac-iconline">
      <Icon name="lock" size={16} />
      <span>
        {t(words, { ...agentGrammar(name), ...values })}{" "}
        <Link
          className="ac-link"
          to="/org/$orgId/agents/$agentId"
          params={{ orgId: org.id, agentId }}
          search={{ tab: "access" }}
        >
          {t("mail.routine.giveAccess")}
        </Link>
      </span>
    </p>
  );
}

/** "Quando chegar um email em ana@empresa.com (Clientes)": the folder only when it isn't the inbox. */
export function emailWhen(t: TFunction, routine: Routine, accounts: MailAccount[] | undefined) {
  if (routine.trigger.type !== "email") return "";
  const { accountId, folder } = routine.trigger;
  const address = accounts?.find((a) => a.id === accountId)?.address ?? t("mail.routine.unknownMailbox");
  return folder && !isInbox(folder)
    ? t("mail.routine.whenFolder", { address, folder })
    : t("mail.routine.when", { address });
}
