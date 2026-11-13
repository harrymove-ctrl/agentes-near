import type { MailAccount, MailPolicy } from "@agenteschat/client";
import { useMailFolders } from "@agenteschat/client";
import { AUTO_FROM, canSendWithoutAsking, mailboxAddresses, normalizePolicy } from "@agenteschat/client/lib/mail";
import { AffixInput, CheckboxPill, Field, Icon, Input, Select, Switch } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { useOrg } from "@/components/org-context";

/** How many rules narrow what the agent does (the "Regras" summary). */
export function rulesCount(p: MailPolicy) {
  return [
    p.folders.length > 0,
    p.senders.length > 0,
    p.windowDays !== null,
    p.allowedRecipients.length > 0,
    p.sendWithoutAsking,
    p.fromAddress !== null,
  ].filter(Boolean).length;
}

/**
 * The rules for one mailbox: folders (none = all), senders, a time window,
 * recipients, the daily send cap, "Enviar sem pedir aprovação" (only with
 * recipients) and "Enviar como" (automatic, or one of the mailbox's addresses).
 */
export function MailRulesPanel({
  account,
  policy,
  onChange,
  disabled,
}: {
  account: Pick<MailAccount, "id" | "address" | "aliases" | "defaultFrom">;
  policy: MailPolicy;
  onChange: (policy: MailPolicy) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const accountId = account.id;
  const folders = useMailFolders(org.id, accountId);
  const set = (next: Partial<MailPolicy>) => onChange(normalizePolicy({ ...policy, ...next }));
  const id = (name: string) => `mail-${name}-${accountId}`;
  const addresses = mailboxAddresses(account);
  const unlocked = canSendWithoutAsking(policy);
  const numberOrNull = (v: string) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (
    <div className="mail-rules__body">
      <section className="mail-rules__part" aria-labelledby={id("read-h")}>
        <h4 id={id("read-h")} className="mail-rules__h">
          {t("mail.rulesRead")}
        </h4>
        <fieldset className="mail-rules__group">
          <legend className="ac-field__label">{t("mail.rule.folders")}</legend>
          {folders.isLoading ? (
            <span className="small muted">{t("mail.rule.foldersLoading")}</span>
          ) : folders.isError ? (
            <span className="small muted">{t("mail.rule.foldersError")}</span>
          ) : (
            <div className="newag__pills">
              {(folders.data ?? []).map((f) => (
                <CheckboxPill
                  key={f.id}
                  id={id(`folder-${f.id}`)}
                  disabled={disabled}
                  checked={policy.folders.includes(f.id)}
                  onCheckedChange={(on) =>
                    set({ folders: on ? [...policy.folders, f.id] : policy.folders.filter((x) => x !== f.id) })
                  }
                >
                  {f.role === "inbox" ? t("mail.routine.inbox") : f.name}
                </CheckboxPill>
              ))}
            </div>
          )}
          <span className="small muted">{t("mail.rule.foldersHelp")}</span>
        </fieldset>
        <AddressList
          id={id("senders")}
          label={t("mail.rule.senders")}
          example={t("mail.rule.sendersHelp")}
          values={policy.senders}
          onChange={(senders) => set({ senders })}
          disabled={disabled}
        />
        <Field label={t("mail.rule.window")} id={id("window")} example={t("mail.rule.windowHelp")}>
          <AffixInput
            className="ac-num"
            type="number"
            min={1}
            inputMode="numeric"
            disabled={disabled}
            value={policy.windowDays ?? ""}
            onChange={(e) => set({ windowDays: numberOrNull(e.target.value) })}
            action={<span className="mail-rules__unit">{t("mail.rule.windowUnit")}</span>}
          />
        </Field>
      </section>
      <section className="mail-rules__part" aria-labelledby={id("send-h")}>
        <h4 id={id("send-h")} className="mail-rules__h">
          {t("mail.rulesSend")}
        </h4>
        <AddressList
          id={id("recipients")}
          label={t("mail.rule.recipients")}
          example={t("mail.rule.recipientsHelp")}
          values={policy.allowedRecipients}
          onChange={(allowedRecipients) => set({ allowedRecipients })}
          disabled={disabled}
        />
        <Field label={t("mail.rule.cap")} id={id("cap")}>
          <Input
            className="ac-num mail-rules__cap"
            type="number"
            min={0}
            inputMode="numeric"
            disabled={disabled}
            value={policy.dailySendCap}
            onChange={(e) => set({ dailySendCap: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
          />
        </Field>
        <label className="routine-active" htmlFor={id("auto")}>
          <Switch
            id={id("auto")}
            checked={policy.sendWithoutAsking}
            disabled={disabled || !unlocked}
            onCheckedChange={(sendWithoutAsking) => set({ sendWithoutAsking })}
            aria-describedby={id("auto-help")}
          />
          <span>
            {t("mail.rule.sendWithoutAsking")}
            <span id={id("auto-help")} className="small muted mail-agent__help">
              {unlocked ? t("mail.rule.sendWithoutAskingHelp") : t("mail.rule.sendWithoutAskingLocked")}
            </span>
          </span>
        </label>
        {policy.sendWithoutAsking && policy.senders.length === 0 && (
          <p className="sandbox-warning small ac-iconline" role="note">
            <Icon name="alert" size={16} />
            {t("mail.agent.warning")}
          </p>
        )}
        <Field
          label={t("mail.rule.from")}
          id={id("from")}
          hint={{
            name: t("common.about", { label: t("mail.rule.from") }),
            text: t("mail.rule.fromHelp", { address: account.defaultFrom ?? account.address }),
          }}
        >
          <Select
            disabled={disabled}
            value={policy.fromAddress ?? AUTO_FROM}
            onValueChange={(v) => set({ fromAddress: v === AUTO_FROM ? null : v })}
            options={[
              { value: AUTO_FROM, label: t("mail.rule.fromAuto") },
              ...addresses.map((a) => ({ value: a, label: a })),
            ]}
          />
        </Field>
      </section>
    </div>
  );
}
