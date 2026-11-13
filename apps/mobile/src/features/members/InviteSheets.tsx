import {
  type InvitationWithStatus,
  type OrgRole,
  useAuthConfig,
  useResendInvitation,
  useRevokeInvitation,
  useRoles,
  useSetInvitationRoles,
} from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { personalHelperRole } from "@agenteschat/client/lib/personal-view";
import { everyoneOf, isEveryone, roleSummary, sortRoles } from "@agenteschat/client/lib/roles";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Share } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Locked, Text, useToast } from "@/ui";
import { useColors } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { type ActionItem, ActionList, copyText, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { invitationRoles, sentWords } from "./logic";

/** The roles a person may give (below their own), top first: `everyone` goes without saying ("Membro"). */
const givableOf = (roles: readonly OrgRole[]) => sortRoles(roles.filter((r) => !isEveryone(r) && r.givable));

/** Each givable role as a row of a sheet, with the sentence that sums it up. */
function useRoleRows(roles: readonly OrgRole[]) {
  const { t, i18n } = useTranslation();
  const everyone = everyoneOf(roles);
  return givableOf(roles).map((r) => ({
    key: r.id,
    label: r.name,
    hint: roleSummary(t, i18n.language, r, everyone),
  }));
}

/**
 * An address on Convidar pessoas: its role, one pick that closes the sheet (Membro plus what the person may give, as
 * the web's role menu), or, for one that won't be sent, why; either way it can leave the list. A personal workspace
 * asks it plainly (ADR 0159 §4): "Uses the agents" (no role) and "Helps you run it" (`personalHelperRole`) first, then
 * any other role this person may give by its own name; the roles given are the same.
 */
export function AddressSheet({
  email,
  sendable,
  note,
  roleId,
  roles,
  onPick,
  onRemove,
}: {
  email: string;
  /** False for someone in or invited already: no role to choose. */
  sendable: boolean;
  /** Why it won't be sent. */
  note?: string;
  roleId: string | null;
  roles: readonly OrgRole[];
  onPick: (roleId: string | null) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const c = useColors();
  const sheet = useSheet();
  const personal = isPersonal(org);
  const helper = personal ? personalHelperRole(roles) : null;
  const givable = useRoleRows(roles);
  const rows = helper
    ? [
        { key: helper.id, label: t("members.dialog.role.helps"), hint: t("members.dialog.role.helpsText") },
        ...givable.filter((r) => r.key !== helper.id),
      ]
    : givable;
  const title = personal
    ? t("members.dialog.role.titleOnePersonal", { name: email })
    : t("members.chips.roleOf", { email });
  const help = personal ? t("members.dialog.role.leadPersonal") : t("mobile.invitePeople.roleHelp");
  const check = <Icon name="check" size={18} color={c.ink} />;
  const pick = (id: string | null) => {
    onPick(id);
    sheet.close();
  };
  const options: ActionItem[] = [
    {
      key: "member",
      label: personal ? t("members.dialog.role.uses") : t("roles.member"),
      hint: personal ? t("members.dialog.role.usesText") : t("members.chips.memberHint"),
      ...(roleId === null ? { trailing: check } : {}),
      onPress: () => pick(null),
    },
    ...rows.map((r) => ({
      ...r,
      ...(roleId === r.key ? { trailing: check } : {}),
      onPress: () => pick(r.key),
    })),
  ];
  return (
    <>
      <SheetTitle title={sendable ? title : email} subtitle={sendable ? help : (note ?? "")} />
      {sendable ? <ActionList items={options} /> : null}
      <ActionList
        items={[
          {
            key: "remove",
            icon: "x",
            label: t("mobile.invitePeople.remove"),
            danger: true,
            onPress: () => {
              onRemove();
              sheet.close();
            },
          },
        ]}
      />
    </>
  );
}

/**
 * A sent invitation's actions (ADR 0090): its link at any time, the same as the email's, sent again with that link,
 * its roles, and Cancelar with the note on why: one that leaked stops only here. One sent before links lasted has no
 * link to copy; sending it again gives it one.
 */
export function InvitationSheet({
  invitation: inv,
  line,
  resent,
  onResent,
}: {
  invitation: InvitationWithStatus;
  /** Its roles, who sent it and when it stops working. */
  line: string;
  /** Sent again from here already. */
  resent: boolean;
  onResent: (id: string, until: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const resend = useResendInvitation(orgId);
  const revoke = useRevokeInvitation(orgId);
  const emails = sendsEmail(useAuthConfig().data);
  const words = sentWords(emails);
  const email = inv.email;
  const url = inv.url ?? null;
  const failed = (e: unknown) =>
    toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });

  // Toasts wait for the sheet to go: they'd sit under its modal. Awaited, not `mutate`'s callbacks, which an unmounted
  // sheet would never run.
  const copy = async () => {
    if (!url || !(await copyText(url))) return;
    sheet.close();
    successHaptic();
    toast({ title: t(`members.invitations.${words.copied}`, { email }) });
  };
  const sendAgain = async () => {
    sheet.close();
    try {
      const res = await resend.mutateAsync(inv.id);
      onResent(inv.id, res.expiresAt);
      successHaptic();
      const date = formatShortDate(i18n.language, res.expiresAt);
      toast({ title: t(`members.invitations.${url ? words.resent : words.newLink}`, { email, date }) });
    } catch (e) {
      failed(e);
    }
  };
  const cancelIt = async () => {
    sheet.close();
    try {
      await revoke.mutateAsync(inv.id);
      toast({ title: t("members.invitations.cancelled", { email }) });
    } catch (e) {
      failed(e);
    }
  };
  const confirmCancel = () =>
    Alert.alert(t("mobile.invitePeople.cancelTitle", { email }), t("mobile.invitePeople.cancelText"), [
      { text: t("mobile.common.back"), style: "cancel" },
      { text: t("members.invitations.cancel"), style: "destructive", onPress: () => void cancelIt() },
    ]);

  const actions: ActionItem[] = [
    ...(url
      ? [
          { key: "copy", icon: "copy" as const, label: t("members.copyLink"), onPress: () => void copy() },
          {
            key: "share",
            icon: "share" as const,
            label: t("mobile.joinRequests.share"),
            onPress: () =>
              void Share.share({ message: t("mobile.onb.shareMessage", { org: org?.name ?? "", url }) })
                .catch(() => undefined)
                .finally(sheet.close),
          },
        ]
      : []),
    {
      key: "again",
      icon: "send",
      label: emails ? t("mobile.invitePeople.sendAgain") : t("members.invitations.renew"),
      disabled: resent,
      onPress: () => void sendAgain(),
    },
    {
      key: "role",
      icon: "shield",
      label: t("members.invitations.changeRole"),
      onPress: () => sheet.open(<InvitationRolesSheet invitation={inv} />, { solid: true }),
    },
  ];
  return (
    <>
      <SheetTitle title={email} subtitle={line} />
      <ActionList items={actions} />
      <ActionList
        items={[
          {
            key: "cancel",
            icon: "x",
            label: t("members.invitations.cancel"),
            danger: true,
            onPress: confirmCancel,
          },
        ]}
      />
      {/* Sending again keeps a lasting link: one that reached the wrong person stops only here. */}
      {url ? (
        <Text variant="footnote" tone="faint">
          {t("members.invitations.linkStays")}
        </Text>
      ) : null}
    </>
  );
}

/**
 * "Mudar o papel": the roles a pending invitation gives, changed without sending it (the same link, ADR 0090). Several
 * can be on, as on the web and when approving a request: an invitation may hold more than one, and a single pick would
 * drop the others.
 */
function InvitationRolesSheet({ invitation: inv }: { invitation: InvitationWithStatus }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const roles = useRoles(orgId).data?.roles ?? [];
  const rows = useRoleRows(roles);
  // A personal workspace's note ties its roles to the invitation's plain words (ADR 0159 §4).
  const helper = isPersonal(org) ? personalHelperRole(roles) : null;
  const save = useSetInvitationRoles(orgId);
  const [value, setValue] = useState<string[]>(inv.roleIds ?? []);
  const flip = (id: string) => setValue((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const saveIt = async () => {
    try {
      await save.mutateAsync({ id: inv.id, roleIds: value });
      sheet.close();
      toast({
        title: t("members.invitations.roleSaved", {
          email: inv.email,
          roles: invitationRoles(t, { role: inv.role, roleIds: value }, roles),
        }),
      });
    } catch (e) {
      sheet.close();
      toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });
    }
  };
  return (
    <>
      <SheetTitle
        title={t("members.invitations.roleTitle", { email: inv.email })}
        subtitle={t("members.invitations.roleText")}
      />
      <Locked when={save.isPending}>
        <ActionList items={rows.map((r) => ({ ...r, checked: value.includes(r.key), onPress: () => flip(r.key) }))} />
      </Locked>
      <Text variant="footnote" tone="faint">
        {rows.length === 0
          ? t("members.noRolesToGive")
          : helper
            ? t("members.everyoneNotePersonal", { role: helper.name })
            : t("members.everyoneNote")}
      </Text>
      {rows.length > 0 ? (
        <Button
          variant="primary"
          wide
          label={t("common.save")}
          loading={save.isPending}
          onPress={() => void saveIt()}
        />
      ) : null}
    </>
  );
}
