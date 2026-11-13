import {
  useAgents,
  useAiStatus,
  useAllInvitations,
  useAuthConfig,
  useChannels,
  useInviteMany,
  usePeople,
  useRoles,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { INVITE_NOTE_MAX, sendsEmail } from "@agenteschat/client/lib/join-requests";
import { membersFull } from "@agenteschat/client/lib/limits";
import { aiStateOf, onlyOwnerReplies } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { usePlanHold } from "../ai/parts";
import { Page } from "../me/parts";
import { useColors, useMeId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { EMPTY_INVITE, setInviteDraft, updateInviteDraft, useInviteDraft } from "./draft";
import { InviteLinkRows } from "./InviteLinkRows";
import { AddressSheet } from "./InviteSheets";
import {
  addressesLeft,
  addressState,
  batchNews,
  type InviteAddress,
  joinRoleWord,
  offeredChannels,
  pendingInvitations,
  readTyped,
  withAddresses,
} from "./logic";
import { MembersFullNote } from "./MembersFullNote";

/**
 * Convidar pessoas (ADR 0090 §5), the web's invite dialog as a pushed screen: an address a row with its role, the
 * channels they also join and a note in the email on screens of their own, then the workspace's link. A server that
 * sends no email invites through the link only. A personal workspace first asks who they are (ADR 0159 §4,
 * `WhoQuestion`) and says each role in its plain words.
 */
export function InvitePeopleScreen() {
  return (
    <SheetHostProvider>
      <InvitePeople />
    </SheetHostProvider>
  );
}

function InvitePeople() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const held = usePlanHold(orgId, org) !== null;
  const allowed = can(org, "invite_people");
  const byLink = !sendsEmail(useAuthConfig().data);
  const people = usePeople(orgId).data ?? [];
  const invitations = useAllInvitations(orgId, allowed).data ?? [];
  const roles = useRoles(orgId).data?.roles ?? [];
  const channels = useChannels(orgId).data ?? [];
  const full = membersFull(useWorkspaceLimits(orgId).data) !== null;
  const inviteMany = useInviteMany(orgId);
  const input = useRef<TextInputInstance | null>(null);
  const [typed, setTyped] = useState("");
  const personal = isPersonal(org);
  // Family or friends, in a personal workspace: asked once each time this screen opens (ADR 0159 §4).
  const [family, setFamily] = useState(false);
  // An agent's invite card opens it with its addresses (`?emails=a@x,b@y`), a channel's add sheet with that channel.
  const { emails, channel } = useLocalSearchParams<{ emails?: string; channel?: string }>();
  useEffect(() => {
    setInviteDraft({
      ...EMPTY_INVITE,
      addresses: emails ? withAddresses(EMPTY_INVITE.addresses, emails) : EMPTY_INVITE.addresses,
      channelIds: channel ? [channel] : EMPTY_INVITE.channelIds,
    });
    return () => setInviteDraft(null);
  }, [emails, channel]);
  const draft = useInviteDraft() ?? EMPTY_INVITE;

  // Who is in already, and who has an invitation waiting: said on their row and left out of the send.
  const members = useHeldWhile(new Set(people.map((m) => m.email.toLowerCase())), inviteMany.isPending);
  const invited = useHeldWhile(
    new Set(pendingInvitations(invitations).map((i) => i.email.toLowerCase())),
    inviteMany.isPending,
  );
  const stateOf = (a: InviteAddress) => addressState(a, members, invited);
  // What's still in the field counts: the button is pressed with the keyboard up, so the field never lost focus.
  const all = withAddresses(draft.addresses, typed);
  const ready = all.filter((a) => stateOf(a) === "ok");
  const bad = draft.addresses.some((a) => !a.valid);

  const { others } = offeredChannels(channels);
  const extra = others.filter((ch) => draft.channelIds.includes(ch.id));
  const extraNames = extra.map((ch) => `#${ch.name}`);
  const note = draft.note.trim();

  const add = (text: string) => updateInviteDraft((d) => ({ ...d, addresses: withAddresses(d.addresses, text) }));
  const onType = (next: string) => {
    const read = readTyped(typed, next);
    if (read.add) add(read.add);
    setTyped(read.keep);
  };
  const commit = () => {
    if (typed.trim()) add(typed);
    setTyped("");
  };
  const remove = (email: string) =>
    updateInviteDraft((d) => ({ ...d, addresses: d.addresses.filter((a) => a.email !== email) }));
  const setRole = (email: string, roleId: string | null) =>
    updateInviteDraft((d) => ({
      ...d,
      addresses: d.addresses.map((a) => (a.email === email ? { ...a, roleId } : a)),
    }));

  /** An address to fix goes back to the field; any other opens its sheet. */
  const openAddress = (a: InviteAddress) => {
    if (!a.valid) {
      commit();
      remove(a.email);
      setTyped(a.email);
      input.current?.focus();
      return;
    }
    const state = stateOf(a);
    sheet.open(
      <AddressSheet
        email={a.email}
        sendable={state === "ok"}
        note={state === "member" ? t("mobile.invitePeople.here") : t("mobile.invitePeople.invited")}
        roleId={a.roleId}
        roles={roles}
        onPick={(roleId) => setRole(a.email, roleId)}
        onRemove={() => remove(a.email)}
      />,
      { solid: true },
    );
  };

  const send = async () => {
    if (ready.length === 0 || full || inviteMany.isPending) return;
    try {
      const results = await inviteMany.mutateAsync({
        invites: ready.map((a) => ({ email: a.email, roleIds: a.roleId ? [a.roleId] : [] })),
        channelIds: extra.map((ch) => ch.id),
        ...(note ? { note } : {}),
      });
      const news = batchNews(t, results, extraNames);
      if (news)
        toast({
          title: news.title,
          ...(news.subtitle ? { subtitle: news.subtitle } : {}),
          ...(news.failed ? { icon: "x" as const } : {}),
        });
      if (news && !news.failed) successHaptic();
      // Only addresses to fix stay.
      const left = addressesLeft(all, results);
      updateInviteDraft((d) => ({ ...d, addresses: left }));
      setTyped("");
      if (left.length === 0) goBack();
    } catch (e) {
      // The addresses stay, to send again.
      toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });
    }
  };

  if (!allowed)
    return (
      <Page title={t("members.inviteTitle")}>
        <GroupedFooter>{t("common.notAllowed")}</GroupedFooter>
      </Page>
    );
  if (held)
    return (
      <Page title={t("members.inviteTitle")}>
        <GroupedFooter>
          {t("common.joinSentences", {
            a: t("standing.billing.invites"),
            b: t(can(org, "manage_billing") ? "connectAi.billingWeb" : "standing.billing.askAdmin"),
          })}
        </GroupedFooter>
      </Page>
    );
  if (personal && !family) return <WhoQuestion onFamily={() => setFamily(true)} />;
  return (
    <Page
      title={t("members.inviteTitle")}
      {...(byLink
        ? {}
        : {
            footer: (
              <Button
                variant="primary"
                wide
                label={ready.length > 0 ? t("members.dialog.send", { count: ready.length }) : t("members.invite")}
                disabled={ready.length === 0 || full}
                loading={inviteMany.isPending}
                onPress={() => void send()}
              />
            ),
          })}
      locked={inviteMany.isPending}
    >
      <MembersFullNote />
      <OnlyYouNote />
      {byLink ? null : (
        <>
          <GroupedHeader>{t("members.dialog.emails")}</GroupedHeader>
          <GroupedList>
            {draft.addresses.map((a) => {
              const state = stateOf(a);
              return (
                <GroupedRow
                  key={a.email}
                  label={a.email}
                  value={
                    state === "bad"
                      ? t("mobile.invitePeople.fix")
                      : state === "member"
                        ? t("mobile.invitePeople.here")
                        : state === "invited"
                          ? t("mobile.invitePeople.invited")
                          : joinRoleWord(t, roles, a.roleId, personal)
                  }
                  danger={state === "bad"}
                  faint={state === "member" || state === "invited"}
                  chevron={state === "ok"}
                  onPress={() => openAddress(a)}
                />
              );
            })}
            <View key="more" style={styles.field}>
              <TextInput
                ref={input}
                value={typed}
                onChangeText={onType}
                onSubmitEditing={commit}
                onBlur={commit}
                submitBehavior="submit"
                placeholder={t(draft.addresses.length > 0 ? "members.dialog.moreEmails" : "members.emailsPlaceholder")}
                placeholderTextColor={c.faint}
                keyboardType="email-address"
                textContentType="emailAddress"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                spellCheck={false}
                returnKeyType="done"
                accessibilityLabel={t("members.dialog.emails")}
                style={[fieldText("callout"), styles.input, { color: c.ink }]}
              />
            </View>
          </GroupedList>
          <GroupedFooter>
            {bad ? (
              <Text variant="footnote" tone="danger">
                {t("members.dialog.checkMarked")}
              </Text>
            ) : (
              t("mobile.invitePeople.emailsHelp")
            )}
          </GroupedFooter>
          <View style={styles.gap} />
          <GroupedList>
            {/* A personal workspace with no group conversation besides #general has nothing to pick (ADR 0159). */}
            {personal && others.length === 0 ? null : (
              <GroupedRow
                label={personal ? t("shell.channelsPersonal") : t("mobile.invitePeople.channels")}
                {...(extraNames.length > 0 ? { value: extraNames.join(", ") } : {})}
                chevron
                onPress={() => router.push("/invite-channels")}
              />
            )}
            <GroupedRow
              label={t("members.dialog.note")}
              value={note ? t("members.dialog.withNote") : t("mobile.invitePeople.optional")}
              chevron
              onPress={() => router.push("/invite-note")}
            />
          </GroupedList>
        </>
      )}
      <GroupedHeader>{byLink ? t("members.link.title") : t("members.dialog.or")}</GroupedHeader>
      <InviteLinkRows />
    </Page>
  );
}

/**
 * Before inviting to a personal workspace (ADR 0159 §4), the web's question: family or friends join and it stays
 * personal; people from work switch it to a team's first, on the mode screen (only who configures it can; for anyone
 * else that choice is off and says why), which comes back here in a team's words. Who may invite, and the roles,
 * stay as they are.
 */
function WhoQuestion({ onFamily }: { onFamily: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const switches = can(org, "configure");
  return (
    <Page title={t("members.inviteTitle")}>
      <GroupedHeader>{t("personalMode.invite.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="members"
          label={t("personalMode.invite.family")}
          sub={t("personalMode.invite.familyText")}
          subLines={3}
          chevron
          onPress={onFamily}
        />
        <GroupedRow
          icon="laptop"
          label={t("personalMode.invite.work")}
          sub={t(switches ? "personalMode.invite.workText" : "personalMode.invite.workLocked")}
          subLines={3}
          {...(switches ? { chevron: true, onPress: () => router.push("/settings/mode") } : { disabled: true })}
        />
      </GroupedList>
      <GroupedFooter>{t("personalMode.invite.lead")}</GroupedFooter>
    </Page>
  );
}

/** Before inviting, while every agent with an AI answers only the person: they'd invite people to a silent team. */
function OnlyYouNote() {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const meId = useMeId();
  const agents = useAgents(orgId).data ?? [];
  const status = useAiStatus(orgId).data;
  const thinks = (id: string) => (aiStateOf(status, id) ?? "no_ai") !== "no_ai";
  if (!meId || !onlyOwnerReplies(agents, thinks, meId)) return null;
  return (
    <GroupedFooter>
      {t("common.joinSentences", { a: t("members.agentsOnlyYou"), b: t("members.agentsOnlyYouHint") })}
    </GroupedFooter>
  );
}

/** Canais, pushed over Convidar pessoas: what they also join, #general always (ADR 0090 §5). */
export function InviteChannelsScreen() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const channels = useChannels(orgId).data ?? [];
  const draft = useInviteDraft();
  const chosen = draft?.channelIds ?? [];
  const { general, others } = offeredChannels(channels);
  const flip = (id: string) =>
    updateInviteDraft((d) => ({
      ...d,
      channelIds: d.channelIds.includes(id) ? d.channelIds.filter((x) => x !== id) : [...d.channelIds, id],
    }));
  return (
    <Page
      title={isPersonal(org) ? t("shell.channelsPersonal") : t("mobile.invitePeople.channels")}
      action={{ label: t("mobile.invitePeople.ok"), onPress: goBack }}
    >
      <GroupedHeader>{t("members.dialog.alsoJoin")}</GroupedHeader>
      <GroupedList>
        {others.map((ch) => (
          <GroupedRow
            key={ch.id}
            icon={ch.visibility === "private" ? "lock" : "hash"}
            label={ch.name}
            {...(ch.visibility === "private" ? { sub: t("channel.visibilityPrivate") } : {})}
            checked={chosen.includes(ch.id)}
            onPress={() => flip(ch.id)}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("members.dialog.generalAlways", { channel: general?.name ?? "general" })}</GroupedFooter>
    </Page>
  );
}

/** Recado no e-mail, pushed over Convidar pessoas. */
export function InviteNoteScreen() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const draft = useInviteDraft();
  return (
    <Page title={t("members.dialog.note")} action={{ label: t("mobile.invitePeople.ok"), onPress: goBack }}>
      <View style={styles.gap} />
      <TextArea
        value={draft?.note ?? ""}
        onChangeText={(note) => updateInviteDraft((d) => ({ ...d, note }))}
        placeholder={t(modeKey(org, "members.dialog.notePlaceholder"), { org: org?.name ?? "" })}
        accessibilityLabel={t("members.dialog.note")}
        maxLength={INVITE_NOTE_MAX}
        autoFocus
      />
      <GroupedFooter>{t("mobile.invitePeople.noteHelp", { max: INVITE_NOTE_MAX })}</GroupedFooter>
    </Page>
  );
}

const styles = StyleSheet.create({
  field: { minHeight: GROUPED_ROW.minHeight, paddingHorizontal: GROUPED_ROW.padX, justifyContent: "center" },
  input: { paddingVertical: GROUPED_ROW.tallPadY, paddingHorizontal: 0 },
  gap: { height: 14 },
});
