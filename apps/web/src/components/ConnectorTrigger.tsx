import type { CustomServer, Routine, RoutineConnectorTrigger } from "@agenteschat/client";
import { useAgentScopes, useCustomServers } from "@agenteschat/client";
import { connectionReader, triggerChoices } from "@agenteschat/client/lib/routines";
import { Field, Input, Select } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { AgentAccessNote } from "@/components/EmailTrigger";
import { useOrg } from "@/components/org-context";

/**
 * "Quando chegar um email no MillionSend" (ADR 0130): the connection, the inbox's address (any inbox when empty) and
 * the same optional filters as a mailbox's (de, assunto contém).
 */
export interface ConnectorTriggerDraft {
  connectionId: string;
  filter: RoutineConnectorTrigger["filter"];
}

export const MILLIONSEND_EMAIL: RoutineConnectorTrigger["event"] = "millionsend.email.received";

/** The workspace's connections whose received email can start a routine. */
export function useEmailEventConnections(orgId: string): CustomServer[] {
  const servers = useCustomServers(orgId);
  return (servers.data ?? []).filter((s) => s.events?.includes(MILLIONSEND_EMAIL));
}

/** Only the filters that say something. */
export const cleanConnectorFilter = (f: RoutineConnectorTrigger["filter"]): RoutineConnectorTrigger["filter"] => ({
  ...(f.to?.trim() ? { to: f.to.trim().toLowerCase() } : {}),
  ...(f.from?.length ? { from: f.from } : {}),
  ...(f.subject?.trim() ? { subject: f.subject.trim() } : {}),
});

export function ConnectorTriggerFields({
  value,
  onChange,
  agentId,
}: {
  value: ConnectorTriggerDraft;
  onChange: (value: ConnectorTriggerDraft) => void;
  /** The routine's agent: only the connections it reads are offered (the server refuses the others). */
  agentId: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const list = useEmailEventConnections(org.id);
  const grants = useAgentScopes(org.id, agentId, Boolean(agentId) && list.length > 0);
  const { options, cantRead } = triggerChoices(
    list,
    agentId && grants.data ? connectionReader(grants.data) : undefined,
    value.connectionId,
  );
  const waiting = Boolean(agentId) && list.length > 0 && grants.isPending;
  const first = waiting ? undefined : options[0];
  useEffect(() => {
    if (!value.connectionId && first) onChange({ ...value, connectionId: first.id });
  }, [value, first, onChange]);
  const setFilter = (filter: RoutineConnectorTrigger["filter"]) => onChange({ ...value, filter });
  const picked = list.find((s) => s.id === value.connectionId) ?? list[0];
  const access = cantRead && agentId && (
    <AgentAccessNote
      agentId={agentId}
      words={options.length === 0 ? "mail.routine.connectorReadsNone" : "mail.routine.connectorCantRead"}
      values={{ connector: picked?.label ?? "" }}
    />
  );
  if (options.length === 0 && access) return access;
  return (
    <div className="routine-email">
      <div className="grid-fields">
        {options.length > 1 && (
          <Field label={t("routines.form.kind.connector")} id="nr-connection">
            <Select
              value={value.connectionId || first?.id}
              onValueChange={(connectionId) => onChange({ ...value, connectionId })}
              options={options.map((s) => ({ value: s.id, label: s.label }))}
              placeholder={waiting ? t("common.loading") : undefined}
              disabled={waiting}
            />
          </Field>
        )}
        <Field label={t("mail.routine.inboxAddress")} id="nr-inbox" example={t("mail.routine.inboxAddressHelp")}>
          <Input
            type="email"
            value={value.filter.to ?? ""}
            onChange={(e) => setFilter({ ...value.filter, to: e.target.value })}
          />
        </Field>
      </div>
      {access}
      <span className="ac-eyebrow">{t("mail.routine.filters")}</span>
      <AddressList
        id="nr-ms-from"
        label={t("mail.routine.from")}
        example={t("mail.routine.fromHelp")}
        values={value.filter.from ?? []}
        onChange={(from) => setFilter({ ...value.filter, from })}
      />
      <Field label={t("mail.routine.subject")} id="nr-ms-subject">
        <Input
          value={value.filter.subject ?? ""}
          onChange={(e) => setFilter({ ...value.filter, subject: e.target.value })}
        />
      </Field>
    </div>
  );
}

/** "Quando chegar um email em vendas@loja.com", or in any MillionSend inbox. */
export function connectorWhen(t: TFunction, routine: Routine) {
  if (routine.trigger.type !== "connector") return "";
  const to = routine.trigger.filter.to;
  return to ? t("mail.routine.when", { address: to }) : t("mail.routine.whenMillionSend");
}
