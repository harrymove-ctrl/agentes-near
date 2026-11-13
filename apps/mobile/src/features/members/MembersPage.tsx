import {
  type InvitationWithStatus,
  type Person,
  useAllInvitations,
  useApi,
  useCancelSuggestion,
  useJoinRequests,
  useMe,
  useMySuggestions,
  usePeople,
  useRemoveMember,
  useRoles,
} from "@agenteschat/client";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { namesText } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { removalLines } from "@agenteschat/client/lib/removal";
import { leaves, removes } from "@agenteschat/client/lib/roles";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked, PersonAvatar, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Page } from "../me/parts";
import { Face } from "../shared/Face";
import { useColors, useMeId } from "../shared/hooks";
import { errorHaptic, Loaded, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { InvitationSheet } from "./InviteSheets";
import {
  invitationLine,
  invitationSender,
  invitersOf,
  memberLine,
  membersByName,
  pendingInvitations,
  waitingLine,
  whenWords,
} from "./logic";
import { MembersFullNote } from "./MembersFullNote";

/**
 * Membros e convites (ADR 0090), one page: whoever may invite gets "Convidar pessoas" on top (the workspace's link
 * lives on that screen), then what waits on them and the invitations sent; a member who may not invite suggests
 * someone. Then the people, each with their roles (ADR 0085).
 */
export function MembersPage() {
  return (
    <SheetHostProvider>
      <Members />
    </SheetHostProvider>
  );
}

function Members() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const meId = useMeId();
  const people = usePeople(orgId);
  const roles = useRoles(orgId).data?.roles ?? [];
  const invites = can(org, "invite_people");
  const list = people.data;
  const remove = useRemoveFlow();
  const viewer = { role: org?.role ?? "member", rank: org?.rank, userId: meId ?? "", permissions: org?.permissions };
  // Being deleted, inviting and removing are greyed out, as on the web; leaving stays (the server takes it then too).
  const frozen = settingsFrozen(org, "members");
  // Remover do workspace for whoever may, Sair on one's own row (not the last owner); the server checks it again.
  const removable = (m: Person) =>
    m.userId === meId ? leaves(viewer, list ?? []) : !frozen && removes(viewer, m, roles);

  return (
    <Page
      title={
        isPersonal(org)
          ? t("settings.section.membersPersonal")
          : invites
            ? t("settings.section.members")
            : t("members.title")
      }
    >
      <View style={styles.gap} />
      <Locked when={frozen} readable>
        {invites ? (
          <>
            <GroupedList>
              <GroupedRow icon="plus" label={t("members.inviteTitle")} onPress={() => router.push("/invite-people")} />
            </GroupedList>
            <WaitingYou />
            <SentInvitations />
          </>
        ) : (
          <Suggestions />
        )}
      </Locked>

      <GroupedHeader>{list ? `${t("members.people")} · ${list.length}` : t("members.people")}</GroupedHeader>
      {list ? (
        <Loaded>
          <GroupedList>
            {membersByName(list, i18n.language).map((m) => (
              <GroupedRow
                key={m.userId}
                leading={
                  <Face who={{ type: "person", id: m.userId }} size={30} live={false} presence ring={c.raised} />
                }
                label={m.userId === meId ? `${m.name}${t("common.youSuffix")}` : m.name}
                sub={memberLine(t, i18n.language, m, roles)}
                {...(removable(m) ? { more: true, onPress: () => void remove(m) } : {})}
              />
            ))}
          </GroupedList>
        </Loaded>
      ) : (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      )}
    </Page>
  );
}

/**
 * "Remover do workspace" (or "Sair do workspace"): what goes with the person, as the server reads it, in the system's
 * confirmation; then the removal, and the person's own leaving goes back to the start.
 */
function useRemoveFlow() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const meId = useMeId();
  const toast = useToast();
  const remove = useRemoveMember(orgId);
  const orgName = org?.name ?? "";
  const failed = (e: unknown) => {
    errorHaptic();
    toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });
  };
  return async (m: Person) => {
    const mine = m.userId === meId;
    let lines: string[];
    try {
      const preview = await qc.fetchQuery({
        queryKey: ["org", orgId, "removal", m.userId],
        queryFn: () => api.orgs.removal(orgId, m.userId),
        staleTime: 0,
      });
      lines = removalLines(t, preview, { name: m.name, org: orgName, mine, meId: meId ?? "" });
    } catch (e) {
      return failed(e);
    }
    const go = async () => {
      try {
        await remove.mutateAsync(m.userId);
        successHaptic();
        toast({
          title: mine
            ? t("members.remove.left", { org: orgName })
            : t("members.remove.done", { name: m.name, org: orgName }),
        });
        if (mine) router.replace("/");
      } catch (e) {
        failed(e);
      }
    };
    Alert.alert(
      mine
        ? t("members.remove.leaveTitle", { org: orgName })
        : t("members.remove.title", { name: m.name, org: orgName }),
      lines.join("\n\n"),
      [
        { text: t("mobile.common.back"), style: "cancel" },
        {
          text: mine
            ? t("members.remove.confirmLeave", { org: orgName })
            : t("members.remove.confirm", { name: m.name }),
          style: "destructive",
          onPress: () => void go(),
        },
      ],
    );
  };
}

/** Esperando você: who asked through the link and whom members suggested, each opening the review (ADR 0068, 0090). */
function WaitingYou() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const requests = useJoinRequests(orgId).data ?? [];
  if (requests.length === 0) return null;
  return (
    <>
      <GroupedHeader>{`${t("members.waitingTitle")} · ${requests.length}`}</GroupedHeader>
      <GroupedList>
        {requests.map((r) => (
          <GroupedRow
            key={r.id}
            leading={<PersonAvatar name={r.name} size={30} />}
            label={r.name}
            sub={waitingLine(t, i18n.language, r)}
            subLines={2}
            media
            chevron
            onPress={() => router.push({ pathname: "/join-requests", params: { request: r.id } })}
          />
        ))}
      </GroupedList>
      <MembersFullNote />
    </>
  );
}

/** Convites enviados: those still waiting, each opening its actions (ADR 0090). */
function SentInvitations() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const sheet = useSheet();
  const me = useMe().data?.user.name;
  const list = pendingInvitations(useAllInvitations(orgId).data ?? []);
  const roles = useRoles(orgId).data?.roles ?? [];
  // Sent again from here: until when it works now.
  const [resent, setResent] = useState<Record<string, string>>({});
  if (list.length === 0) return null;
  const open = (inv: InvitationWithStatus) =>
    sheet.open(
      <InvitationSheet
        invitation={inv}
        line={invitationLine(t, i18n.language, inv, roles, {
          resentUntil: resent[inv.id],
          sender: invitationSender(t, inv, me),
        })}
        resent={Boolean(resent[inv.id])}
        onResent={(id, until) => setResent((all) => ({ ...all, [id]: until }))}
      />,
      { solid: true },
    );
  return (
    <>
      <GroupedHeader>{`${t("members.invitations.title")} · ${list.length}`}</GroupedHeader>
      <GroupedList>
        {list.map((inv) => (
          <GroupedRow
            key={inv.id}
            leading={<PersonAvatar name={inv.email} size={30} />}
            label={inv.email}
            labelLines={2}
            sub={invitationLine(t, i18n.language, inv, roles, { resentUntil: resent[inv.id] })}
            subLines={2}
            media
            more
            onPress={() => open(inv)}
          />
        ))}
      </GroupedList>
    </>
  );
}

/**
 * A member who may not invite (ADR 0090 §7): "Sugerir pessoa", which reaches the people who invite as a request, who
 * they are, and the suggestions still waiting, each to take back.
 */
function Suggestions() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const people = usePeople(orgId).data ?? [];
  const roles = useRoles(orgId).data?.roles ?? [];
  const waiting = useMySuggestions(orgId).data ?? [];
  const cancel = useCancelSuggestion(orgId);
  const inviters = invitersOf(people, roles);

  const cancelIt = async (id: string) => {
    try {
      await cancel.mutateAsync(id);
      successHaptic();
      toast({ title: t("members.suggest.cancelled") });
    } catch (e) {
      errorHaptic();
      toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });
    }
  };
  const confirmCancel = (id: string, email: string) =>
    Alert.alert(t("members.suggest.cancelOf", { email }), undefined, [
      { text: t("mobile.common.back"), style: "cancel" },
      { text: t("common.cancel"), style: "destructive", onPress: () => void cancelIt(id) },
    ]);

  return (
    <>
      <GroupedList>
        <GroupedRow icon="plus" label={t("members.suggest.button")} onPress={() => router.push("/suggest-person")} />
      </GroupedList>
      <GroupedFooter>
        {inviters.length > 0
          ? t("members.suggest.lead", { count: inviters.length, names: namesText(t, inviters, 2) })
          : t("members.suggest.leadNoNames")}
      </GroupedFooter>
      {waiting.length > 0 ? (
        <>
          <GroupedHeader>{t("members.suggest.mine")}</GroupedHeader>
          <GroupedList>
            {waiting.map((s) => (
              <GroupedRow
                key={s.id}
                leading={<PersonAvatar name={s.email} size={30} />}
                label={s.email}
                labelLines={2}
                sub={t("members.suggest.waiting", { when: whenWords(t, i18n.language, s.createdAt) })}
                media
                {...(s.note ? { belowText: s.note } : {})}
                more
                disabled={cancel.isPending}
                onPress={() => confirmCancel(s.id, s.email)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  gap: { height: 14 },
  loading: { marginVertical: 16 },
});
