import {
  ApiError,
  cachePinned,
  keys,
  type Message,
  type Mission,
  type MissionEligibleAgent,
  type ThreadInfo,
  useApi,
  useChannelCategories,
  useChannels,
  useCloseMission,
  useCreateMission,
  useEligibleAgents,
  useFollowThread,
  useMe,
  useMissionControl,
  usePinMessage,
  usePins,
  useReactions,
  useThreadInfo,
  useThreadMutation,
  useToggleReaction,
} from "@agenteschat/client";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { summaryParts } from "@agenteschat/client/lib/missions";
import { voiceOf } from "@agenteschat/client/lib/voice";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { chartBlocksOf } from "@agenteschat/ui/widgets/spec";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { Button, CHROME_MAX_SCALE, Count, Icon, Locked, OPTION_ROW, PressScale, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useMovesChannel } from "../categories/CategoryScreens";
import { categoryHrefs } from "../categories/logic";
import { setPinDraft } from "../dashboards/logic";
import { chatHref } from "../links/logic";
import { missionComputerText } from "../missions/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useEdition, useMeId, useNamesComputers, useOrgId } from "../shared/hooks";
import { genderOf, previewOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { type ActionItem, ActionList, copyText, successHaptic, Tile, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";

import { QUICK_REACTIONS, reactionName, reactionPills } from "./logic";
import type { MenuSymbol } from "./MessageMenu";

// ── Long press on a message ──────────────────────────────────────────────────

/** What a message's menu is about, beyond the message: what the screen can do with it. */
export interface MessageActionsContext {
  message: Message;
  /** "Transformar em missão" is offered (a channel or a DM, not a mission thread). */
  canMission: boolean;
  /** The screen is the thread view (no "Responder em thread"). */
  inThread: boolean;
  thread: ThreadInfo | undefined;
  onMission: (goal: string, threadId: string) => void;
  /** "Lembrar disso": the screen opens the reminder sheet for this message. */
  onRemind: (m: Message) => void;
  /** "Responder": the next message answers this one, in the conversation (a quote). Absent where nothing can be written. */
  onReply?: ((m: Message) => void) | undefined;
}

/** One action of a message's menu: the sheet's row, with the system's symbol for the native menu. */
export interface MessageAction extends ActionItem {
  symbol?: MenuSymbol;
}

/**
 * A message's actions, one list for the system's menu (iOS, on hold) and the app's sheet (Android): the quick
 * reactions, then the actions in groups, as the hand expects them: answer (here, in a thread), keep (copy, pin,
 * remind, a mission), and the rest (its link, a chart to a dashboard, the agent who wrote it). `close` runs before
 * an action that opens something else (the sheet closes; the system's menu closes itself).
 */
export function useMessageActions(context: MessageActionsContext, close: () => void) {
  const { message: m, canMission, inThread, thread, onMission, onRemind, onReply } = context;
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const qc = useQueryClient();
  const cached = useReactions(orgId, m.id, false);
  const toggle = useToggleReaction(orgId, m.id);
  const pin = usePinMessage(orgId);
  const pinned = Boolean(m.pinned);
  const togglePin = () => {
    close();
    const next = !pinned;
    // The mark shows at once; the server's answer (or its event) confirms it.
    cachePinned(qc, orgId, m.channelId, m.id, next);
    pin.mutate(
      { channelId: m.channelId, messageId: m.id, pinned: next },
      {
        onSuccess: () => toast({ title: t(next ? "mobile.pins.pinned" : "mobile.pins.unpinned"), icon: "pin" }),
        onError: (e) => {
          cachePinned(qc, orgId, m.channelId, m.id, pinned);
          const full = e instanceof ApiError && e.code === "pins.limit";
          toast({ title: t(full ? "mobile.pins.full" : "mobile.app.failed"), icon: "x" });
        },
      },
    );
  };
  const pills = reactionPills(cached.data ?? m.reactions, meId);
  const agentName = m.author.type === "agent" ? dir.nameOf(m.author) : "";
  const rootId = m.threadId ?? m.id;
  // A voice message is its audio: no words to preview or copy here.
  const text = voiceOf(m.meta) ? "" : previewOf(m.body);
  // An agent's charts can be pinned to a dashboard as widgets (ADR 0135).
  const charts = m.local || m.author.type !== "agent" ? [] : chartBlocksOf(m.body);
  const pinChart = () => {
    close();
    setPinDraft({ messageId: m.id, agentId: m.author.id ?? "", blocks: charts });
    router.push("/widget-pin");
  };
  const react = (emoji: string) => {
    tapHaptic();
    const reaction = reactionName(emoji);
    const mine = pills.find((p) => p.reaction === reaction)?.mine ?? false;
    toggle.mutate({ reaction, on: !mine });
    close();
  };
  const copied = (ok: boolean, title: string) =>
    toast(ok ? { title, icon: "copy" } : { title: t("mobile.app.failed"), icon: "x" });
  const answer: MessageAction[] = [
    ...(!m.local && onReply
      ? [
          {
            key: "reply",
            icon: "replyTo" as const,
            symbol: "arrowshape.turn.up.left" as const,
            label: t("channel.reply"),
            onPress: () => {
              close();
              onReply(m);
            },
          },
        ]
      : []),
    ...(!inThread && !m.local
      ? [
          {
            key: "thread",
            icon: "reply" as const,
            symbol: "bubble.left.and.bubble.right" as const,
            label: thread ? t("mobile.chat.openThread") : t("mobile.chat.replyInThread"),
            onPress: () => {
              close();
              router.push(chatHref(m.channelId, rootId));
            },
          },
        ]
      : []),
  ];
  const keep: MessageAction[] = [
    ...(text
      ? [
          {
            key: "copy",
            icon: "copy" as const,
            symbol: "doc.on.doc" as const,
            label: t("mobile.chat.copy"),
            onPress: () => {
              close();
              void copyText(m.body).then((ok) => copied(ok, t("mobile.chat.copied")));
            },
          },
        ]
      : []),
    ...(!m.local
      ? [
          {
            key: "pin",
            icon: "pin" as const,
            symbol: (pinned ? "pin.slash" : "pin") as MenuSymbol,
            label: pinned ? t("mobile.pins.unpin") : t("mobile.pins.pin"),
            onPress: togglePin,
          },
          {
            key: "remind",
            icon: "clock" as const,
            symbol: "clock" as const,
            label: t("mobile.remind.aboutThis"),
            // The reminder's sheet takes this one's place (no close in between).
            onPress: () => onRemind(m),
          },
        ]
      : []),
    ...(canMission && !m.local
      ? [
          {
            key: "mission",
            icon: "target" as const,
            symbol: "target" as const,
            label: t("mobile.chat.toMission"),
            onPress: () => onMission(text, rootId),
          },
        ]
      : []),
  ];
  const rest: MessageAction[] = [
    ...(!m.local
      ? [
          {
            key: "link",
            icon: "link" as const,
            symbol: "link" as const,
            label: t("messageRefs.copy"),
            onPress: () => {
              close();
              void copyText(`${serverUrl()}${messagePath(orgId, m)}`).then((ok) =>
                copied(ok, t("contextMenu.linkCopied")),
              );
            },
          },
        ]
      : []),
    ...(charts.length > 0 && m.author.id
      ? [
          {
            key: "dashboard",
            icon: "chart" as const,
            symbol: "chart.bar" as const,
            label: t("widgets.pin.label"),
            onPress: pinChart,
          },
        ]
      : []),
    ...(m.author.type === "agent" && m.author.id
      ? [
          {
            key: "agent",
            leading: <AgentFace agentId={m.author.id} size={20} live={false} />,
            symbol: "person.crop.square" as const,
            label: t("mobile.chat.seeAgent", { name: agentName }),
            onPress: () => {
              close();
              router.push(`/agent/${m.author.id}`);
            },
          },
        ]
      : []),
  ];
  const groups = [answer, keep, rest].filter((g) => g.length > 0);
  return { text, react, groups };
}

/**
 * Holding a message where the platform has no menu of its own (Android): the app's sheet, in the menu's order. The
 * reactions first (the hand already knows), the message under them, then the actions in their groups.
 */
export function MessageActions(props: MessageActionsContext) {
  const { message: m } = props;
  const { t } = useTranslation();
  const surface = useSurface();
  const sheet = useSheet();
  const { text, react, groups } = useMessageActions(props, sheet.close);
  return (
    <>
      {m.local ? null : (
        <View style={[styles.emorow, surface]}>
          {QUICK_REACTIONS.map((e) => (
            <Pressable
              key={e}
              onPress={() => react(e)}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.chat.reactWith", { emoji: e })}
              style={({ pressed }) => [styles.emo, pressed && styles.emoPressed]}
            >
              <Text maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.emoText}>
                {e}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={[styles.preview, surface]}>
        <Face who={m.author} size={24} live={false} />
        <Text variant="small" tone="ink2" numberOfLines={3} style={styles.grow}>
          {text || previewOf(textOrMedia(t, m.body, m.meta)) || t("mobile.chat.approvalPreview")}
        </Text>
      </View>
      <View style={styles.groups}>
        {groups.map((g) => (
          <ActionList key={g[0]?.key ?? ""} items={g} />
        ))}
      </View>
    </>
  );
}

// ── "+" in the composer ──────────────────────────────────────────────────────

export type PlusPick = "camera" | "photos" | "file" | "media" | "mission" | "summary" | "remind";

/**
 * The "+" of the chat: what goes with a message as tiles (camera, photos, file and, where they can be sent, the
 * GIFs and stickers, so the field itself only sends), then what to start here, in words.
 */
export function PlusActions({ onPick, media = false }: { onPick: (pick: PlusPick) => void; media?: boolean }) {
  const { t } = useTranslation();
  const surface = useSurface();
  const tiles: { key: PlusPick; icon: "camera" | "image" | "file" | "sticker"; label: string }[] = [
    { key: "camera", icon: "camera", label: t("mobile.plus.camera") },
    { key: "photos", icon: "image", label: t("mobile.plus.photos") },
    { key: "file", icon: "file", label: t("mobile.plus.file") },
    ...(media ? [{ key: "media" as const, icon: "sticker" as const, label: t("mobile.plus.media") }] : []),
  ];
  return (
    <>
      <View style={styles.tiles}>
        {tiles.map((x) => (
          <PressScale
            key={x.key}
            onPress={() => onPick(x.key)}
            accessibilityRole="button"
            accessibilityLabel={x.label}
            style={styles.tileBtn}
            contentStyle={styles.tileIn}
          >
            <View style={[styles.bigTile, surface]}>
              <Icon name={x.icon} size={24} />
            </View>
            <Text variant="caption" tone="ink2" style={styles.bold}>
              {x.label}
            </Text>
          </PressScale>
        ))}
      </View>
      <ActionList
        items={[
          {
            key: "mission",
            icon: "target",
            label: t("mobile.plus.mission"),
            hint: t("mobile.plus.missionHint"),
            onPress: () => onPick("mission"),
          },
          {
            key: "summary",
            icon: "sparkle",
            label: t("mobile.plus.summary"),
            hint: t("mobile.plus.summaryHint"),
            onPress: () => onPick("summary"),
          },
          {
            key: "remind",
            icon: "clock",
            label: t("mobile.plus.remind"),
            hint: t("mobile.plus.remindHint"),
            onPress: () => onPick("remind"),
          },
        ]}
      />
    </>
  );
}

// ── ⋯ of a thread or a mission ───────────────────────────────────────────────

export function ThreadOptions({
  thread,
  mission,
  onMission,
  onPins,
}: {
  thread: ThreadInfo;
  mission: Mission | null;
  /** "Transformar em missão" (a plain thread). */
  onMission?: () => void;
  /** "Fixadas" of the conversation. */
  onPins?: () => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const sheet = useSheet();
  const qc = useQueryClient();
  const mutate = useThreadMutation(orgId);
  const follow = useFollowThread(orgId);
  // The sheet keeps the thread it opened with: "Seguir" reads the live view.
  const live = useThreadInfo(orgId, thread.id);
  const following = Boolean(live.data?.following ?? thread.following);
  const setFollowing = (next: boolean) => {
    const key = keys.threadInfo(orgId, thread.id);
    const put = (value: boolean) =>
      qc.setQueryData<ThreadInfo>(key, (cur) => (cur ? { ...cur, following: value } : cur));
    put(next);
    follow.mutate(
      { threadId: thread.id, following: next },
      {
        onError: () => {
          put(!next);
          fail();
        },
      },
    );
  };
  const control = useMissionControl(orgId);
  const close = useCloseMission(orgId);
  // A thread on a GIF or a sticker has no words of its own to title it (ADR 0091).
  const title = thread.title?.trim() || previewOf(thread.rootText) || t("mobile.chat.thread");
  const name = mission ? (dir.agentById.get(mission.agentId)?.name ?? "") : "";
  const g = genderOf(name);
  const fail = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const act = (action: "close" | "reopen" | "archive") =>
    mutate.mutate(
      { type: "action", thread, action },
      {
        onSuccess: () => {
          sheet.close();
          toast({
            title: t(`mobile.thread.done.${action}`),
            ...(action === "close" ? { subtitle: t("mobile.thread.done.closeSub") } : {}),
            icon: action === "archive" ? "archive" : "check",
          });
          if (action !== "reopen" && router.canGoBack()) router.back();
        },
        onError: fail,
      },
    );
  const open =
    mission &&
    (mission.status === "active" ||
      mission.status === "paused" ||
      mission.status === "proposed" ||
      mission.status === "awaiting_close");
  return (
    <>
      <SheetTitle
        leading={<Tile icon={mission ? "target" : "reply"} />}
        title={title}
        subtitle={
          mission
            ? t("mobile.thread.missionIn", { channel: thread.channelName })
            : t("mobile.thread.threadIn", { channel: thread.channelName })
        }
      />
      <ActionList
        items={[
          {
            key: "follow",
            icon: "bell" as const,
            label: t("mobile.thread.follow"),
            hint: t("mobile.thread.followHint"),
            checked: following,
            onPress: () => setFollowing(!following),
          },
          ...(onPins ? [{ key: "pins", icon: "pin" as const, label: t("mobile.pins.title"), onPress: onPins }] : []),
          ...(mission
            ? [
                {
                  key: "plan",
                  icon: "list" as const,
                  label: t("mobile.thread.seePlan"),
                  onPress: () => {
                    sheet.close();
                    router.push(`/mission/${mission.id}`);
                  },
                },
                ...(mission.canAct && mission.status === "active"
                  ? [
                      {
                        key: "pause",
                        icon: "pause" as const,
                        label: t("mobile.thread.pause"),
                        hint: t(`mobile.thread.pauseHint${g}`, { name }),
                        onPress: () =>
                          control.mutate(
                            { missionId: mission.id, action: "pause" },
                            {
                              onSuccess: () => {
                                sheet.close();
                                toast({ title: t("mobile.thread.done.paused"), agentId: mission.agentId });
                              },
                              onError: fail,
                            },
                          ),
                      },
                    ]
                  : []),
                ...(mission.canAct && mission.status === "paused"
                  ? [
                      {
                        key: "resume",
                        icon: "sparkle" as const,
                        label: t("mobile.thread.resume"),
                        onPress: () =>
                          control.mutate(
                            { missionId: mission.id, action: "resume" },
                            {
                              onSuccess: () => {
                                sheet.close();
                                toast({ title: t("mobile.thread.done.resumed"), agentId: mission.agentId });
                              },
                              onError: fail,
                            },
                          ),
                      },
                    ]
                  : []),
              ]
            : onMission
              ? [
                  {
                    key: "mission",
                    icon: "target" as const,
                    label: t("mobile.chat.toMission"),
                    hint: t("mobile.thread.toMissionHint"),
                    onPress: onMission,
                  },
                ]
              : []),
        ]}
      />
      <ActionList
        items={[
          ...(mission
            ? mission.canManage && open
              ? [
                  {
                    key: "done",
                    icon: "check" as const,
                    label: t("mobile.thread.conclude"),
                    hint: t("mobile.thread.concludeHint"),
                    onPress: () =>
                      close.mutate(
                        { missionId: mission.id, outcome: "done", saveToWiki: true },
                        {
                          onSuccess: () => {
                            sheet.close();
                            successHaptic();
                            toast({ title: t("mobile.thread.done.concluded"), agentId: mission.agentId });
                          },
                          onError: fail,
                        },
                      ),
                  },
                ]
              : []
            : thread.canManage
              ? [
                  thread.state === "closed"
                    ? {
                        key: "reopen",
                        icon: "reply" as const,
                        label: t("mobile.thread.reopen"),
                        onPress: () => act("reopen"),
                      }
                    : {
                        key: "close",
                        icon: "check" as const,
                        label: t("mobile.thread.close"),
                        hint: t("mobile.thread.closeHint"),
                        onPress: () => act("close"),
                      },
                ]
              : []),
          ...(thread.canManage
            ? [
                {
                  key: "archive",
                  icon: "archive" as const,
                  label: t("mobile.thread.archive"),
                  hint: t("mobile.thread.archiveHint"),
                  onPress: () => act("archive"),
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

// ── ⋯ of a channel or a DM ───────────────────────────────────────────────────

export function ChannelOptions({
  channelId,
  title,
  subtitle,
  leading,
  agentId,
  about,
  onPins,
  onMembers,
  onSearch,
}: {
  channelId: string;
  title: string;
  subtitle?: string;
  leading: ReactNode;
  /** An agent's DM: "Perfil". */
  agentId?: string | null;
  /** Under the title: a person's status in a DM with them (ADR 0084). */
  about?: ReactNode;
  onPins: () => void;
  /** A channel: who is in it (and, for admins, adding and removing). */
  onMembers?: (() => void) | undefined;
  /** A DM: searching it (its header keeps the room for the name and the agent's own buttons). */
  onSearch?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const pins = usePins(orgId, channelId);
  const count = pins.data?.length ?? 0;
  // A channel's sidebar category (ADR 0080), for whoever may move it.
  const moves = useMovesChannel(channelId);
  const channel = useChannels(orgId).data?.find((c) => c.id === channelId);
  const categories = useChannelCategories(orgId);
  const categoryName = channel?.categoryId
    ? categories.data?.find((c) => c.id === channel.categoryId)?.name
    : undefined;
  return (
    <>
      <SheetTitle leading={leading} title={title} {...(subtitle ? { subtitle } : {})} />
      {about}
      <ActionList
        items={[
          ...(onSearch
            ? [{ key: "search", icon: "search" as const, label: t("searchPage.searchHere"), onPress: onSearch }]
            : []),
          ...(onMembers
            ? [{ key: "members", icon: "members" as const, label: t("shell.members"), onPress: onMembers }]
            : []),
          {
            key: "pins",
            icon: "pin",
            label: t("mobile.pins.title"),
            ...(pins.isSuccess && count === 0 ? { hint: t("mobile.pins.none") } : {}),
            ...(count > 0 ? { trailing: <Count value={count} max={99} /> } : {}),
            onPress: onPins,
          },
          ...(onMembers && moves
            ? [
                {
                  key: "category",
                  icon: "list" as const,
                  label: t("channelCategories.category"),
                  hint: categoryName ?? t("channelCategories.noCategory"),
                  onPress: () => {
                    sheet.close();
                    router.push(categoryHrefs.pick(channelId));
                  },
                },
              ]
            : []),
          ...(agentId
            ? [
                {
                  key: "profile",
                  leading: <AgentFace agentId={agentId} size={20} live={false} />,
                  label: t("mobile.chat.profile"),
                  onPress: () => {
                    sheet.close();
                    router.push(`/agent/${agentId}`);
                  },
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

// ── Nova missão ──────────────────────────────────────────────────────────────

/**
 * "Começar uma missão" / "Transformar em missão": the goal, who does it (the
 * agents that can run one for you) and where; the agent makes a plan and
 * waits for "Começar".
 */
export function NewMissionForm({
  goal: initialGoal = "",
  channelId,
  threadId,
  preferredAgentId,
  currentThreadId,
}: {
  goal?: string;
  channelId: string;
  /** The thread that becomes its home (else a new thread in the channel). */
  threadId?: string | null;
  preferredAgentId?: string | null;
  /** The thread on screen: no navigation when the mission lives there. */
  currentThreadId?: string | null;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const eligible = useEligibleAgents(orgId);
  // On the Cloud missions wait for the workspace's own computer: nobody connects one.
  const waitCloud = useCloudMissionWait();
  const cloud = useEdition() === "cloud";
  const names = useNamesComputers();
  const create = useCreateMission(orgId);
  const [goal, setGoal] = useState(initialGoal);
  const [picked, setPicked] = useState<string | null>(null);
  const list = eligible.data ?? [];
  const usable = list.filter((a) => a.eligible !== false);
  const agentId =
    picked ??
    (preferredAgentId && usable.some((a) => a.agentId === preferredAgentId) ? preferredAgentId : null) ??
    usable[0]?.agentId ??
    null;
  const agent = list.find((a) => a.agentId === agentId);
  const submit = () => {
    if (!agentId || !goal.trim() || create.isPending) return;
    create.mutate(
      { agentId, goal: goal.trim(), ...(threadId ? { threadId } : { channelId }) },
      {
        onSuccess: (mission) => {
          sheet.close();
          successHaptic();
          toast({ title: t("mobile.newMission.created", { name: agent?.name ?? "" }), agentId: mission.agentId });
          if (mission.threadId !== currentThreadId) router.push(chatHref(mission.channelId, mission.threadId));
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  };
  return (
    <>
      <SheetTitle leading={<Tile icon="target" />} title={t("mobile.newMission.title")} />
      <Text variant="body" tone="muted">
        {t("mobile.newMission.intro")}
      </Text>
      <Locked when={create.isPending}>
        <TextArea
          value={goal}
          onChangeText={setGoal}
          placeholder={t("mobile.newMission.placeholder")}
          accessibilityLabel={t("mobile.newMission.placeholder")}
          autoFocus={!initialGoal}
        />
      </Locked>
      {eligible.isLoading ? <ActivityIndicator color={c.muted} /> : null}
      {list.length > 0 ? (
        <Locked when={create.isPending}>
          <ActionList
            items={[
              ...list.map((a) => ({
                key: a.agentId,
                leading: <AgentFace agentId={a.agentId} size={OPTION_ROW.face} live={false} />,
                label: a.name,
                hint: (waitCloud && !a.machine ? waitCloud : whereText(t, a, { cloud, names })) ?? undefined,
                disabled: a.eligible === false,
                trailing: a.agentId === agentId ? <Icon name="check" size={18} color={c.ink} /> : undefined,
                onPress: a.eligible === false ? undefined : () => setPicked(a.agentId),
              })),
            ]}
          />
        </Locked>
      ) : eligible.isSuccess ? (
        <Text variant="small" tone="muted">
          {waitCloud ?? t("mobile.newMission.noAgents")}
        </Text>
      ) : null}
      <Button
        variant="primary"
        wide
        icon="sparkle"
        label={t("mobile.newMission.submit")}
        loading={create.isPending}
        disabled={!agentId || !goal.trim()}
        onPress={submit}
      />
    </>
  );
}

/**
 * "Missions start once Acme's computer is ready." on the Cloud (a personal workspace's: once your agents' computer is,
 * ADR 0159); null elsewhere.
 */
function useCloudMissionWait() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const org = useMe().data?.organizations.find((o) => o.id === orgId);
  if (useEdition() !== "cloud") return null;
  return t("missions.waitingCloud", {
    computer: t(modeKey(org, "computerSetup.titleInSentence"), { org: org?.name ?? "" }),
  });
}

/**
 * "MacBook do Walter · ligado" (`missionComputerText`: by name only where the workspace has more than one), or why
 * it can't do a mission for you; the Cloud's computer is never off.
 */
function whereText(t: TFunction, a: MissionEligibleAgent, where: { cloud: boolean; names: boolean }) {
  if (a.eligible === false && a.reason) return t(`mobile.newMission.reason.${a.reason}`);
  if (!a.machine) return t("mobile.newMission.reason.no_computer");
  return missionComputerText(t, a.machine, where);
}

// ── /summary of a mission ────────────────────────────────────────────────────

/** Where the mission stands (only for me), in the web card's lines: the server's `text` is English. */
export function MissionSummaryView({ missionId }: { missionId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const c = useColors();
  const summary = useQuery({
    queryKey: keys.missionPart(orgId, missionId, "summary"),
    queryFn: () => api.missions.summary(orgId, missionId),
    staleTime: 0,
  });
  return (
    <>
      <SheetTitle leading={<Tile icon="sparkle" />} title={t("mobile.plus.summary")} />
      {summary.isError ? (
        <Text tone="muted">{t("mobile.app.failed")}</Text>
      ) : !summary.data ? (
        <ActivityIndicator color={c.muted} />
      ) : (
        <Text variant="body" tone="ink2">
          {summaryParts(summary.data)
            .map((p) => t(`missions.summary.${p.key}`, { count: p.count, total: p.total ?? 0 }))
            .join("\n")}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  bold: { fontWeight: "600" },
  preview: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 14 },
  emorow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  emo: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  emoPressed: { transform: [{ scale: 1.15 }] },
  emoText: { fontSize: 26, lineHeight: 34 },
  // The action groups, divided as the menu divides them.
  groups: { gap: 12 },
  tiles: { flexDirection: "row", justifyContent: "space-between" },
  tileBtn: { flex: 1 },
  tileIn: { alignItems: "center", gap: 8, paddingVertical: 6 },
  bigTile: { width: 54, height: 54, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
