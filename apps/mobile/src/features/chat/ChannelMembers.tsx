import {
  type AiRouting,
  type Channel,
  keys,
  type RosterMember,
  useAiStatus,
  useApi,
  useChannels,
  useLeaveChannel,
  useMuteChannel,
  useRoster,
} from "@agenteschat/client";
import { listsAgent, opensDetails } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { can, leavesChannel, makesAgents, managesChannel, setsAutoReply } from "@agenteschat/client/lib/permissions";
import { joinsChannels } from "@agenteschat/client/lib/right-hand";
import { picksForMe, replyAloneKey } from "@agenteschat/client/lib/routing";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Card, Count, Icon, Locked, Row, SearchField, Text, useToast, weights } from "@/ui";
import { router } from "@/ui/navigation";
import { Face, OpensAgent } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, successHaptic, Tile, tapHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";

/** Above this many members the list gets a search field (as the web's channel details). */
const SEARCH_FROM = 8;

type Kind = "person" | "agent";
interface Who {
  kind: Kind;
  id: string;
  name: string;
  handle: string;
  email: string;
  autoReply: boolean;
  setsReply: boolean;
}

/** Refreshes who is in the channel after a change (the header's faces, the "@" picker, this list). */
function useRefresh(channelId: string) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.roster(orgId, channelId) });
    void qc.invalidateQueries({ queryKey: keys.channelMembers(orgId, channelId) });
  };
}

/** An agent's line says how it answers my messages: on its own only while something reads the ones that mention nobody. */
const lineOf = (t: TFunction, w: Who, routing: AiRouting | undefined) =>
  w.kind === "agent"
    ? !w.autoReply
      ? t("channelMembers.mentionLine", { handle: w.handle })
      : !picksForMe(routing)
        ? t(replyAloneKey(routing), agentGrammar(w.name))
        : t("channelMembers.aloneLine", agentGrammar(w.name))
    : w.email;

/**
 * Who is in a channel, as the web's channel details: agents and people in groups, each agent with how it
 * replies here. Admins open a member for its options (how an agent replies, "Tirar do canal") and add
 * people or agents; an agent's owner opens it for how it replies; everyone else reads the list.
 */
export function ChannelMembersSheet({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const dir = useDirectory();
  const meId = useMeId();
  const c = useColors();
  const roster = useRoster(orgId, channelId);
  const routing = useAiStatus(orgId).data?.routing;
  const channel = useChannels(orgId).data?.find((x) => x.id === channelId);
  const editable = managesChannel(channel, meId, org);
  const [q, setQ] = useState("");
  const all: Who[] = (roster.data ?? []).map((m: RosterMember) => ({
    kind: m.type === "agent" ? "agent" : "person",
    id: m.id,
    name: m.name,
    handle: m.handle ?? "",
    email: m.type === "agent" ? "" : (dir.memberById.get(m.id)?.email ?? ""),
    autoReply: Boolean(m.autoReply),
    setsReply: m.type === "agent" && setsAutoReply(channel, dir.agentById.get(m.id), meId, org),
  }));
  // The right hand (ADR 0137) is in no channel and isn't listed as a member: an @mention reaches it anywhere.
  const needle = q.trim().toLowerCase();
  const shown = all.filter((w) => !needle || `${w.name} ${w.handle} ${w.email}`.toLowerCase().includes(needle));
  const agents = shown.filter((w) => w.kind === "agent");
  const people = shown.filter((w) => w.kind === "person");
  const agentCount = all.filter((w) => w.kind === "agent").length;

  const open = (w: Who) =>
    sheet.open(<MemberOptions channelId={channelId} channelName={channelName} who={w} removable={editable} />);
  // No options to give here: the row is the way to the agent, as its picture is in the options.
  const seeAgent = (id: string) => {
    sheet.close();
    router.push(`/agent/${id}`);
  };
  const group = (label: string, count: number, list: Who[]) =>
    list.length > 0 ? (
      <View>
        <View style={styles.group}>
          <Text variant="footnote" tone="faint" style={styles.bold}>
            {label}
          </Text>
          {/* Tabular figures, as every count in the app (`Count`). */}
          <Count value={count} size={13} weight={weights.medium} color={c.faint} />
        </View>
        <Card>
          {list.map((w) => {
            const mine = w.kind === "person" && w.id === meId;
            return (
              <Row
                key={`${w.kind}:${w.id}`}
                leading={<Face who={{ type: w.kind, id: w.id }} size={30} live={false} presence ring={c.raised} />}
                title={mine ? `${w.name}${t("common.youSuffix")}` : w.name}
                subtitle={lineOf(t, w, routing)}
                subtitleLines={w.kind === "agent" ? 2 : 1}
                // Not on my own row: taking myself out of my own list reads as a mistake (as on the web).
                {...((editable && !mine) || w.setsReply
                  ? {
                      onPress: () => open(w),
                      meta: <Icon name="more" size={18} color={c.faint} />,
                    }
                  : w.kind === "agent" && opensDetails(dir.anyAgent(w.id))
                    ? { onPress: () => seeAgent(w.id) }
                    : {})}
              />
            );
          })}
        </Card>
      </View>
    ) : null;

  return (
    <>
      <SheetTitle
        leading={<Tile icon="hash" />}
        title={t("shell.members")}
        subtitle={`#${channelName}${roster.data ? ` · ${t("mobile.chat.here", { count: all.length })}` : ""}`}
      />
      <Text variant="footnote" tone="muted">
        {t("channelMembers.caption")}
      </Text>
      {all.length > SEARCH_FROM ? (
        <SearchField value={q} onChangeText={setQ} placeholder={t("channel.detailsSearch")} autoCorrect={false} />
      ) : null}
      {roster.isLoading ? (
        <ActivityIndicator color={c.muted} />
      ) : roster.isError ? (
        <Text tone="muted">{t("mobile.app.failed")}</Text>
      ) : needle && shown.length === 0 ? (
        <Text variant="body" tone="muted">
          {t("channel.detailsEmpty", { q })}
        </Text>
      ) : (
        <>
          {group(t("channelMembers.agents"), agentCount, agents)}
          {group(t("channelMembers.people"), all.filter((w) => w.kind === "person").length, people)}
        </>
      )}
      {editable && !needle ? (
        <ActionList
          items={[
            {
              key: "add",
              icon: "plus",
              label: t("channelMembers.addRow"),
              onPress: () => sheet.open(<AddChannelMembers channelId={channelId} channelName={channelName} />),
            },
          ]}
        />
      ) : null}
      {channel?.isMember ? <ChannelOwnActions channel={channel} /> : null}
      {editable ? null : (
        <Text variant="caption" tone="faint" style={styles.note}>
          {t("channelMembers.readOnly")}
        </Text>
      )}
    </>
  );
}

/**
 * What I do about a channel for myself, as the web's channel menu: mute it, and leave it. A public one goes at once;
 * a private one asks first, since only someone in it can bring me back, and the last person out archives it.
 */
function ChannelOwnActions({ channel }: { channel: Channel }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const toast = useToast();
  const mute = useMuteChannel(orgId);
  const leave = useLeaveChannel(orgId);
  const roster = useRoster(orgId, channel.id);
  const failed = (e: unknown) => toast({ title: errorText(t, e, i18n.language), icon: "x" });
  const go = () =>
    leave.mutate(channel.id, {
      onSuccess: () => {
        successHaptic();
        sheet.close();
        toast({ title: t("channel.left", { channel: channel.name }), icon: "check" });
        router.back();
      },
      onError: failed,
    });
  const ask = () => {
    if (channel.visibility !== "private") return go();
    const alone = (roster.data ?? []).filter((m) => m.type !== "agent").length === 1;
    Alert.alert(
      t("channel.leaveTitle", { channel: channel.name }),
      t(alone ? "channel.leaveLast" : "channel.leavePrivate"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t(alone ? "channel.leaveLastConfirm" : "channel.leaveConfirm"),
          style: "destructive",
          onPress: go,
        },
      ],
    );
  };
  return (
    <ActionList
      items={[
        {
          key: "mute",
          icon: channel.muted ? "sound" : "mute",
          label: t(channel.muted ? "contextMenu.unmuteChannel" : "contextMenu.muteChannel"),
          onPress: () => {
            tapHaptic();
            mute.mutate({ channelId: channel.id, muted: !channel.muted }, { onError: failed });
          },
        },
        ...(leavesChannel(channel)
          ? [
              {
                key: "leave",
                icon: "out" as const,
                label: t("channel.leave"),
                danger: true,
                disabled: leave.isPending,
                onPress: ask,
              },
            ]
          : []),
      ]}
    />
  );
}

/** One member's options: how an agent replies here, and "Tirar do canal" (asked first) for admins. */
function MemberOptions({
  channelId,
  channelName,
  who,
  removable,
}: {
  channelId: string;
  channelName: string;
  who: Who;
  removable: boolean;
}) {
  const { t } = useTranslation();
  const g = agentGrammar(who.name);
  const orgId = useOrgId();
  const api = useApi();
  const sheet = useSheet();
  const toast = useToast();
  const c = useColors();
  const refresh = useRefresh(channelId);
  const routing = useAiStatus(orgId).data?.routing;
  const [autoReply, setAutoReply] = useState(who.autoReply);
  const back = () => sheet.open(<ChannelMembersSheet channelId={channelId} channelName={channelName} />);
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });

  const reply = useMutation({
    mutationFn: (on: boolean) => api.chat.setAutoReply(orgId, channelId, who.id, on),
    onMutate: (on) => setAutoReply(on),
    onSuccess: refresh,
    onError: () => {
      setAutoReply(who.autoReply);
      failed();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api.chat.removeMember(orgId, channelId, who.kind === "agent" ? { agentId: who.id } : { userId: who.id }),
    onSuccess: () => {
      successHaptic();
      refresh();
      back();
    },
    onError: failed,
  });
  const askRemove = () =>
    Alert.alert(
      t("channelMembers.removeTitle", { name: who.name, channel: channelName }),
      t(who.kind === "agent" ? "channelMembers.removeAgentBody" : "channelMembers.removePersonBody", g),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("channelMembers.removeConfirm"), style: "destructive", onPress: () => remove.mutate() },
      ],
    );
  const picked = (on: boolean) =>
    on ? <Icon name="check" size={18} color={c.ink} /> : <View style={styles.checkRoom} />;

  return (
    <>
      <SheetTitle
        leading={
          <OpensAgent agentId={who.id}>
            <Face who={{ type: who.kind, id: who.id }} size={36} live={false} />
          </OpensAgent>
        }
        title={who.name}
        subtitle={lineOf(t, { ...who, autoReply }, routing)}
      />
      {who.kind === "agent" ? (
        <View>
          <Text variant="footnote" tone="faint" style={[styles.bold, styles.heading]}>
            {t("channelMembers.replyHeading", g)}
          </Text>
          <ActionList
            items={[
              {
                key: "alone",
                label: t("channelMembers.replyAlone", g),
                hint: t(replyAloneKey(routing), g),
                trailing: picked(autoReply),
                disabled: reply.isPending,
                onPress: () => !autoReply && reply.mutate(true),
              },
              {
                key: "mention",
                label: t("channelMembers.replyMention"),
                hint: t("channelMembers.replyMentionHelp", { handle: who.handle }),
                trailing: picked(!autoReply),
                disabled: reply.isPending,
                onPress: () => autoReply && reply.mutate(false),
              },
            ]}
          />
        </View>
      ) : null}
      {removable ? (
        <ActionList
          items={[
            {
              key: "remove",
              icon: "x",
              danger: true,
              label: t("channelMembers.remove"),
              disabled: remove.isPending,
              onPress: askRemove,
            },
          ]}
        />
      ) : null}
      <Button variant="ghost" wide label={t("common.back")} onPress={back} />
    </>
  );
}

/** Adds people and agents to the channel: search, tap to pick, "Adicionar N" (as the web's dialog). */
function AddChannelMembers({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const sheet = useSheet();
  const toast = useToast();
  const dir = useDirectory();
  const { org } = useOrg();
  const c = useColors();
  const roster = useRoster(orgId, channelId);
  const refresh = useRefresh(channelId);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const back = () => sheet.open(<ChannelMembersSheet channelId={channelId} channelName={channelName} />);
  const add = useMutation({
    mutationFn: async () => {
      for (const key of selected) {
        const [kind, id = ""] = key.split(":");
        await api.chat.addMember(orgId, channelId, kind === "agent" ? { agentId: id } : { userId: id });
      }
    },
    onSuccess: () => {
      refresh();
      back();
    },
    onError: (error) => {
      refresh();
      toast({ title: errorText(t, error), icon: "x" });
    },
  });
  // Who was in before Adicionar: the ones being added keep their rows until the sheet moves on.
  const inChannel = useHeldWhile(
    new Set((roster.data ?? []).map((m) => `${m.type === "agent" ? "agent" : "person"}:${m.id}`)),
    add.isPending || add.isSuccess,
  );
  const candidates = [
    ...dir.agents
      .filter((a) => listsAgent(org, a) && joinsChannels(a))
      .map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, line: `@${a.handle}` })),
    ...[...dir.memberById.values()].map((m) => ({
      kind: "person" as const,
      id: m.userId,
      name: m.name,
      line: m.email,
    })),
  ].filter((w) => !inChannel.has(`${w.kind}:${w.id}`));
  const needle = q.trim().toLowerCase();
  const rows = candidates.filter((w) => !needle || `${w.name} ${w.line}`.toLowerCase().includes(needle));
  // Someone not in the workspace yet, or an agent still to make: their own screens, the sheet closes for them.
  const leaveFor = (path: string) => () => {
    sheet.close();
    router.push(path as never);
  };
  const elsewhere = [
    ...(can(org, "invite_people")
      ? [
          {
            key: "invite",
            icon: "mail" as const,
            label: t("shell.invite"),
            onPress: leaveFor(`/invite-people?channel=${channelId}`),
          },
        ]
      : []),
    ...(makesAgents(org)
      ? [
          {
            key: "agent",
            icon: "plus" as const,
            label: t("shell.createAgent"),
            onPress: leaveFor(`/new-agent?channel=${channelId}`),
          },
        ]
      : []),
  ];
  const toggle = (key: string) => {
    tapHaptic();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <SheetTitle leading={<Tile icon="plus" />} title={t("channelMembers.addTitle", { channel: channelName })} />
      <SearchField value={q} onChangeText={setQ} placeholder={t("channelMembers.addSearch")} autoCorrect={false} />
      {rows.length === 0 ? (
        <Text variant="body" tone="muted">
          {needle
            ? t("channelMembers.addEmpty", { q: q.trim() })
            : t("channelMembers.addEveryone", { org: org?.name ?? "", channel: channelName })}
        </Text>
      ) : (
        <Locked when={add.isPending}>
          <Card>
            {rows.map((w) => {
              const key = `${w.kind}:${w.id}`;
              const on = selected.has(key);
              return (
                <Row
                  key={key}
                  leading={<Face who={{ type: w.kind, id: w.id }} size={30} live={false} />}
                  title={w.name}
                  subtitle={w.line}
                  meta={<Icon name={on ? "checkc" : "circle"} size={20} color={on ? c.ink : c.faint} />}
                  onPress={() => toggle(key)}
                />
              );
            })}
          </Card>
        </Locked>
      )}
      {elsewhere.length > 0 ? <ActionList items={elsewhere} /> : null}
      <View style={styles.actions}>
        <Button variant="secondary" label={t("common.cancel")} onPress={back} />
        <View style={styles.grow}>
          <Button
            variant="primary"
            wide
            label={t("channelMembers.addConfirm", { count: selected.size })}
            loading={add.isPending}
            disabled={selected.size === 0}
            onPress={() => add.mutate()}
          />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 8 },
  bold: { fontWeight: "600" },
  heading: { paddingHorizontal: 4, paddingTop: 4, paddingBottom: 8 },
  note: { textAlign: "center" },
  checkRoom: { width: 18 },
  actions: { flexDirection: "row", gap: 8, alignItems: "center" },
  grow: { flex: 1 },
});
