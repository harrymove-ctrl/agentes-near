import { keys, useAuthConfig, useWorkspaceLimits } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { formatBytes } from "@agenteschat/client/lib/files";
import {
  membersFull,
  membersFullText,
  membersFullWho,
  STORAGE_NEAR,
  storageLevel,
} from "@agenteschat/client/lib/limits";
import { can } from "@agenteschat/client/lib/permissions";
import { Meter, SettingNote, SettingRow } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BillingLinkButton, useOpenBilling } from "@/components/BillingLinkButton";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * A workspace's limits in the web app (ADR 0079): numbers its billing service set, said without a plan, price or
 * currency, with the way to more room for whoever manages the plan.
 */

/** Owners and admins, on a server with a billing service: they get the way to the plan's options. */
function useBillingAccess() {
  const { org } = useOrg();
  const billingUrl = useAuthConfig().data?.billingUrl;
  return can(org, "manage_billing") && Boolean(billingUrl);
}

/** No one more fits: who can make room, and how. Nothing while there is room or no limit. */
export function MembersFull() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const limits = useWorkspaceLimits(org.id).data;
  const full = membersFull(limits);
  const billing = useBillingAccess();
  if (!full) return null;
  return (
    <SettingRow title={membersFullText(t, full.members, full.limit)} status={membersFullWho(t, limits, billing)}>
      {billing && (
        <BillingLinkButton orgId={org.id} from="invite_full" size="sm">
          {t("billing.open")}
        </BillingLinkButton>
      )}
    </SettingRow>
  );
}

/**
 * A failed upload, said in a toast: a storage limit in the person's words, and on a full storage the way to more
 * room for whoever manages the plan.
 */
export function useUploadFailed() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const billing = useBillingAccess();
  const open = useOpenBilling(org.id, "upload_full");
  return (error: unknown) => {
    const text = errorText(t, error, i18n.language);
    if (errorCode(error) !== "storage.full") return toast.show(text, "error");
    void qc.invalidateQueries({ queryKey: keys.limits(org.id) });
    if (!billing) return toast.show(text, "error");
    toast.show(
      text,
      "error",
      { label: t("billing.seeOptions"), run: () => open.mutate() },
      t("limits.storage.fullAdmin"),
    );
  };
}

/**
 * Settings › Storage: the files against the storage limit, near it from 80% and full at it, or that the
 * workspace's own bucket counts against no limit. Nothing without a limit.
 */
export function StorageMeter() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const limits = useWorkspaceLimits(org.id).data;
  const billing = useBillingAccess();
  if (!limits || limits.storage.limitBytes === null) return null;
  if (limits.storage.ownStorage) return <SettingNote icon="check">{t("billing.ownBucket")}</SettingNote>;
  const storage = storageLevel(limits);
  if (!storage) return null;
  const used = formatBytes(i18n.language, storage.usedBytes);
  const limit = formatBytes(i18n.language, storage.limitBytes);
  const tight = storage.level !== "ok";
  return (
    <div className="stack-4" style={{ gap: 8 }}>
      <Meter
        value={storage.usedBytes}
        max={storage.limitBytes}
        label={t("billing.files")}
        marks={[STORAGE_NEAR * 100]}
      />
      <SettingRow
        title={
          storage.level === "full"
            ? t("limits.storage.full", { limit })
            : t(tight ? "limits.storage.near" : "limits.storage.meter", { used, limit })
        }
        status={tight && billing ? t("limits.storage.fullAdmin") : undefined}
      >
        {tight && billing && (
          <BillingLinkButton orgId={org.id} from="storage" size="sm">
            {t("billing.seeOptions")}
          </BillingLinkButton>
        )}
      </SettingRow>
    </div>
  );
}

/**
 * Plano e cobrança: people and files against the plan's limits, in plain numbers. People count against the plan's
 * top when the billing service says one, with the seats paid for under it.
 */
export function BillingMeters() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const limits = useWorkspaceLimits(org.id).data;
  if (!limits) return null;
  const { members, storage } = limits;
  const bytes = (n: number) => formatBytes(i18n.language, n);
  const people = members.max ?? members.limit;
  const rows = [
    {
      key: "people",
      used: members.used,
      limit: people,
      value: people === null ? t("billing.noLimit") : t("billing.usedOf", { used: members.used, limit: people }),
      note:
        members.limit !== null && people !== members.limit ? t("billing.seatsPaid", { count: members.limit }) : null,
    },
    {
      key: "files",
      used: storage.usedBytes,
      limit: storage.ownStorage ? null : storage.limitBytes,
      value: storage.ownStorage
        ? t("billing.ownBucket")
        : storage.limitBytes === null
          ? t("billing.noLimit")
          : t("billing.usedOf", { used: bytes(storage.usedBytes), limit: bytes(storage.limitBytes) }),
      note: null,
    },
  ] as const;
  return (
    <div className="stack-4" style={{ gap: 12 }}>
      {rows.map((row) => (
        <div key={row.key} className="stack-4">
          <div className="row">
            <b>{t(`billing.${row.key}`)}</b>
            <span className="spacer" />
            <span className="small muted tabular">{row.value}</span>
          </div>
          {row.limit !== null && <Meter value={row.used} max={row.limit} label={t(`billing.${row.key}`)} />}
          {row.note && <span className="small muted tabular">{row.note}</span>}
        </div>
      ))}
    </div>
  );
}
